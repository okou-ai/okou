import { command } from "ccstate";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";
import { resourceUnavailable } from "../../lib/error";
import {
  artifactChangedTopic,
  type ArtifactChangedPayload,
} from "@okouai/api-contracts/contracts/realtime";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { publishUserSignal } from "../external/realtime";
import {
  syncArtifactToGoogleDrive$,
  type SyncArtifactArgs,
} from "../services/google-drive-artifact-sync.service";
import type { RouteEntry } from "../route-entry";

const uploadAndNotify$ = command(
  async ({ set }, args: SyncArtifactArgs, signal: AbortSignal) => {
    const result = await set(syncArtifactToGoogleDrive$, args, signal);
    if (result.status === 200) {
      await publishUserSignal([args.userId], artifactChangedTopic, {
        artifactId: args.artifactId,
      } satisfies ArtifactChangedPayload);
    }
    return result;
  },
);

function uploadArtifactHandler(
  route:
    | typeof artifactGoogleDriveContract.upload
    | typeof artifactGoogleDriveContract.uploadWithMode,
) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const { artifactId } = get(pathParamsOf(route));
    const body = await get(bodyResultOf(route));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    return await set(
      uploadAndNotify$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        artifactId,
        ...body.data,
        ...(auth.tokenType === "agent"
          ? {
              authorizedRunId: auth.runId,
              ...(auth.builtinConnectorSourceIds?.["google-drive"]
                ? {
                    connectionId:
                      auth.builtinConnectorSourceIds["google-drive"],
                  }
                : {}),
            }
          : {}),
      },
      signal,
    );
  });
}

const uploadFromChatInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const route = artifactGoogleDriveContract.uploadFromChat;
    const auth = get(organizationAuthContext$);
    const { artifactId } = get(pathParamsOf(route));
    const body = await get(bodyResultOf(route));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const args = {
      orgId: auth.orgId,
      userId: auth.userId,
      artifactId,
      ...body.data,
    };
    if (auth.tokenType !== "agent") {
      return await set(uploadAndNotify$, args, signal);
    }
    if (!auth.capabilities.includes("connector-account:switch")) {
      return resourceUnavailable("Google Drive is unavailable for this Run");
    }
    return await set(uploadAndNotify$, { ...args, runId: auth.runId }, signal);
  },
);

export const chatThreadsArtifactsSyncRoutes: readonly RouteEntry[] = [
  {
    route: artifactGoogleDriveContract.upload,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "file:write",
        accept: ["session", "pat", "agent"],
      },
      uploadArtifactHandler(artifactGoogleDriveContract.upload),
    ),
  },
  {
    route: artifactGoogleDriveContract.uploadWithMode,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "file:write",
        accept: ["session", "pat", "agent"],
      },
      uploadArtifactHandler(artifactGoogleDriveContract.uploadWithMode),
    ),
  },
  {
    route: artifactGoogleDriveContract.uploadFromChat,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "file:write",
        accept: ["session", "pat", "agent"],
      },
      uploadFromChatInner$,
    ),
  },
];
