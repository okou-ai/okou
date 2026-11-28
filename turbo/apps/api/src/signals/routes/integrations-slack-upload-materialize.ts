import { command } from "ccstate";
import { integrationsSlackUploadMaterializeContract } from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { deliverCanonicalSlackAsset$ } from "../services/canonical-slack-asset-delivery.service";

const serverDeliver$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const runId =
    "runId" in auth && typeof auth.runId === "string" ? auth.runId : undefined;
  if (!runId) {
    return {
      status: 400 as const,
      body: {
        error: {
          message: "Canonical Slack publication requires a run-scoped token",
          code: "BAD_REQUEST",
        },
      },
    };
  }

  const bodyResult = await get(
    bodyResultOf(integrationsSlackUploadMaterializeContract.deliver),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    deliverCanonicalSlackAsset$,
    {
      assetId: bodyResult.data.assetId,
      channel: bodyResult.data.channel,
      user: bodyResult.data.user,
      threadTs: bodyResult.data.threadTs,
      title: bodyResult.data.title,
      initialComment: bodyResult.data.initialComment,
      runId,
      userId: auth.userId,
      orgId: auth.orgId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (!result.ok) {
    return {
      status: result.status,
      body: {
        error: {
          message: result.message,
          code: result.code,
        },
      },
    };
  }

  return {
    status: 200 as const,
    body: {
      assetId: result.assetId,
      url: result.url,
      delivery: result.delivery,
    },
  };
});

const slackWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "slack:write",
} as const;

export const integrationsSlackUploadMaterializeRoutes: readonly RouteEntry[] = [
  {
    route: integrationsSlackUploadMaterializeContract.deliver,
    handler: authRoute(slackWriteAuth, serverDeliver$),
  },
];
