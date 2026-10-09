import { command } from "ccstate";
import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { isBadRequestResponse, isNotFoundResponse } from "../../lib/error";
import { syncArtifactToGoogleDrive$ } from "../services/google-drive-artifact-sync.service";
import type { RouteEntry } from "../route-entry";

const syncInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadArtifactsContract.syncGoogleDrive));
  signal.throwIfAborted();
  const bodyResult = await get(
    bodyResultOf(chatThreadArtifactsContract.syncGoogleDrive),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    syncArtifactToGoogleDrive$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      threadId: params.threadId,
      runId: bodyResult.data.runId,
      fileId: bodyResult.data.fileId,
    },
    signal,
  );
  signal.throwIfAborted();

  if (isNotFoundResponse(result)) {
    return result;
  }
  if (isBadRequestResponse(result)) {
    return result;
  }
  return result;
});

const uploadArtifactInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const { artifactId } = get(
      pathParamsOf(artifactGoogleDriveContract.upload),
    );
    const body = await get(bodyResultOf(artifactGoogleDriveContract.upload));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    return await set(
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
      uploadArtifactInner$,
    ),
  },
  {
    route: chatThreadArtifactsContract.syncGoogleDrive,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "file:write",
        accept: ["session", "pat", "agent"],
      },
      syncInner$,
    ),
  },
];
