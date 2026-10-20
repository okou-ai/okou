import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { feishuChatThreadRoutes } from "@okouai/db/schema/feishu-chat-thread-route";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { command } from "ccstate";
import { and, countDistinct, eq, inArray, isNotNull } from "drizzle-orm";
import { buildFeishuAgentResponseMessage } from "../../lib/feishu-message-card";
import { logger } from "../../lib/log";
import {
  FeishuApiError,
  feishuReactionRemovalUrl,
  feishuTokenUpdateValues,
  parseFeishuReactionRemovalResponse,
  readFeishuResponseJson,
  resolveFeishuRequestCredentials,
  replyWithFeishuMessage,
  feishuMessagePayload,
  feishuMessageSendBody,
  feishuMessageSendUrl,
  parseFeishuSentMessage,
} from "../external/feishu-client";
import { db$, writeDb$, type Db } from "../external/db";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { now, nowDate } from "../../lib/time";
import { settleIncludingAbort } from "../utils";
import {
  feishuChatCallbackPayloadSchema,
  type FeishuDeliveryTarget,
} from "./feishu-chat-callback-payload";
import { resolveIntegrationAgentResponsePresentation } from "./integration-agent-response-presentation.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import {
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
} from "./feishu-config";

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
      defaultAgentId: orgMetadata.defaultAgentId,
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
    .leftJoin(orgMetadata, eq(orgMetadata.orgId, feishuOrgInstallations.orgId))
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
  const sendArgs = {
    db: args.db,
    installationId: args.target.installationId,
    receiveIdType: "chat_id",
    receiveId: args.target.chatId,
    message,
    idempotencyKey: args.chatEventId,
  };
  const sendSignal = signal;
  await (async () => {
    const sendContextArgs = sendArgs;
    const { token, apiOrigin, providerName } = await (async () => {
      const [installation] = await sendContextArgs.db
        .select()
        .from(feishuOrgInstallations)
        .where(eq(feishuOrgInstallations.id, sendContextArgs.installationId))
        .limit(1);
      sendSignal.throwIfAborted();
      if (!installation) {
        throw new Error("Bot installation not found");
      }
      if (
        !(await (async () => {
          const plan = feishuInstallationAvailabilityReadPlan(installation);
          if (plan.kind === "resolved") {
            return plan.enabled;
          }
          const rows = await sendContextArgs.db
            .select(plan.columns)
            .from(userFeatureSwitches)
            .where(plan.condition);
          return feishuInstallationEnabledFromRows(plan.scope, rows);
        })())
      ) {
        throw new FeishuApiError("Lark integration is not enabled", 403);
      }
      const credentials = await resolveFeishuRequestCredentials(
        installation,
        sendSignal,
      );
      if (credentials.refreshedToken) {
        await sendContextArgs.db
          .update(feishuOrgInstallations)
          .set(feishuTokenUpdateValues(credentials.refreshedToken))
          .where(eq(feishuOrgInstallations.id, sendContextArgs.installationId));
        sendSignal.throwIfAborted();
      }
      return credentials.context;
    })();
    const url = feishuMessageSendUrl(apiOrigin);
    url.searchParams.set("receive_id_type", sendArgs.receiveIdType);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(
        feishuMessageSendBody(
          sendArgs.receiveId,
          feishuMessagePayload(sendArgs.message),
          sendArgs.idempotencyKey,
        ),
      ),
      signal: sendSignal,
    });
    return parseFeishuSentMessage(
      await readFeishuResponseJson(response, providerName),
      `${providerName} message send failed`,
      providerName,
    );
  })();
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

  const mentionerCount = await countFeishuMentioners({
    db: args.db,
    installationId: payload.installationId,
    chatId: payload.chatId,
    threadId: payload.threadId,
  });
  signal.throwIfAborted();
  const presentation = await resolveIntegrationAgentResponsePresentation(
    {
      db: args.db,
      orgId: run.orgId,
      runId: args.callback.runId,
      agentId: run.agentId,
      defaultAgentId: binding.defaultAgentId ?? undefined,
      replyToMention:
        payload.replyInThread && mentionerCount > 1
          ? `<at id=${binding.feishuOpenId}></at>`
          : undefined,
    },
    signal,
  );
  signal.throwIfAborted();
  const message = buildFeishuAgentResponseMessage({
    text: messageContent,
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
    const sendArgs = {
      db: args.db,
      installationId: payload.installationId,
      receiveIdType: "chat_id",
      receiveId: payload.chatId,
      message,
      idempotencyKey: args.callback.runId,
    };
    const sendSignal = signal;
    await (async () => {
      const sendContextArgs = sendArgs;
      const { token, apiOrigin, providerName } = await (async () => {
        const [installation] = await sendContextArgs.db
          .select()
          .from(feishuOrgInstallations)
          .where(eq(feishuOrgInstallations.id, sendContextArgs.installationId))
          .limit(1);
        sendSignal.throwIfAborted();
        if (!installation) {
          throw new Error("Bot installation not found");
        }
        if (
          !(await (async () => {
            const plan = feishuInstallationAvailabilityReadPlan(installation);
            if (plan.kind === "resolved") {
              return plan.enabled;
            }
            const rows = await sendContextArgs.db
              .select(plan.columns)
              .from(userFeatureSwitches)
              .where(plan.condition);
            return feishuInstallationEnabledFromRows(plan.scope, rows);
          })())
        ) {
          throw new FeishuApiError("Lark integration is not enabled", 403);
        }
        const credentials = await resolveFeishuRequestCredentials(
          installation,
          sendSignal,
        );
        if (credentials.refreshedToken) {
          await sendContextArgs.db
            .update(feishuOrgInstallations)
            .set(feishuTokenUpdateValues(credentials.refreshedToken))
            .where(
              eq(feishuOrgInstallations.id, sendContextArgs.installationId),
            );
          sendSignal.throwIfAborted();
        }
        return credentials.context;
      })();
      const url = feishuMessageSendUrl(apiOrigin);
      url.searchParams.set("receive_id_type", sendArgs.receiveIdType);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(
          feishuMessageSendBody(
            sendArgs.receiveId,
            feishuMessagePayload(sendArgs.message),
            sendArgs.idempotencyKey,
          ),
        ),
        signal: sendSignal,
      });
      return parseFeishuSentMessage(
        await readFeishuResponseJson(response, providerName),
        `${providerName} message send failed`,
        providerName,
      );
    })();
  }
  return "delivered";
}

