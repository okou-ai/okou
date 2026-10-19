import { command } from "ccstate";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
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
