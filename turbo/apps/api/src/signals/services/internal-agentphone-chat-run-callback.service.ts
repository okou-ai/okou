import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentphoneChatThreadRoutes } from "@okouai/db/schema/agentphone-chat-thread-route";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, isNotNull } from "drizzle-orm";
import { logger } from "../../lib/log";
import { sendAgentPhoneMessage } from "../external/agentphone-client";
import type { Db } from "../external/db";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { now, nowDate } from "../../lib/time";
import { settleIncludingAbort } from "../utils";
import {
  agentphoneChatCallbackPayloadSchema,
  type AgentPhoneDeliveryTarget,
} from "./agentphone-chat-callback-payload";
import {
  agentPhoneReplyDestination,
  markdownToImessagePlain,
  resolveAgentPhoneReplyFooterText,
  storeOutboundAgentPhoneMessage,
} from "./agentphone-shared.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";

const L = logger("InternalCallbacksAgentPhoneChat");
type AgentPhoneSendResult = Awaited<ReturnType<typeof sendAgentPhoneMessage>>;

interface ClaimedAgentPhoneChatDelivery {
  readonly runId: string;
  readonly payload: unknown;
}

interface AgentPhoneChatRunContext {
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly agentId: string;
}

async function markDelivered(db: Db, callbackId: string): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({ status: "delivered", deliveredAt: nowDate() })
    .where(eq(agentRunCallbacks.id, callbackId));
}

async function markFailed(
  db: Db,
  callbackId: string,
  error: string,
): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({ status: "failed", lastError: error.slice(0, 4000) })
    .where(eq(agentRunCallbacks.id, callbackId));
}

function recordDelivery(args: {
  readonly runId: string;
  readonly startedAt: number;
  readonly success: boolean;
  readonly outcome: "delivered" | "failed" | "skipped_revoked";
}): void {
  recordSandboxOperation({
    sandboxType: "chat",
    actionType: "agentphone_chat_delivery",
    durationMs: Math.max(0, now() - args.startedAt),
    success: args.success,
    runId: args.runId,
    dimensions: { outcome: args.outcome },
  });
}

async function claimAgentPhoneChatDelivery(
  db: Db,
  callbackId: string,
): Promise<ClaimedAgentPhoneChatDelivery | undefined> {
  const [callback] = await db
    .update(agentRunCallbacks)
    .set({ attempts: 1, lastAttemptAt: nowDate() })
    .where(
      and(
        eq(agentRunCallbacks.id, callbackId),
        eq(agentRunCallbacks.internalKind, "agentphone:chat"),
        eq(agentRunCallbacks.status, "pending"),
        eq(agentRunCallbacks.attempts, 0),
      ),
    )
    .returning({
      runId: agentRunCallbacks.runId,
      payload: agentRunCallbacks.payload,
    });
  return callback;
}

async function loadAgentPhoneRouteBinding(
  args: {
    readonly db: Db;
    readonly target: AgentPhoneDeliveryTarget;
    readonly run: AgentPhoneChatRunContext;
  },
  signal: AbortSignal,
): Promise<{ readonly userLinkId: string } | undefined> {
  const [route] = await args.db
    .select({ userLinkId: agentphoneUserLinks.id })
    .from(agentphoneChatThreadRoutes)
    .innerJoin(
      agentphoneUserLinks,
      eq(
        agentphoneUserLinks.id,
        agentphoneChatThreadRoutes.agentphoneUserLinkId,
      ),
    )
    .where(
      and(
        eq(
          agentphoneChatThreadRoutes.agentphoneUserLinkId,
          args.target.userLinkId,
        ),
        eq(agentphoneChatThreadRoutes.rootMessageId, args.target.rootMessageId),
        eq(agentphoneChatThreadRoutes.chatThreadId, args.run.chatThreadId),
        eq(agentphoneUserLinks.userId, args.run.userId),
        eq(agentphoneUserLinks.orgId, args.run.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return route;
}

async function loadAgentPhoneChatDeliveryContext(
  args: {
    readonly db: Db;
    readonly callback: ClaimedAgentPhoneChatDelivery;
  },
  signal: AbortSignal,
) {
  const payload = agentphoneChatCallbackPayloadSchema.parse(
    args.callback.payload,
  );
  const [run] = await args.db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      chatThreadId: agentRuns.chatThreadId,
      agentId: agents.id,
    })
    .from(agentRuns)
    .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(
        eq(agentRuns.id, args.callback.runId),
        eq(agentRuns.triggerSource, "agentphone"),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!run?.chatThreadId) {
    throw new Error("AgentPhone chat delivery run context is unavailable");
  }
  const runContext: AgentPhoneChatRunContext = {
    userId: run.userId,
    orgId: run.orgId,
    chatThreadId: run.chatThreadId,
    agentId: run.agentId,
  };

  const [event] = await args.db
    .select({ content: canonicalChatEventContent() })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.id, payload.chatEventId),
        eq(chatEvents.runId, args.callback.runId),
        eq(chatEvents.chatThreadId, run.chatThreadId),
        chatEventTypeIn([
          "output.message",
          "output.error",
          "run.failed",
          "run.cancelled",
        ]),
        isNotNull(canonicalChatEventContent()),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!event?.content) {
    throw new Error("AgentPhone chat delivery message is unavailable");
  }

  const binding = await loadAgentPhoneRouteBinding(
    {
      db: args.db,
      target: payload,
      run: runContext,
    },
    signal,
  );
  return {
    payload,
    run: runContext,
    messageContent: event.content,
    binding,
  };
}

function buildAgentPhoneResponseText(args: {
  readonly mainText: string;
  readonly footerText: string | undefined;
}): string {
  return [markdownToImessagePlain(args.mainText), args.footerText]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
}

