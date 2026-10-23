import {
  featureSwitchContextFromRows,
  userFeatureSwitchRowCondition,
} from "./feature-switch-scope";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { slackChatThreadRoutes } from "@okouai/db/schema/slack-chat-thread-route";
import { slackChatIngress } from "@okouai/db/schema/slack-chat-ingress";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { agents } from "@okouai/db/schema/agent";
import {
  and,
  countDistinct,
  eq,
  exists,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import { buildAgentResponseMessage } from "../../lib/slack-blocks";
import { logger } from "../../lib/log";
import { command } from "ccstate";
import { db$, writeDb$ } from "../external/db";
import { getRunModelDisplayName } from "@okouai/core/model-display-name";
import { chatEventTypeIn } from "./chat-event-type.service";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { createSlackClient } from "../external/slack-message-client";
import { now, nowDate } from "../../lib/time";
import { settleIncludingAbort } from "../utils";
import { decryptPersistentSecretValue } from "./crypto.utils";

import { integrationAgentResponsePresentation } from "./integration-agent-response-presentation.service";
import {
  runModelSelectionColumns,
  runModelSelectionCondition,
  runModelSelectionFromRow,
} from "./run-model-selection.service";
import { slackChatCallbackPayloadSchema } from "./slack-chat-callback-payload";

const L = logger("InternalCallbacksSlackChat");

const markDelivered$ = command(
  async ({ set }, callbackId: string): Promise<void> => {
    const db = set(writeDb$);
    await db
      .update(agentRunCallbacks)
      .set({ status: "delivered", deliveredAt: nowDate() })
      .where(eq(agentRunCallbacks.id, callbackId));
  },
);

const markFailed$ = command(
  async ({ set }, callbackId: string, error: string): Promise<void> => {
    const db = set(writeDb$);
    await db
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
    actionType: "slack_chat_delivery",
    durationMs: Math.max(0, now() - args.startedAt),
    success: args.success,
    runId: args.runId,
    dimensions: { outcome: args.outcome },
  });
}

interface ClaimedSlackChatDelivery {
  readonly runId: string;
  readonly payload: unknown;
}

