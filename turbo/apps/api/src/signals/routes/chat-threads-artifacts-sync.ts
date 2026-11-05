import { command } from "ccstate";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";
import {
  artifactChangedTopic,
  type ArtifactChangedPayload,
} from "@okouai/api-contracts/contracts/realtime";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { publishUserSignal } from "../external/realtime";
import { syncArtifactToGoogleDrive$ } from "../services/google-drive-artifact-sync.service";
import type { RouteEntry } from "../route-entry";

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
    const result = await set(
      syncArtifactToGoogleDrive$,
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
    if (result.status === 200) {
      // Open catalogs and artifact details re-read the synced Drive state.
      await publishUserSignal([auth.userId], artifactChangedTopic, {
        artifactId,
      } satisfies ArtifactChangedPayload);
    }
    return result;
  });
}

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
];