async function sendAgentPhoneReply(
  args: {
    readonly target: AgentPhoneDeliveryTarget;
    readonly body: string;
  },
  signal: AbortSignal,
): Promise<AgentPhoneSendResult> {
  const toNumber = agentPhoneReplyDestination({
    isGroup: args.target.isGroup,
    groupId: args.target.groupId,
    phoneHandle: args.target.phoneHandle,
  });
  const result = await sendAgentPhoneMessage(
    {
      agentphoneAgentId: args.target.agentphoneAgentId,
      toNumber,
      ...(args.target.channel === "imessage"
        ? { replyToMessageId: args.target.messageId }
        : {}),
      body: args.body,
    },
    signal,
  );
  signal.throwIfAborted();
  return result;
}

async function recordAgentPhoneChatDelivery(args: {
  readonly db: Db;
  readonly target: AgentPhoneDeliveryTarget;
  readonly sent: AgentPhoneSendResult;
  readonly body: string;
}): Promise<void> {
  await storeOutboundAgentPhoneMessage(args.db, {
    agentphoneMessageId: args.sent.id,
    conversationId: args.target.conversationId,
    agentphoneAgentId: args.target.agentphoneAgentId,
    userLinkId: args.target.userLinkId,
    phoneHandle: args.target.phoneHandle,
    fromNumber: args.sent.fromNumber ?? args.target.toNumber,
    toNumber:
      args.sent.toNumber ??
      agentPhoneReplyDestination({
        isGroup: args.target.isGroup,
        groupId: args.target.groupId,
        phoneHandle: args.target.phoneHandle,
      }),
    body: args.body,
    channel: args.sent.channel,
    userChannel: args.target.channel,
  });
}

async function deliverClaimedAgentPhoneChatCallback(
  args: {
    readonly db: Db;
    readonly callback: ClaimedAgentPhoneChatDelivery;
    readonly status: "completed" | "failed";
  },
  signal: AbortSignal,
): Promise<"delivered" | "skipped_revoked"> {
  const { payload, run, messageContent, binding } =
    await loadAgentPhoneChatDeliveryContext(args, signal);
  if (!binding) {
    return "skipped_revoked";
  }
  const footerText = await resolveAgentPhoneReplyFooterText({
    db: args.db,
    orgId: run.orgId,
    composeId: run.agentId,
  });
  signal.throwIfAborted();
  const body = buildAgentPhoneResponseText({
    mainText: messageContent,
    footerText,
  });
  const sent = await sendAgentPhoneReply(
    {
      target: payload,
      body,
    },
    signal,
  );
  await recordAgentPhoneChatDelivery({
    db: args.db,
    target: payload,
    sent,
    body,
  });
  return "delivered";
}

export async function dispatchAgentPhoneChatDeliveryOnce(
  db: Db,
  callbackId: string,
  status: "completed" | "failed",
  signal: AbortSignal,
): Promise<void> {
  const startedAt = now();
  signal.throwIfAborted();
  const callback = await claimAgentPhoneChatDelivery(db, callbackId);
  if (!callback) {
    return;
  }

  const delivery = await settleIncludingAbort(
    deliverClaimedAgentPhoneChatCallback(
      {
        db,
        callback,
        status,
      },
      signal,
    ),
  );
  if (!delivery.ok) {
    const message =
      delivery.error instanceof Error
        ? delivery.error.message
        : "Unknown error";
    await markFailed(db, callbackId, message);
    recordDelivery({
      runId: callback.runId,
      startedAt,
      success: false,
      outcome: "failed",
    });
    L.warn("Canonical AgentPhone delivery failed", {
      callbackId,
      runId: callback.runId,
      error: delivery.error,
    });
    return;
  }

  await markDelivered(db, callbackId);
  recordDelivery({
    runId: callback.runId,
    startedAt,
    success: true,
    outcome: delivery.value,
  });
}

interface AgentPhoneChatAdmissionFailureArgs {
  readonly db: Db;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly target: AgentPhoneDeliveryTarget;
  readonly chatEventId: string;
}

export async function deliverAgentPhoneChatAdmissionFailure(
  args: AgentPhoneChatAdmissionFailureArgs,
  signal: AbortSignal,
): Promise<void> {
  const [event] = await args.db
    .select({ content: canonicalChatEventContent() })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.id, args.chatEventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        chatEventTypeIn(["output.error"]),
        isNotNull(canonicalChatEventContent()),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!event?.content) {
    return;
  }

  const binding = await loadAgentPhoneRouteBinding(
    {
      db: args.db,
      target: args.target,
      run: {
        userId: args.userId,
        orgId: args.orgId,
        chatThreadId: args.chatThreadId,
        agentId: args.agentId,
      },
    },
    signal,
  );
  if (!binding) {
    return;
  }

  const body = markdownToImessagePlain(event.content);
  const sent = await sendAgentPhoneReply(
    {
      target: args.target,
      body,
    },
    signal,
  );
  await storeOutboundAgentPhoneMessage(args.db, {
    agentphoneMessageId: sent.id,
    conversationId: args.target.conversationId,
    agentphoneAgentId: args.target.agentphoneAgentId,
    userLinkId: args.target.userLinkId,
    phoneHandle: args.target.phoneHandle,
    fromNumber: sent.fromNumber ?? args.target.toNumber,
    toNumber:
      sent.toNumber ??
      agentPhoneReplyDestination({
        isGroup: args.target.isGroup,
        groupId: args.target.groupId,
        phoneHandle: args.target.phoneHandle,
      }),
    body,
    channel: sent.channel,
    userChannel: args.target.channel,
  });
}