export const removeFeishuThinkingReaction$ = command(
  (
    { get, set },
    target: {
      readonly installationId: string;
      readonly messageId: string;
      readonly reactionId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    return (async () => {
      const { token, apiOrigin, providerName } = await (async () => {
        const [installation] = await get(db$)
          .select()
          .from(feishuOrgInstallations)
          .where(eq(feishuOrgInstallations.id, target.installationId))
          .limit(1);
        signal.throwIfAborted();
        if (!installation) {
          throw new Error("Bot installation not found");
        }
        if (
          !(await (async () => {
            const plan = feishuInstallationAvailabilityReadPlan(installation);
            if (plan.kind === "resolved") {
              return plan.enabled;
            }
            const rows = await get(db$)
              .select(plan.columns)
              .from(userFeatureSwitches)
              .where(plan.condition);
            return feishuInstallationEnabledFromRows(plan.scope, rows);
          })())
        ) {
          throw new FeishuApiError("Lark integration is not enabled", 403);
        }
        const credentials = await resolveFeishuRequestCredentials(
          installation,
          signal,
        );
        if (credentials.refreshedToken) {
          await set(writeDb$)
            .update(feishuOrgInstallations)
            .set(feishuTokenUpdateValues(credentials.refreshedToken))
            .where(eq(feishuOrgInstallations.id, target.installationId));
          signal.throwIfAborted();
        }
        return credentials.context;
      })();
      const response = await fetch(
        feishuReactionRemovalUrl(
          apiOrigin,
          target.messageId,
          target.reactionId,
        ),
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
          signal,
        },
      );
      parseFeishuReactionRemovalResponse(
        await readFeishuResponseJson(response, providerName),
        providerName,
      );
    })();
  },
);

export const clearCanonicalFeishuThinkingReaction$ = command(
  async (
    { set },
    target: FeishuDeliveryTarget,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!target.reactionId) {
      return;
    }
    await set(
      removeFeishuThinkingReaction$,
      {
        installationId: target.installationId,
        messageId: target.messageId,
        reactionId: target.reactionId,
      },
      signal,
    );
  },
);

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
