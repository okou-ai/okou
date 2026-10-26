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
  replyWithFeishuMessage$,
  feishuMessagePayload,
  feishuMessageSendBody,
  feishuMessageSendUrl,
  parseFeishuSentMessage,
} from "../external/feishu-client";
import { db$, writeDb$ } from "../external/db";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { now, nowDate } from "../../lib/time";
import { settleIncludingAbort } from "../utils";
import {
  feishuChatCallbackPayloadSchema,
  type FeishuDeliveryTarget,
} from "./feishu-chat-callback-payload";
import { resolveIntegrationAgentResponsePresentation$ } from "./integration-agent-response-presentation.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import {
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
} from "./feishu-config";

const L = logger("InternalCallbacksFeishuChat");

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

const claimFeishuChatDelivery$ = command(
  async (
    { set },
    callbackId: string,
    signal: AbortSignal,
  ): Promise<readonly ClaimedFeishuChatDelivery[]> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    return await db
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
  },
);

const loadFeishuChatDeliveryContext$ = command(
  async (
    { get },
    args: {
      readonly callback: ClaimedFeishuChatDelivery;
    },
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const payload = feishuChatCallbackPayloadSchema.parse(
      args.callback.payload,
    );
    const [run] = await db
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

    const [event] = await db
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

    const [binding] = await db
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
      .leftJoin(
        orgMetadata,
        eq(orgMetadata.orgId, feishuOrgInstallations.orgId),
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
  },
);

const countFeishuMentioners$ = command(
  async (
    { get },
    args: {
      readonly installationId: string;
      readonly chatId: string;
      readonly threadId: string;
    },
  ): Promise<number> => {
    const db = get(db$);
    const [row] = await db
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
  },
);

const loadFeishuAdmissionFailureContext$ = command(
  async (
    { get },
    args: {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly target: FeishuDeliveryTarget;
      readonly chatEventId: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const db = get(db$);
    const [eventRows, bindingRows] = await Promise.all([
      db
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
      db
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
      throw new Error(
        "Feishu admission failure delivery context is unavailable",
      );
    }
    return event.content;
  },
);

export const deliverFeishuChatAdmissionFailure$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly target: FeishuDeliveryTarget;
      readonly chatEventId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const messageContent = await set(
      loadFeishuAdmissionFailureContext$,
      args,
      signal,
    );
    const message = buildFeishuAgentResponseMessage({
      text: messageContent,
    });
    if (args.target.replyInThread) {
      await set(
        replyWithFeishuMessage$,
        {
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
        const [installation] = await db
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
            const rows = await db
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
          await db
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
      const response = fetch(url, {
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
      });
      return parseFeishuSentMessage(
        await readFeishuResponseJson(response, providerName),
        `${providerName} message send failed`,
        providerName,
      );
    })();
  },
);

const deliverClaimedFeishuChatCallback$ = command(
  async (
    { set },
    args: {
      readonly callback: ClaimedFeishuChatDelivery;
    },
    signal: AbortSignal,
  ): Promise<"delivered" | "skipped_revoked"> => {
    const db = set(writeDb$);
    const { payload, run, messageContent, binding } = await set(
      loadFeishuChatDeliveryContext$,
      args,
      signal,
    );
    if (!binding) {
      return "skipped_revoked";
    }

    const mentionerCount = await set(countFeishuMentioners$, {
      installationId: payload.installationId,
      chatId: payload.chatId,
      threadId: payload.threadId,
    });
    signal.throwIfAborted();
    const presentation = await set(
      resolveIntegrationAgentResponsePresentation$,
      {
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
      await set(
        replyWithFeishuMessage$,
        {
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
        installationId: payload.installationId,
        receiveIdType: "chat_id",
        receiveId: payload.chatId,
        message,
        idempotencyKey: args.callback.runId,
      };
      const { token, apiOrigin, providerName } = await (async () => {
        const [installation] = await db
          .select()
          .from(feishuOrgInstallations)
          .where(eq(feishuOrgInstallations.id, sendArgs.installationId))
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
            const rows = await db
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
          await db
            .update(feishuOrgInstallations)
            .set(feishuTokenUpdateValues(credentials.refreshedToken))
            .where(eq(feishuOrgInstallations.id, sendArgs.installationId));
          signal.throwIfAborted();
        }
        return credentials.context;
      })();
      signal.throwIfAborted();
      const url = feishuMessageSendUrl(apiOrigin);
      url.searchParams.set("receive_id_type", sendArgs.receiveIdType);
      const response = fetch(url, {
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
      });
      parseFeishuSentMessage(
        await readFeishuResponseJson(response, providerName),
        `${providerName} message send failed`,
        providerName,
      );
    }
    return "delivered";
  },
);

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
      const response = fetch(
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

const tryFeishuChatDelivery$ = command(
  ({ set }, callback: ClaimedFeishuChatDelivery, signal: AbortSignal) => {
    return settleIncludingAbort(
      set(deliverClaimedFeishuChatCallback$, { callback }, signal),
    );
  },
);

/** A claimed delivery must record its terminal outcome, including cancellation. */
const completeFeishuChatDelivery$ = command(
  async (
    { set },
    args: {
      readonly callbackId: string;
      readonly runId: string;
      readonly startedAt: number;
    },
    delivery: Awaited<ReturnType<typeof tryFeishuChatDelivery$.write>>,
  ): Promise<void> => {
    const db = set(writeDb$);
    if (!delivery.ok) {
      const message =
        delivery.error instanceof Error
          ? delivery.error.message
          : "Unknown error";
      await db
        .update(agentRunCallbacks)
        .set({ status: "failed", lastError: message.slice(0, 4000) })
        .where(eq(agentRunCallbacks.id, args.callbackId));
      recordDelivery({
        runId: args.runId,
        startedAt: args.startedAt,
        success: false,
        outcome: "failed",
      });
      L.warn("Canonical Feishu delivery failed", {
        callbackId: args.callbackId,
        runId: args.runId,
        error: delivery.error,
      });
      return;
    }
    await db
      .update(agentRunCallbacks)
      .set({ status: "delivered", deliveredAt: nowDate() })
      .where(eq(agentRunCallbacks.id, args.callbackId));
    recordDelivery({
      runId: args.runId,
      startedAt: args.startedAt,
      success: true,
      outcome: delivery.value,
    });
    if (delivery.value === "skipped_revoked") {
      L.debug("Skipped canonical Feishu delivery after binding revocation", {
        callbackId: args.callbackId,
        runId: args.runId,
      });
    }
  },
);

export const dispatchFeishuChatDeliveryOnce$ = command(
  async ({ set }, callbackId: string, signal: AbortSignal): Promise<void> => {
    const startedAt = now();
    const [callback] = await set(claimFeishuChatDelivery$, callbackId, signal);
    if (!callback) {
      return;
    }
    const delivery = await set(tryFeishuChatDelivery$, callback, signal);
    return await set(
      completeFeishuChatDelivery$,
      { callbackId, runId: callback.runId, startedAt },
      delivery,
    );
  },
);
