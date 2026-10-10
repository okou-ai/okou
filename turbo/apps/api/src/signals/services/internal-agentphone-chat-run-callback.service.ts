import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentphoneChatThreadRoutes } from "@okouai/db/schema/agentphone-chat-thread-route";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { logger } from "../../lib/log";
import { sendAgentPhoneMessage } from "../external/agentphone-client";
import { db$, writeDb$ } from "../external/db";
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
  resolveAgentPhoneConversationVisibilityRecipients$,
  resolveAgentPhoneReplyFooterText,
  storeOutboundAgentPhoneMessage$,
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

const markDelivered$ = command(
  async ({ set }, callbackId: string): Promise<void> => {
    await set(writeDb$)
      .update(agentRunCallbacks)
      .set({ status: "delivered", deliveredAt: nowDate() })
      .where(eq(agentRunCallbacks.id, callbackId));
  },
);

const markFailed$ = command(
  async ({ set }, callbackId: string, error: string): Promise<void> => {
    await set(writeDb$)
      .update(agentRunCallbacks)
      .set({ status: "failed", lastError: error.slice(0, 4000) })
      .where(eq(agentRunCallbacks.id, callbackId));
  },
);

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

const claimAgentPhoneChatDelivery$ = command(
  async (
    { set },
    callbackId: string,
    signal: AbortSignal,
  ): Promise<readonly ClaimedAgentPhoneChatDelivery[]> => {
    signal.throwIfAborted();
    return await set(writeDb$)
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
  },
);

