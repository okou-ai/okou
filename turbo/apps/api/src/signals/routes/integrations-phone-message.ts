import { agentphoneMessages } from "@okouai/db/schema/agentphone-message";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { agentphoneMessageVisibility } from "@okouai/db/schema/agentphone-message-visibility";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { command, computed } from "ccstate";
import { integrationsPhoneMessageContract } from "@okouai/api-contracts/contracts/integrations";
import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { db$ } from "../external/db";
import {
  getAgentPhoneConversationParticipants,
  isAgentPhoneApiError,
  sendAgentPhoneMessage,
} from "../external/agentphone-client";
import {
  agentPhoneChannelForLinkedHandle,
  normalizeAgentPhoneHandle,
  storeOutboundAgentPhoneMessage$,
} from "../services/agentphone.service";
import { resolveAgentPhoneParticipantVisibilityRecipients$ } from "../services/agentphone-shared.service";
import { settle } from "../utils";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";

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

const groupMessageBody$ = bodyResultOf(
  integrationsAgentPhoneContract.groupMessage,
);

const groupMessageTarget$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const body = await get(groupMessageBody$);
  if (!body.ok) {
    return undefined;
  }
  const [target] = await get(db$)
    .select({
      conversationId: agentphoneMessages.conversationId,
      agentphoneAgentId: agentphoneMessages.agentphoneAgentId,
      phoneHandle: agentphoneUserLinks.phoneHandle,
    })
    .from(agentphoneMessages)
    .innerJoin(
      agentphoneMessageVisibility,
      eq(agentphoneMessageVisibility.messageId, agentphoneMessages.id),
    )
    .innerJoin(
      agentphoneUserLinks,
      and(
        eq(agentphoneUserLinks.userId, auth.userId),
        eq(agentphoneUserLinks.orgId, auth.orgId),
      ),
    )
    .where(
      and(
        eq(agentphoneMessageVisibility.orgId, auth.orgId),
        eq(agentphoneMessageVisibility.userId, auth.userId),
        eq(agentphoneMessages.groupId, body.data.groupId),
        eq(agentphoneMessages.channel, "imessage"),
        isNotNull(agentphoneMessages.conversationId),
        body.data.agentphoneAgentId
          ? eq(
              agentphoneMessages.agentphoneAgentId,
              body.data.agentphoneAgentId,
            )
          : undefined,
      ),
    )
    .orderBy(
      desc(agentphoneMessages.receivedAt),
      desc(agentphoneMessages.createdAt),
    )
    .limit(1);
  return target?.conversationId ? target : undefined;
});

function groupNotFound() {
  return routeError(
    404,
    "Group not found for this account, or your connected phone is no longer a member",
    "NOT_FOUND",
  );
}

const sendGroupMessage$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(groupMessageBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const target = await get(groupMessageTarget$);
  signal.throwIfAborted();
  if (!target?.conversationId) {
    return groupNotFound();
  }

  const asOf = nowDate();
  const roster = await settle(
    getAgentPhoneConversationParticipants(
      { conversationId: target.conversationId },
      signal,
    ),
    signal,
  );
  if (!roster.ok) {
    if (isAgentPhoneApiError(roster.error) && roster.error.status === 404) {
      return groupNotFound();
    }
    const response = agentPhoneRouteError(roster.error);
    if (response) {
      return response;
    }
    throw roster.error;
  }
  const recipients = await set(
    resolveAgentPhoneParticipantVisibilityRecipients$,
    roster.value,
    asOf,
    signal,
  );
  if (
    !recipients.some((recipient) => {
      return recipient.userId === auth.userId && recipient.orgId === auth.orgId;
    })
  ) {
    return groupNotFound();
  }

  const sentResult = await settle(
    (async () => {
      const sent = await sendAgentPhoneMessage(
        {
          agentphoneAgentId: target.agentphoneAgentId,
          toNumber: bodyResult.data.groupId,
          body: bodyResult.data.text,
        },
        signal,
      );
      await set(storeOutboundAgentPhoneMessage$, {
        agentphoneMessageId: sent.id,
        conversationId: target.conversationId,
        groupId: bodyResult.data.groupId,
        agentphoneAgentId: target.agentphoneAgentId,
        phoneHandle: target.phoneHandle,
        fromNumber: sent.fromNumber ?? "",
        toNumber: bodyResult.data.groupId,
        body: bodyResult.data.text,
        channel: "imessage",
        userChannel: "imessage",
        visibilityRecipients: recipients,
      });
      signal.throwIfAborted();
      return sent;
    })(),
    signal,
  );
  if (!sentResult.ok) {
    const response = agentPhoneRouteError(sentResult.error);
    if (response) {
      return response;
    }
    throw sentResult.error;
  }
  const sent = sentResult.value;
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      messageId: sent.id,
      channel: sent.channel,
      toNumber: bodyResult.data.groupId,
    },
  };
});

export const integrationsPhoneMessageRoutes: readonly RouteEntry[] = [
  {
    route: integrationsPhoneMessageContract.sendMessage,
    handler: authRoute(phoneWriteAuth, sendMessage$),
  },
  {
    route: integrationsAgentPhoneContract.groupMessage,
    handler: authRoute(phoneWriteAuth, sendGroupMessage$),
  },
];
