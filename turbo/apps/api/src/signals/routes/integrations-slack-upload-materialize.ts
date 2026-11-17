import { command } from "ccstate";
import { integrationsSlackUploadMaterializeContract } from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { materializeCanonicalPublishedAsset$ } from "../services/canonical-asset.service";
import {
  prepareCanonicalSlackDelivery$,
  deliverCanonicalSlackAsset$,
} from "../services/canonical-slack-asset-delivery.service";
import type { RouteEntry } from "../route-entry";

const materializeInner$ = command(
  async ({ get, set }, transfer: "client" | "server", signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const runId =
      "runId" in auth && typeof auth.runId === "string"
        ? auth.runId
        : undefined;
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
      transfer === "server"
        ? deliverCanonicalSlackAsset$
        : prepareCanonicalSlackDelivery$,
      {
        assetId: materialized.assetId,
        operationId: bodyResult.data.operationId,
        runId,
        userId: auth.userId,
        orgId: auth.orgId,
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
  },
);

const clientMaterialize$ = command(({ set }, signal: AbortSignal) => {
  return set(materializeInner$, "client", signal);
});
const serverDeliver$ = command(async ({ set }, signal: AbortSignal) => {
  const response = await set(materializeInner$, "server", signal);
  if (response.status !== 200) {
    return response;
  }
  const delivery = response.body.delivery;
  if (delivery.status === "pending") {
    throw new Error(
      "Server Slack delivery returned a client upload capability",
    );
  }
  return { ...response, body: { ...response.body, delivery } };
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
  {
    route: integrationsSlackUploadMaterializeContract.materialize,
    handler: authRoute(slackWriteAuth, clientMaterialize$),
  },
];
