import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { feishuChatThreadRoutes } from "@okouai/db/schema/feishu-chat-thread-route";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { and, countDistinct, eq, inArray, isNotNull } from "drizzle-orm";
import { buildFeishuAgentResponseMessage } from "../../lib/feishu-message-card";
import { logger } from "../../lib/log";
import {
  removeFeishuMessageReaction,
  replyWithFeishuMessage,
  sendFeishuMessage,
} from "../external/feishu-client";
import type { Db } from "../external/db";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { now, nowDate } from "../../lib/time";
import { settleIncludingAbort } from "../utils";
import {
  feishuChatCallbackPayloadSchema,
  type FeishuDeliveryTarget,
} from "./feishu-chat-callback-payload";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { resolveIntegrationAgentResponsePresentation } from "./integration-agent-response-presentation.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";

const L = logger("InternalCallbacksFeishuChat");

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
    actionType: "feishu_chat_delivery",
    durationMs: Math.max(0, now() - args.startedAt),
    success: args.success,
    runId: args.runId,
    dimensions: { outcome: args.outcome },
  });
}

interface ClaimedFeishuChatDelivery {
  readonly runId: string;
  readonly payload: unknown;
}

async function claimFeishuChatDelivery(
  db: Db,
  callbackId: string,
): Promise<ClaimedFeishuChatDelivery | undefined> {
  const [callback] = await db
    .update(agentRunCallbacks)
    .set({ attempts: 1, lastAttemptAt: nowDate() })
    .where(
      and(
        eq(agentRunCallbacks.id, callbackId),
        eq(agentRunCallbacks.internalKind, "feishu:chat"),
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

async function loadFeishuChatDeliveryContext(
  args: {
    readonly db: Db;
    readonly callback: ClaimedFeishuChatDelivery;
  },
  signal: AbortSignal,
) {
  const payload = feishuChatCallbackPayloadSchema.parse(args.callback.payload);
  const [run] = await args.db
    .select({
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      chatThreadId: agentRuns.chatThreadId,
      agentId: agents.id,
    })
    .from(agentRuns)
    .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(
        eq(agentRuns.id, args.callback.runId),
        inArray(agentRuns.triggerSource, ["feishu", "lark"]),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!run?.chatThreadId) {
    throw new Error("Feishu chat delivery run context is unavailable");
  }

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
    throw new Error("Feishu chat delivery message is unavailable");
  }

  const [binding] = await args.db
    .select({
      feishuOpenId: feishuOrgConnections.feishuOpenId,
      defaultAgentId: feishuOrgInstallations.defaultAgentId,
    })
    .from(feishuChatThreadRoutes)
    .innerJoin(
      feishuOrgConnections,
      eq(feishuOrgConnections.id, feishuChatThreadRoutes.connectionId),
    )
    .innerJoin(
      feishuOrgInstallations,
      eq(feishuOrgInstallations.id, feishuOrgConnections.installationId),
    )
    .where(
      and(
        eq(feishuChatThreadRoutes.chatThreadId, run.chatThreadId),
        eq(feishuChatThreadRoutes.chatId, payload.chatId),
        eq(feishuChatThreadRoutes.threadId, payload.threadId),
        eq(feishuChatThreadRoutes.userId, run.userId),
        eq(feishuChatThreadRoutes.connectionId, payload.connectionId),
        eq(feishuOrgConnections.userId, run.userId),
        eq(feishuOrgInstallations.id, payload.installationId),
        eq(feishuOrgInstallations.orgId, run.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return { payload, run, messageContent: event.content, binding };
}

async function countFeishuMentioners(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly chatId: string;
  readonly threadId: string;
}): Promise<number> {
  const [row] = await args.db
    .select({ count: countDistinct(feishuChatThreadRoutes.connectionId) })
    .from(feishuChatThreadRoutes)
    .innerJoin(
      feishuOrgConnections,
      eq(feishuOrgConnections.id, feishuChatThreadRoutes.connectionId),
    )
    .where(
      and(
        eq(feishuOrgConnections.installationId, args.installationId),
        eq(feishuChatThreadRoutes.chatId, args.chatId),
        eq(feishuChatThreadRoutes.threadId, args.threadId),
      ),
    );
  return row?.count ?? 0;
}

async function loadFeishuAdmissionFailureContext(
  args: {
    readonly db: Db;
    readonly chatThreadId: string;
    readonly userId: string;
    readonly orgId: string;
    readonly target: FeishuDeliveryTarget;
    readonly chatEventId: string;
  },
  signal: AbortSignal,
): Promise<string> {
  const [eventRows, bindingRows] = await Promise.all([
    args.db
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
      .limit(1),
    args.db
      .select({ id: feishuOrgInstallations.id })
      .from(feishuChatThreadRoutes)
      .innerJoin(
        feishuOrgConnections,
        eq(feishuOrgConnections.id, feishuChatThreadRoutes.connectionId),
      )
      .innerJoin(
        feishuOrgInstallations,
        eq(feishuOrgInstallations.id, feishuOrgConnections.installationId),
      )
      .where(
        and(
          eq(feishuChatThreadRoutes.chatThreadId, args.chatThreadId),
          eq(feishuChatThreadRoutes.chatId, args.target.chatId),
          eq(feishuChatThreadRoutes.threadId, args.target.threadId),
          eq(feishuChatThreadRoutes.userId, args.userId),
          eq(feishuChatThreadRoutes.connectionId, args.target.connectionId),
          eq(feishuOrgConnections.userId, args.userId),
          eq(feishuOrgConnections.installationId, args.target.installationId),
          eq(feishuOrgInstallations.id, args.target.installationId),
          eq(feishuOrgInstallations.orgId, args.orgId),
        ),
      )
      .limit(1),
  ]);
  signal.throwIfAborted();
  const event = eventRows[0];
  if (!event?.content || !bindingRows[0]) {
    throw new Error("Feishu admission failure delivery context is unavailable");
  }
  return event.content;
}

export async function deliverFeishuChatAdmissionFailure(
  args: {
    readonly db: Db;
    readonly chatThreadId: string;
    readonly userId: string;
    readonly orgId: string;
    readonly target: FeishuDeliveryTarget;
    readonly chatEventId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  const messageContent = await loadFeishuAdmissionFailureContext(args, signal);
  const message = buildFeishuAgentResponseMessage({
    text: messageContent,
  });
  if (args.target.replyInThread) {
    await replyWithFeishuMessage(
      {
        db: args.db,
        installationId: args.target.installationId,
        messageId: args.target.messageId,
        message,
        replyInThread: true,
        idempotencyKey: args.chatEventId,
      },
      signal,
    );
    return;
  }
  await sendFeishuMessage(
    {
      db: args.db,
      installationId: args.target.installationId,
      receiveIdType: "chat_id",
      receiveId: args.target.chatId,
      message,
      idempotencyKey: args.chatEventId,
    },
    signal,
  );
}

async function deliverClaimedFeishuChatCallback(
  args: {
    readonly db: Db;
    readonly callback: ClaimedFeishuChatDelivery;
  },
  signal: AbortSignal,
): Promise<"delivered" | "skipped_revoked"> {
  const { payload, run, messageContent, binding } =
    await loadFeishuChatDeliveryContext(args, signal);
  if (!binding) {
    return "skipped_revoked";
  }

  const [mentionerCount, featureContext] = await Promise.all([
    countFeishuMentioners({
      db: args.db,
      installationId: payload.installationId,
      chatId: payload.chatId,
      threadId: payload.threadId,
    }),
    loadUserFeatureSwitchContext(args.db, run.orgId, run.userId),
  ]);
  signal.throwIfAborted();
  const presentation = await resolveIntegrationAgentResponsePresentation(
    {
      db: args.db,
      orgId: run.orgId,
      userId: run.userId,
      runId: args.callback.runId,
      agentId: run.agentId,
      defaultAgentId: binding.defaultAgentId ?? undefined,
      replyToMention:
        payload.replyInThread && mentionerCount > 1
          ? `<at id=${binding.feishuOpenId}></at>`
          : undefined,
      getFeatureOverrides: () => {
        return Promise.resolve(featureContext.overrides ?? {});
      },
    },
    signal,
  );
  signal.throwIfAborted();
  const message = buildFeishuAgentResponseMessage({
    text: messageContent,
    auditUrl: presentation.logsUrl,
    footerText: presentation.footerText,
  });
  if (payload.replyInThread) {
    await replyWithFeishuMessage(
      {
        db: args.db,
        installationId: payload.installationId,
        messageId: payload.messageId,
        message,
        replyInThread: true,
        idempotencyKey: args.callback.runId,
      },
      signal,
    );
  } else {
    await sendFeishuMessage(
      {
        db: args.db,
        installationId: payload.installationId,
        receiveIdType: "chat_id",
        receiveId: payload.chatId,
        message,
        idempotencyKey: args.callback.runId,
      },
      signal,
    );
  }
  return "delivered";
}

export async function clearCanonicalFeishuThinkingReaction(
  db: Db,
  target: FeishuDeliveryTarget,
  signal: AbortSignal,
): Promise<void> {
  if (!target.reactionId) {
    return;
  }
  await removeFeishuMessageReaction(
    {
      db,
      installationId: target.installationId,
      messageId: target.messageId,
      reactionId: target.reactionId,
    },
    signal,
  );
}

export async function dispatchFeishuChatDeliveryOnce(
  db: Db,
  callbackId: string,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = now();
  signal.throwIfAborted();
  const callback = await claimFeishuChatDelivery(db, callbackId);
  if (!callback) {
    return;
  }

  const delivery = await settleIncludingAbort(
    deliverClaimedFeishuChatCallback(
      {
        db,
        callback,
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
    L.warn("Canonical Feishu delivery failed", {
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
  if (delivery.value === "skipped_revoked") {
    L.debug("Skipped canonical Feishu delivery after binding revocation", {
      callbackId,
      runId: callback.runId,
    });
  }
}
