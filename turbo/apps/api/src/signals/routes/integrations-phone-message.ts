import { command } from "ccstate";
import { integrationsPhoneMessageContract } from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { snapshotIntegrationMessage$ } from "../services/integration-artifact-message.service";
import type { RouteEntry } from "../route-entry";
import { writeDb$ } from "../external/db";
import {
  isAgentPhoneApiError,
  sendAgentPhoneMessage,
} from "../external/agentphone-client";
import {
  normalizeAgentPhoneHandle,
  resolveAgentPhoneAgentIdForUserLink,
  resolveAgentPhoneUserLinkForOwner,
  storeOutboundAgentPhoneMessage,
  type AgentPhoneChannel,
} from "../services/agentphone.service";
import { settle } from "../utils";

function routeError<Status extends 400 | 401 | 403 | 404 | 502>(
  status: Status,
  message: string,
  code: string,
) {
  return { status, body: { error: { message, code } } };
}

function agentPhoneRouteError(error: unknown) {
  if (!isAgentPhoneApiError(error)) {
    return undefined;
  }
  return routeError(
    error.status >= 500 ? 502 : 400,
    `AgentPhone API error: ${error.body || `HTTP ${error.status}`}`,
    "AGENTPHONE_ERROR",
  );
}

const sendMessage$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(
    bodyResultOf(integrationsPhoneMessageContract.sendMessage),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const userChannel: AgentPhoneChannel = "sms";
  const phoneHandle = normalizeAgentPhoneHandle(body.toNumber, userChannel);
  const db = set(writeDb$);
  const userLink = await resolveAgentPhoneUserLinkForOwner(db, {
    phoneHandle,
    channel: userChannel,
    userId: auth.userId,
    orgId: auth.orgId,
  });
  signal.throwIfAborted();
  if (!userLink) {
    return routeError(404, "Connected phone handle not found", "NOT_FOUND");
  }

  const agentphoneAgentId = await resolveAgentPhoneAgentIdForUserLink(db, {
    userLinkId: userLink.id,
    phoneHandle,
    channel: userChannel,
    agentphoneAgentId: body.agentphoneAgentId,
  });
  signal.throwIfAborted();
  if (!agentphoneAgentId) {
    return routeError(404, "AgentPhone agent not found", "NOT_FOUND");
  }

  const outbound = integrationsPhoneMessageContract.sendMessage.body.parse({
    ...body,
    ...(await set(
      snapshotIntegrationMessage$,
      {
        content: { text: body.text },
        publicBrand: userLink.publicBrand,
      },
      signal,
    )),
  });
  signal.throwIfAborted();

  const sendResult = await settle(
    sendAgentPhoneMessage(
      {
        agentphoneAgentId,
        toNumber: phoneHandle,
        body: outbound.text,
      },
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!sendResult.ok) {
    const routeErr = agentPhoneRouteError(sendResult.error);
    if (routeErr) {
      return routeErr;
    }
    throw sendResult.error;
  }
  const sent = sendResult.value;

  await storeOutboundAgentPhoneMessage(db, {
    agentphoneMessageId: sent.id,
    conversationId: null,
    agentphoneAgentId,
    publicBrand: userLink.publicBrand,
    userLinkId: userLink.id,
    phoneHandle,
    fromNumber: sent.fromNumber ?? "",
    toNumber: sent.toNumber ?? phoneHandle,
    body: outbound.text,
    channel: sent.channel,
    userChannel,
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      messageId: sent.id,
      channel: sent.channel,
      toNumber: sent.toNumber ?? phoneHandle,
    },
  };
});

const phoneWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "phone:write",
} as const;

export const integrationsPhoneMessageRoutes: readonly RouteEntry[] = [
  {
    route: integrationsPhoneMessageContract.sendMessage,
    handler: authRoute(phoneWriteAuth, sendMessage$),
  },
];
