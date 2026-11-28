import { command } from "ccstate";
import { integrationsTeamsUploadCompleteContract } from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { completeCanonicalTeamsUpload$ } from "../services/canonical-teams-asset-delivery.service";

const complete$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(
    bodyResultOf(integrationsTeamsUploadCompleteContract.complete),
  );
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return await set(
    completeCanonicalTeamsUpload$,
    {
      assetId: body.data.uploadId,
      conversationId: body.data.conversationId,
      user: body.data.user,
      activityId: body.data.activityId,
      contentType: body.data.contentType,
      text: body.data.text,
      runId: "runId" in auth ? (auth.runId ?? null) : null,
      userId: auth.userId,
      orgId: auth.orgId,
    },
    signal,
  );
});

export const integrationsTeamsUploadCompleteRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTeamsUploadCompleteContract.complete,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "teams:write",
      },
      complete$,
    ),
  },
];
