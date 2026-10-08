import { command } from "ccstate";
import { integrationsSlackUploadMaterializeContract } from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { createSlackClient } from "../external/slack-message-client";
import { materializeCanonicalPublishedAsset$ } from "../services/canonical-asset.service";
import { prepareCanonicalSlackDelivery$ } from "../services/canonical-slack-asset-delivery.service";
import { slackOrgInstallation } from "../services/slack-data.service";
import type { RouteEntry } from "../route-entry";

const noInstallation = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "No Slack installation found for this organization",
      code: "NOT_FOUND",
    }),
  }),
});

const materializeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
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
    bodyResultOf(integrationsSlackUploadMaterializeContract.materialize),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const installation = await get(
    slackOrgInstallation({ orgId: auth.orgId, userId: auth.userId }),
  );
  signal.throwIfAborted();
  if (!installation) {
    return noInstallation;
  }

  const materialized = await set(
    materializeCanonicalPublishedAsset$,
    {
      assetId: bodyResult.data.assetId,
      operationId: bodyResult.data.operationId,
      runId,
      userId: auth.userId,
      orgId: auth.orgId,
    },
    signal,
  );
  if (!materialized.ok) {
    return {
      status:
        materialized.code === "NOT_FOUND" ? (404 as const) : (400 as const),
      body: {
        error: {
          message: materialized.message,
          code: materialized.code,
        },
      },
    };
  }

  const delivery = await set(
    prepareCanonicalSlackDelivery$,
    {
      assetId: materialized.assetId,
      operationId: bodyResult.data.operationId,
      runId,
      userId: auth.userId,
      client: createSlackClient(installation.botToken),
    },
    signal,
  );
  if (!delivery) {
    return {
      status: 404 as const,
      body: {
        error: {
          message: "Canonical Slack delivery was not found",
          code: "NOT_FOUND",
        },
      },
    };
  }

  return {
    status: 200 as const,
    body: {
      assetId: materialized.assetId,
      url: materialized.url,
      delivery,
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
    route: integrationsSlackUploadMaterializeContract.materialize,
    handler: authRoute(slackWriteAuth, materializeInner$),
  },
];