const loadAgentPhoneRouteBinding$ = command(
  async (
    { get },
    args: {
      readonly target: AgentPhoneDeliveryTarget;
      readonly run: AgentPhoneChatRunContext;
    },
    signal: AbortSignal,
  ): Promise<{ readonly userLinkId: string } | undefined> => {
    const [route] = await get(db$)
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
          eq(
            agentphoneChatThreadRoutes.rootMessageId,
            args.target.rootMessageId,
          ),
          eq(agentphoneChatThreadRoutes.chatThreadId, args.run.chatThreadId),
          eq(agentphoneUserLinks.userId, args.run.userId),
          eq(agentphoneUserLinks.orgId, args.run.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return route;
  },
);

const loadAgentPhoneChatDeliveryContext$ = command(
  async (
    { get, set },
    args: {
      readonly callback: ClaimedAgentPhoneChatDelivery;
    },
    signal: AbortSignal,
  ) => {
    const payload = agentphoneChatCallbackPayloadSchema.parse(
      args.callback.payload,
    );
    const [run] = await get(db$)
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

    const [event] = await get(db$)
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

    const binding = await set(
      loadAgentPhoneRouteBinding$,
      {
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
  },
);

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

interface AgentPhoneChatSendResult {
  readonly message: AgentPhoneSendResult;
  readonly visibilityRecipients: readonly {
    readonly orgId: string;
    readonly userId: string;
  }[];
}

const sendAgentPhoneReply$ = command(
  async (
    { set },
    args: {
      readonly target: AgentPhoneDeliveryTarget;
      readonly body: string;
    },
    signal: AbortSignal,
  ): Promise<AgentPhoneChatSendResult> => {
    const toNumber = agentPhoneReplyDestination({
      isGroup: args.target.isGroup,
      groupId: args.target.groupId,
      phoneHandle: args.target.phoneHandle,
    });
    if (args.target.isGroup && !args.target.conversationId) {
      throw new Error("AgentPhone group reply is missing a conversation id");
    }
    const visibilityRecipients = args.target.isGroup
      ? await set(
          resolveAgentPhoneConversationVisibilityRecipients$,
          args.target.conversationId!,
          nowDate(),
          signal,
        )
      : [];
    signal.throwIfAborted();

    const message = await sendAgentPhoneMessage(
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
    return { message, visibilityRecipients };
  },
);

function outboundAgentPhoneDeliveryValues(args: {
  readonly target: AgentPhoneDeliveryTarget;
  readonly sent: AgentPhoneChatSendResult;
  readonly body: string;
}) {
  return {
    agentphoneMessageId: args.sent.message.id,
    conversationId: args.target.conversationId,
    groupId: args.target.isGroup ? args.target.groupId : null,
    agentphoneAgentId: args.target.agentphoneAgentId,
    userLinkId: args.target.userLinkId,
    phoneHandle: args.target.phoneHandle,
    fromNumber: args.target.isGroup
      ? args.target.toNumber
      : (args.sent.message.fromNumber ?? args.target.toNumber),
    toNumber: args.sent.message.toNumber,
    body: args.body,
    channel: args.target.isGroup
      ? args.target.channel
      : (args.sent.message.channel ?? args.target.channel),
    userChannel: args.target.channel,
    visibilityRecipients: args.sent.visibilityRecipients,
  };
}

// This is durable recording of a completed provider effect, not another send.
const recordAgentPhoneChatDelivery$ = command(
  async (
    { set },
    values: ReturnType<typeof outboundAgentPhoneDeliveryValues>,
  ) => {
    await set(storeOutboundAgentPhoneMessage$, values);
    return "delivered" as const;
  },
);

const deliverClaimedAgentPhoneChatCallback$ = command(
  async (
    { get, set },
    args: {
      readonly callback: ClaimedAgentPhoneChatDelivery;
      readonly status: "completed" | "failed";
    },
    signal: AbortSignal,
  ): Promise<"delivered" | "skipped_revoked"> => {
    const { payload, run, messageContent, binding } = await set(
      loadAgentPhoneChatDeliveryContext$,
      args,
      signal,
    );
    if (!binding) {
      return "skipped_revoked";
    }
    const footerText = await resolveAgentPhoneReplyFooterText({
      db: get(db$),
      orgId: run.orgId,
      composeId: run.agentId,
    });
    signal.throwIfAborted();
    const body = buildAgentPhoneResponseText({
      mainText: messageContent,
      footerText,
    });
    const sent = await set(
      sendAgentPhoneReply$,
      {
        target: payload,
        body,
      },
      signal,
    );
    return set(
      recordAgentPhoneChatDelivery$,
      outboundAgentPhoneDeliveryValues({
        target: payload,
        sent,
        body,
      }),
    );
  },
);

const attemptClaimedAgentPhoneChatDelivery$ = command(
  (
    { set },
    callback: ClaimedAgentPhoneChatDelivery,
    status: "completed" | "failed",
    signal: AbortSignal,
  ) => {
    return settleIncludingAbort(
      set(deliverClaimedAgentPhoneChatCallback$, { callback, status }, signal),
    );
  },
);

// After the one-shot claim, cancellation is an attempt outcome. Both failed and
// successful attempts must finish their callback bookkeeping without a resend.
const finalizeAgentPhoneChatDelivery$ = command(
  async (
    { set },
    args: {
      readonly callbackId: string;
      readonly runId: string;
      readonly startedAt: number;
      readonly delivery: Awaited<
        ReturnType<typeof settleIncludingAbort<"delivered" | "skipped_revoked">>
      >;
    },
  ): Promise<void> => {
    if (!args.delivery.ok) {
      const message =
        args.delivery.error instanceof Error
          ? args.delivery.error.message
          : "Unknown error";
      await set(markFailed$, args.callbackId, message);
      recordDelivery({
        runId: args.runId,
        startedAt: args.startedAt,
        success: false,
        outcome: "failed",
      });
      L.warn("Canonical AgentPhone delivery failed", {
        callbackId: args.callbackId,
        runId: args.runId,
        error: args.delivery.error,
      });
      return;
    }
    await set(markDelivered$, args.callbackId);
    recordDelivery({
      runId: args.runId,
      startedAt: args.startedAt,
      success: true,
      outcome: args.delivery.value,
    });
  },
);

export const dispatchAgentPhoneChatDeliveryOnce$ = command(
  async (
    { set },
    callbackId: string,
    status: "completed" | "failed",
    signal: AbortSignal,
  ): Promise<void> => {
    const startedAt = now();
    signal.throwIfAborted();
    const [callback] = await set(
      claimAgentPhoneChatDelivery$,
      callbackId,
      signal,
    );
    if (!callback) {
      return;
    }
    const delivery = await set(
      attemptClaimedAgentPhoneChatDelivery$,
      callback,
      status,
      signal,
    );
    return set(finalizeAgentPhoneChatDelivery$, {
      callbackId,
      runId: callback.runId,
      startedAt,
      delivery,
    });
  },
);

interface AgentPhoneChatAdmissionFailureArgs {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly target: AgentPhoneDeliveryTarget;
  readonly chatEventId: string;
}

export const deliverAgentPhoneChatAdmissionFailure$ = command(
  async (
    { get, set },
    args: AgentPhoneChatAdmissionFailureArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const [event] = await get(db$)
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

    const binding = await set(
      loadAgentPhoneRouteBinding$,
      {
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
    const sent = await set(
      sendAgentPhoneReply$,
      {
        target: args.target,
        body,
      },
      signal,
    );
    await set(storeOutboundAgentPhoneMessage$, {
      agentphoneMessageId: sent.message.id,
      conversationId: args.target.conversationId,
      groupId: args.target.isGroup ? args.target.groupId : null,
      agentphoneAgentId: args.target.agentphoneAgentId,
      userLinkId: args.target.userLinkId,
      phoneHandle: args.target.phoneHandle,
      fromNumber: args.target.isGroup
        ? args.target.toNumber
        : (sent.message.fromNumber ?? args.target.toNumber),
      toNumber: sent.message.toNumber,
      body,
      channel: args.target.isGroup ? args.target.channel : sent.message.channel,
      userChannel: args.target.channel,
      visibilityRecipients: sent.visibilityRecipients,
    });
  },
);
