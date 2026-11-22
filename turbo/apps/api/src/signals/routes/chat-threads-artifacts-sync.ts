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
import { syncArtifactToGoogleDrive$ } from "../services/google-drive-artifact-sync.service";
import type { RouteEntry } from "../route-entry";

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
    const runAuth = auth.tokenType === "agent" ? auth : undefined;
    if (runAuth && !runAuth.capabilities.includes("connector-account:switch")) {
      return resourceUnavailable("Google Drive is unavailable for this Run");
    }
    const result = await set(
      syncArtifactToGoogleDrive$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        artifactId,
        ...body.data,
        ...(runAuth ? { runId: runAuth.runId } : {}),
      },
      signal,
    );
    if (result.status === 200) {
      await publishUserSignal([auth.userId], artifactChangedTopic, {
        artifactId,
      } satisfies ArtifactChangedPayload);
    }
    return result;
  },
);

export const chatThreadsArtifactsSyncRoutes: readonly RouteEntry[] = [
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
