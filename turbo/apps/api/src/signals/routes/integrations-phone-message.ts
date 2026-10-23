import { agentphoneMessages } from "@okouai/db/schema/agentphone-message";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { and, desc, eq } from "drizzle-orm";
import { command } from "ccstate";
import { integrationsPhoneMessageContract } from "@okouai/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { db$ } from "../external/db";
import {
  isAgentPhoneApiError,
  sendAgentPhoneMessage,
} from "../external/agentphone-client";
import {
  agentPhoneChannelForLinkedHandle,
  normalizeAgentPhoneHandle,
  storeOutboundAgentPhoneMessage$,
} from "../services/agentphone.service";
import { settle } from "../utils";
import { optionalEnv } from "../../lib/env";

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
    `Phone provider error: ${error.body || `HTTP ${error.status}`}`,
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
  const db = get(db$);
  const [link] = await db
    .select()
    .from(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.userId, auth.userId),
        eq(agentphoneUserLinks.orgId, auth.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  const userLink = link ?? null;
  if (!userLink) {
    return routeError(
      404,
      "No phone is connected to this Okou account",
      "NOT_FOUND",
    );
  }
  const phoneHandle = userLink.phoneHandle;
  const userChannel = agentPhoneChannelForLinkedHandle(phoneHandle);

  const agentRows = db
    .select({ agentphoneAgentId: agentphoneMessages.agentphoneAgentId })
    .from(agentphoneMessages)
    .where(
      and(
        eq(agentphoneMessages.agentphoneUserLinkId, userLink.id),
        body.agentphoneAgentId
          ? eq(agentphoneMessages.agentphoneAgentId, body.agentphoneAgentId)
          : undefined,
        eq(
          agentphoneMessages.phoneHandle,
          normalizeAgentPhoneHandle(phoneHandle, userChannel),
        ),
      ),
    )
    .orderBy(desc(agentphoneMessages.createdAt))
    .limit(1);
  const [message] = await agentRows;
  signal.throwIfAborted();
  const agentphoneAgentId =
    body.agentphoneAgentId &&
    body.agentphoneAgentId === optionalEnv("AGENTPHONE_AGENT_ID")
      ? body.agentphoneAgentId
      : (message?.agentphoneAgentId ?? null);
  if (!agentphoneAgentId) {
    return routeError(404, "Phone agent not found", "NOT_FOUND");
  }

  const sendResult = await settle(
    sendAgentPhoneMessage(
      {
        agentphoneAgentId,
        toNumber: phoneHandle,
        body: body.text,
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

  await set(storeOutboundAgentPhoneMessage$, {
    agentphoneMessageId: sent.id,
    conversationId: null,
    agentphoneAgentId,
    userLinkId: userLink.id,
    phoneHandle,
    fromNumber: sent.fromNumber ?? "",
    toNumber: sent.toNumber ?? phoneHandle,
    body: body.text,
    channel: sent.channel,
    userChannel,
    visibilityRecipients: [],
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
