import { resolveTeamsWriteTarget$ } from "../services/teams-write-access.service";
import { command } from "ccstate";
import { integrationsTeamsMessageContract } from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
import { sendTeamsMessage } from "../external/teams-bot-client";
import { teamsErrorResponse } from "../services/teams-message-target.service";
import type { RouteEntry } from "../route-entry";
import { resolveTeamsMessageSendPresentation$ } from "../services/integration-message-send-presentation.service";
import { appendTeamsCardFooter } from "../../lib/integration-message-card-footer";
import { appendIntegrationMessageFooter } from "../../lib/integration-message-footer";

const sendMessageInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(
    bodyResultOf(integrationsTeamsMessageContract.sendMessage),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  get(db$);
  const target = await set(
    resolveTeamsWriteTarget$,
    {
      runId: "runId" in auth ? auth.runId : undefined,
      userId: auth.userId,
      orgId: auth.orgId,
      body,
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in target) {
    return target;
  }
  const { installation } = target;
  const presentation = await set(
    resolveTeamsMessageSendPresentation$,
    installation.teamsTenantId,
    signal,
  );

  const result = await sendTeamsMessage(
    {
      serviceUrl: installation.serviceUrl,
      conversationId: target.conversationId,
      activityId: target.activityId,
      tenantId: installation.teamsTenantId,
      text: appendIntegrationMessageFooter(
        body.text ?? "Adaptive card",
        presentation.footerText,
      ),
      card: body.card
        ? appendTeamsCardFooter(body.card, presentation)
        : undefined,
      ...(!body.card && presentation.entities.length > 0
        ? { entities: presentation.entities }
        : {}),
    },
    signal,
  );
  signal.throwIfAborted();
  if (result.kind === "teams-error") {
    return teamsErrorResponse(result);
  }

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      activityId: result.activityId,
      conversationId: target.conversationId,
    },
  };
});

const teamsWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "teams:write",
} as const;

export const integrationsTeamsMessageRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTeamsMessageContract.sendMessage,
    handler: authRoute(teamsWriteAuth, sendMessageInner$),
  },
];
