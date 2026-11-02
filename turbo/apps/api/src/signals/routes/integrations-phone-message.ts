import { agentphoneMessages } from "@okouai/db/schema/agentphone-message";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { agentphoneMessageVisibility } from "@okouai/db/schema/agentphone-message-visibility";
import { and, desc, eq, exists, isNotNull, isNull, or } from "drizzle-orm";
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
  sendAgentPhoneReaction,
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

const reactionBody$ = bodyResultOf(
  integrationsPhoneMessageContract.sendReaction,
);

const reactionTarget$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const body = await get(reactionBody$);
  if (!body.ok) {
    return undefined;
  }
  const db = get(db$);
  const groupVisibility = db
    .select({ messageId: agentphoneMessageVisibility.messageId })
    .from(agentphoneMessageVisibility)
    .where(
      and(
        eq(agentphoneMessageVisibility.messageId, agentphoneMessages.id),
        eq(agentphoneMessageVisibility.orgId, auth.orgId),
        eq(agentphoneMessageVisibility.userId, auth.userId),
      ),
    );
  const [message] = await db
    .select({
      messageId: agentphoneMessages.agentphoneMessageId,
      channel: agentphoneMessages.channel,
      groupId: agentphoneMessages.groupId,
      conversationId: agentphoneMessages.conversationId,
      phoneHandle: agentphoneUserLinks.phoneHandle,
    })
    .from(agentphoneMessages)
    .innerJoin(
      agentphoneUserLinks,
      and(
        eq(agentphoneUserLinks.orgId, auth.orgId),
        eq(agentphoneUserLinks.userId, auth.userId),
      ),
    )
    .where(
      and(
        eq(agentphoneMessages.agentphoneMessageId, body.data.messageId),
        or(
          and(
            isNull(agentphoneMessages.groupId),
            eq(agentphoneMessages.agentphoneUserLinkId, agentphoneUserLinks.id),
          ),
          and(isNotNull(agentphoneMessages.groupId), exists(groupVisibility)),
        ),
      ),
    )
    .limit(1);
  return message;
});

const sendReaction$ = command(async ({ get }, signal: AbortSignal) => {
  const body = await get(reactionBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const target = await get(reactionTarget$);
  signal.throwIfAborted();
  const notFound = () => {
    return routeError(
      404,
      "Message not found for this account, or your connected phone is no longer a group member",
      "NOT_FOUND",
    );
  };
  if (!target) {
    return notFound();
  }
  if (target.channel !== "imessage") {
    return routeError(
      400,
      "Emoji reactions require an iMessage; SMS and MMS do not support reactions",
      "UNSUPPORTED_CHANNEL",
    );
  }
  if (target.groupId) {
    if (!target.conversationId) {
      return notFound();
    }
    const roster = await settle(
      getAgentPhoneConversationParticipants(
        { conversationId: target.conversationId },
        signal,
      ),
      signal,
    );
    if (!roster.ok) {
      if (isAgentPhoneApiError(roster.error) && roster.error.status === 404) {
        return notFound();
      }
      const response = agentPhoneRouteError(roster.error);
      if (response) {
        return response;
      }
      throw roster.error;
    }
    if (
      !roster.value.some((handle) => {
        return (
          normalizeAgentPhoneHandle(handle, "imessage") ===
          normalizeAgentPhoneHandle(target.phoneHandle, "imessage")
        );
      })
    ) {
      return notFound();
    }
  }
  const result = await settle(
    sendAgentPhoneReaction(
      { messageId: target.messageId, reaction: body.data.reaction },
      signal,
    ),
    signal,
  );
  if (!result.ok) {
    if (isAgentPhoneApiError(result.error) && result.error.status === 404) {
      return notFound();
    }
    const response = agentPhoneRouteError(result.error);
    if (response) {
      return response;
    }
    if (result.error instanceof TypeError) {
      return routeError(
        502,
        "Phone reaction outcome is unknown. Do not retry automatically",
        "AGENTPHONE_OUTCOME_UNKNOWN",
      );
    }
    throw result.error;
  }
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      reactionId: result.value.id,
      messageId: result.value.message_id,
      reaction: result.value.reaction_type,
      channel: result.value.channel,
    },
  };
});

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
  {
    route: integrationsPhoneMessageContract.sendReaction,
    handler: authRoute(phoneWriteAuth, sendReaction$),
  },
];