const claimSlackChatDelivery$ = command(
  async (
    { set },
    callbackId: string,
    signal: AbortSignal,
  ): Promise<readonly ClaimedSlackChatDelivery[]> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    return await db
      .update(agentRunCallbacks)
      .set({ attempts: 1, lastAttemptAt: nowDate() })
      .where(
        and(
          eq(agentRunCallbacks.id, callbackId),
          eq(agentRunCallbacks.internalKind, "slack:chat"),
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

const loadSlackChatDeliveryContext$ = command(
  async (
    { get },
    args: {
      readonly callback: ClaimedSlackChatDelivery;
    },
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const payload = slackChatCallbackPayloadSchema.parse(args.callback.payload);
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
          eq(agentRuns.triggerSource, "slack"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!run?.chatThreadId) {
      throw new Error("Slack chat delivery run context is unavailable");
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
    const messageContent = event?.content;
    if (!messageContent) {
      throw new Error("Slack chat delivery message is unavailable");
    }

    const [binding] = await db
      .select({
        slackUserId: slackOrgConnections.slackUserId,
        workspaceId: slackOrgInstallations.slackWorkspaceId,
        installationOrgId: slackOrgInstallations.orgId,
        encryptedBotToken: slackOrgInstallations.encryptedBotToken,
      })
      .from(slackChatThreadRoutes)
      .innerJoin(
        slackOrgConnections,
        eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
      )
      .innerJoin(
        slackOrgInstallations,
        eq(
          slackOrgInstallations.slackWorkspaceId,
          payload.workspaceId ?? slackOrgConnections.slackWorkspaceId,
        ),
      )
      .where(
        and(
          eq(slackChatThreadRoutes.chatThreadId, run.chatThreadId),
          eq(slackChatThreadRoutes.channelId, payload.channelId),
          eq(
            slackChatThreadRoutes.threadTs,
            payload.routeThreadTs ?? payload.threadTs,
          ),
          eq(slackChatThreadRoutes.userId, run.userId),
          eq(slackOrgConnections.userId, run.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return { payload, run, messageContent, binding };
  },
);

const countCanonicalSlackMentioners$ = command(
  async (
    { get },
    args: {
      readonly workspaceId: string;
      readonly channelId: string;
      readonly threadTs: string;
    },
  ): Promise<number> => {
    const db = get(db$);
    const [row] = await db
      .select({ count: countDistinct(slackChatThreadRoutes.connectionId) })
      .from(slackChatThreadRoutes)
      .innerJoin(
        slackOrgConnections,
        eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
      )
      .where(
        and(
          eq(slackChatThreadRoutes.channelId, args.channelId),
          eq(slackChatThreadRoutes.threadTs, args.threadTs),
          or(
            eq(slackOrgConnections.slackWorkspaceId, args.workspaceId),
            exists(
              db
                .select({ id: slackChatIngress.id })
                .from(slackChatIngress)
                .where(
                  and(
                    eq(slackChatIngress.routeId, slackChatThreadRoutes.id),
                    sql`${slackChatIngress.payload}::jsonb ->> 'team_id' = ${args.workspaceId}`,
                  ),
                ),
            ),
          ),
        ),
      );
    return row?.count ?? 0;
  },
);

const readSlackResponsePresentation$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly runId: string;
      readonly agentId: string;
      readonly replyToMention?: string;
    },
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const [agentLabel, runModel] = await Promise.all([
      (async () => {
        const [org] = await db
          .select({ defaultAgentId: orgMetadata.defaultAgentId })
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, args.orgId))
          .limit(1);
        if (args.agentId === org?.defaultAgentId) {
          return undefined;
        }
        const [agent] = await db
          .select({ displayName: agents.displayName, name: agents.name })
          .from(agents)
          .where(eq(agents.id, args.agentId))
          .limit(1);
        return agent?.displayName ?? agent?.name;
      })(),
      (async () => {
        const [row] = await db
          .select(runModelSelectionColumns())
          .from(agentRuns)
          .where(runModelSelectionCondition(args.runId))
          .limit(1);
        return runModelSelectionFromRow(row);
      })(),
    ]);
    signal.throwIfAborted();
    return integrationAgentResponsePresentation({
      agentLabel,
      modelLabel: runModel?.selectedModel
        ? getRunModelDisplayName(
            runModel.selectedModel,
            runModel.codexServiceTier,
          )
        : undefined,
      replyToMention: args.replyToMention,
    });
  },
);

/** Preserve the provider's actual result after the final cancellation checkpoint. */
const postSlackChatMessage$ = command(
  async (
    _,
    args: {
      readonly botToken: string;
      readonly channelId: string;
      readonly content: string;
      readonly threadTs: string;
      readonly footerText: string | undefined;
    },
  ): Promise<"delivered"> => {
    const result = await createSlackClient(args.botToken).postMessage(
      args.channelId,
      args.content,
      {
        threadTs: args.threadTs,
        blocks: buildAgentResponseMessage(args.content, args.footerText),
      },
    );
    if (result.kind === "slack_error") {
      throw new Error(`Slack API error: ${result.error}`);
    }
    return "delivered";
  },
);

const deliverClaimedSlackChatCallback$ = command(
  async (
    { get, set },
    args: {
      readonly callback: ClaimedSlackChatDelivery;
    },
    signal: AbortSignal,
  ): Promise<"delivered" | "skipped_revoked"> => {
    const db = get(db$);
    const { payload, run, messageContent, binding } = await set(
      loadSlackChatDeliveryContext$,
      args,
      signal,
    );
    if (!binding) {
      return "skipped_revoked";
    }

    const [mentionerCount, featureSwitchContextRows0] = await Promise.all([
      set(countCanonicalSlackMentioners$, {
        workspaceId: binding.workspaceId,
        channelId: payload.channelId,
        threadTs: payload.routeThreadTs ?? payload.threadTs,
      }),
      db
        .select({
          userId: userFeatureSwitches.userId,
          switches: userFeatureSwitches.switches,
        })
        .from(userFeatureSwitches)
        .where(
          userFeatureSwitchRowCondition(
            binding.installationOrgId ?? run.orgId,
            run.userId,
          ),
        ),
    ]);
    signal.throwIfAborted();
    const featureContext = featureSwitchContextFromRows(
      binding.installationOrgId ?? run.orgId,
      run.userId,
      featureSwitchContextRows0,
    );
    const [botToken, presentation] = await Promise.all([
      decryptPersistentSecretValue(
        binding.encryptedBotToken,
        binding.installationOrgId ? featureContext : {},
      ),
      set(
        readSlackResponsePresentation$,
        {
          orgId: run.orgId,
          runId: args.callback.runId,
          agentId: run.agentId,
          replyToMention:
            mentionerCount > 1 ? `<@${binding.slackUserId}>` : undefined,
        },
        signal,
      ),
    ]);
    signal.throwIfAborted();

    return await set(postSlackChatMessage$, {
      botToken,
      channelId: payload.channelId,
      content: messageContent,
      threadTs: payload.threadTs,
      footerText: presentation.footerText,
    });
  },
);

const trySlackChatDelivery$ = command(
  ({ set }, callback: ClaimedSlackChatDelivery, signal: AbortSignal) => {
    return settleIncludingAbort(
      set(deliverClaimedSlackChatCallback$, { callback }, signal),
    );
  },
);

/** A claimed callback must reach a terminal state even when delivery was aborted. */
const completeSlackChatDelivery$ = command(
  async (
    { set },
    args: {
      readonly callbackId: string;
      readonly runId: string;
      readonly startedAt: number;
    },
    delivery: Awaited<ReturnType<typeof trySlackChatDelivery$.write>>,
  ): Promise<void> => {
    if (!delivery.ok) {
      const message =
        delivery.error instanceof Error
          ? delivery.error.message
          : "Unknown error";
      await set(markFailed$, args.callbackId, message);
      recordDelivery({
        runId: args.runId,
        startedAt: args.startedAt,
        success: false,
        outcome: "failed",
      });
      L.warn("Canonical Slack delivery failed", {
        callbackId: args.callbackId,
        runId: args.runId,
        error: delivery.error,
      });
      return;
    }

    await set(markDelivered$, args.callbackId);
    recordDelivery({
      runId: args.runId,
      startedAt: args.startedAt,
      success: true,
      outcome: delivery.value,
    });
    if (delivery.value === "skipped_revoked") {
      L.debug("Skipped canonical Slack delivery after binding revocation", {
        callbackId: args.callbackId,
        runId: args.runId,
      });
    }
  },
);

export const dispatchSlackChatDeliveryOnce$ = command(
  async ({ set }, callbackId: string, signal: AbortSignal): Promise<void> => {
    const startedAt = now();
    const [callback] = await set(claimSlackChatDelivery$, callbackId, signal);
    if (!callback) {
      return;
    }
    const delivery = await set(trySlackChatDelivery$, callback, signal);
    return await set(
      completeSlackChatDelivery$,
      { callbackId, runId: callback.runId, startedAt },
      delivery,
    );
  },
);

export const deliverSlackChatAdmissionFailure$ = command(
  async (
    { get, set },
    args: {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
      readonly channelId: string;
      readonly threadTs: string;
      readonly routeThreadTs?: string;
      readonly workspaceId?: string;
      readonly chatEventId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
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
        .select({
          slackUserId: slackOrgConnections.slackUserId,
          workspaceId: slackOrgInstallations.slackWorkspaceId,
          installationOrgId: slackOrgInstallations.orgId,
          encryptedBotToken: slackOrgInstallations.encryptedBotToken,
        })
        .from(slackChatThreadRoutes)
        .innerJoin(
          slackOrgConnections,
          eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
        )
        .innerJoin(
          slackOrgInstallations,
          eq(
            slackOrgInstallations.slackWorkspaceId,
            args.workspaceId ?? slackOrgConnections.slackWorkspaceId,
          ),
        )
        .where(
          and(
            eq(slackChatThreadRoutes.chatThreadId, args.chatThreadId),
            eq(slackChatThreadRoutes.channelId, args.channelId),
            eq(
              slackChatThreadRoutes.threadTs,
              args.routeThreadTs ?? args.threadTs,
            ),
            eq(slackChatThreadRoutes.userId, args.userId),
            eq(slackOrgConnections.userId, args.userId),
          ),
        )
        .limit(1),
    ]);
    signal.throwIfAborted();
    const event = eventRows[0];
    const binding = bindingRows[0];
    if (!event?.content || !binding) {
      return;
    }

    const [mentionerCount, featureSwitchContextRows1, orgRows, agentRows] =
      await Promise.all([
        set(countCanonicalSlackMentioners$, {
          workspaceId: binding.workspaceId,
          channelId: args.channelId,
          threadTs: args.routeThreadTs ?? args.threadTs,
        }),
        db
          .select({
            userId: userFeatureSwitches.userId,
            switches: userFeatureSwitches.switches,
          })
          .from(userFeatureSwitches)
          .where(
            userFeatureSwitchRowCondition(
              binding.installationOrgId ?? args.orgId,
              args.userId,
            ),
          ),
        db
          .select({ defaultAgentId: orgMetadata.defaultAgentId })
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, args.orgId))
          .limit(1),
        db
          .select({ displayName: agents.displayName, name: agents.name })
          .from(agents)
          .where(eq(agents.id, args.agentId))
          .limit(1),
      ]);
    signal.throwIfAborted();
    const featureContext = featureSwitchContextFromRows(
      binding.installationOrgId ?? args.orgId,
      args.userId,
      featureSwitchContextRows1,
    );
    const org = orgRows[0];
    const agent = agentRows[0];

    const footerParts: string[] = [];
    const agentLabel = agent?.displayName ?? agent?.name;
    if (agentLabel && args.agentId !== org?.defaultAgentId) {
      footerParts.push(`Sent via ${agentLabel}`);
    }
    if (mentionerCount > 1) {
      footerParts.push(`Reply to <@${binding.slackUserId}>`);
    }
    const botToken = await decryptPersistentSecretValue(
      binding.encryptedBotToken,
      binding.installationOrgId ? featureContext : {},
    );
    signal.throwIfAborted();
    await set(postSlackChatMessage$, {
      botToken,
      channelId: args.channelId,
      content: event.content,
      threadTs: args.threadTs,
      footerText: footerParts.length > 0 ? footerParts.join(" · ") : undefined,
    });
  },
);
