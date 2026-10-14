import { command, computed } from "ccstate";
import { integrationsTeamsMessageContract } from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
import { sendTeamsMessage } from "../external/teams-bot-client";
import {
  teamsInstallation,
  resolveTeamsMessageTarget$,
  routeError,
  teamsErrorResponse,
} from "../services/teams-message-target.service";
import type { RouteEntry } from "../route-entry";

const installationOrgId$ = computed((get) => {
  return get(organizationAuthContext$).orgId;
});
const installation$ = teamsInstallation(installationOrgId$);

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
  const installation = await get(installation$);
  signal.throwIfAborted();
  if (!installation) {
    return routeError(
      404,
      "No Microsoft Teams installation found for this organization",
      "NOT_FOUND",
    );
  }
  if (!installation.serviceUrl) {
    return routeError(
      404,
      "Microsoft Teams installation has no service URL yet. Send a message to the Teams bot first.",
      "NOT_FOUND",
    );
  }

  const target = await set(
    resolveTeamsMessageTarget$,
    {
      installation,
      userId: auth.userId,
      body,
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in target) {
    return target;
  }

  const result = await sendTeamsMessage(
    {
      serviceUrl: installation.serviceUrl,
      conversationId: target.conversationId,
      activityId: target.activityId,
      tenantId: installation.teamsTenantId,
      text: body.text ?? "Adaptive card",
      card: body.card,
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
