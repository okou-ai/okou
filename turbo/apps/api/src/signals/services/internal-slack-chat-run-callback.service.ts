import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { slackChatThreadRoutes } from "@okouai/db/schema/slack-chat-thread-route";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { agents } from "@okouai/db/schema/agent";
import { and, countDistinct, eq, isNotNull } from "drizzle-orm";
import { buildAgentResponseMessage } from "../../lib/slack-blocks";
import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { chatEventTypeIn } from "./chat-event-type.service";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { createSlackClient } from "../external/slack-message-client";
import { now, nowDate } from "../../lib/time";
import { settleIncludingAbort } from "../utils";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { resolveIntegrationAgentResponsePresentation } from "./integration-agent-response-presentation.service";
import { slackChatCallbackPayloadSchema } from "./slack-chat-callback-payload";

const L = logger("InternalCallbacksSlackChat");

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

async function claimSlackChatDelivery(
  db: Db,
  callbackId: string,
): Promise<ClaimedSlackChatDelivery | undefined> {
  const [callback] = await db
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
  return callback;
}

async function loadSlackChatDeliveryContext(
  args: {
    readonly db: Db;
    readonly callback: ClaimedSlackChatDelivery;
  },
  signal: AbortSignal,
) {
  const payload = slackChatCallbackPayloadSchema.parse(args.callback.payload);
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
        eq(agentRuns.triggerSource, "slack"),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!run?.chatThreadId) {
    throw new Error("Slack chat delivery run context is unavailable");
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
  const messageContent = event?.content;
  if (!messageContent) {
    throw new Error("Slack chat delivery message is unavailable");
  }

  const [binding] = await args.db
    .select({
      slackUserId: slackOrgConnections.slackUserId,
      workspaceId: slackOrgConnections.slackWorkspaceId,
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
        slackOrgConnections.slackWorkspaceId,
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
        eq(slackOrgInstallations.orgId, run.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return { payload, run, messageContent, binding };
}

async function countCanonicalSlackMentioners(args: {
  readonly db: Db;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadTs: string;
}): Promise<number> {
  const [row] = await args.db
    .select({ count: countDistinct(slackChatThreadRoutes.connectionId) })
    .from(slackChatThreadRoutes)
    .innerJoin(
      slackOrgConnections,
      eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
    )
    .where(
      and(
        eq(slackOrgConnections.slackWorkspaceId, args.workspaceId),
        eq(slackChatThreadRoutes.channelId, args.channelId),
        eq(slackChatThreadRoutes.threadTs, args.threadTs),
      ),
    );
  return row?.count ?? 0;
}

async function deliverClaimedSlackChatCallback(
  args: {
    readonly db: Db;
    readonly callback: ClaimedSlackChatDelivery;
  },
  signal: AbortSignal,
): Promise<"delivered" | "skipped_revoked"> {
  const { payload, run, messageContent, binding } =
    await loadSlackChatDeliveryContext(args, signal);
  if (!binding) {
    return "skipped_revoked";
  }

  const [mentionerCount, featureContext] = await Promise.all([
    countCanonicalSlackMentioners({
      db: args.db,
      workspaceId: binding.workspaceId,
      channelId: payload.channelId,
      threadTs: payload.routeThreadTs ?? payload.threadTs,
    }),
    loadUserFeatureSwitchContext(args.db, run.orgId, run.userId),
  ]);
  signal.throwIfAborted();
  const [botToken, presentation] = await Promise.all([
    decryptPersistentSecretValue(binding.encryptedBotToken, featureContext),
    resolveIntegrationAgentResponsePresentation(
      {
        db: args.db,
        orgId: run.orgId,
        userId: run.userId,
        runId: args.callback.runId,
        agentId: run.agentId,
        replyToMention:
          mentionerCount > 1 ? `<@${binding.slackUserId}>` : undefined,
        getFeatureOverrides: () => {
          return Promise.resolve(featureContext.overrides ?? {});
        },
      },
      signal,
    ),
  ]);
  signal.throwIfAborted();

  const postResult = await createSlackClient(botToken).postMessage(
    payload.channelId,
    messageContent,
    {
      threadTs: payload.threadTs,
      blocks: buildAgentResponseMessage(
        messageContent,
        presentation.footerText,
      ),
    },
  );
  if (postResult.kind === "slack_error") {
    throw new Error(`Slack API error: ${postResult.error}`);
  }
  return "delivered";
}

export async function dispatchSlackChatDeliveryOnce(
  db: Db,
  callbackId: string,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = now();
  signal.throwIfAborted();
  const callback = await claimSlackChatDelivery(db, callbackId);
  if (!callback) {
    return;
  }

  const delivery = await settleIncludingAbort(
    deliverClaimedSlackChatCallback(
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
    L.warn("Canonical Slack delivery failed", {
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
    L.debug("Skipped canonical Slack delivery after binding revocation", {
      callbackId,
      runId: callback.runId,
    });
  }
}

export async function deliverSlackChatAdmissionFailure(
  args: {
    readonly db: Db;
    readonly chatThreadId: string;
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly channelId: string;
    readonly threadTs: string;
    readonly routeThreadTs?: string;
    readonly chatEventId: string;
  },
  signal: AbortSignal,
): Promise<void> {
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
      .select({
        slackUserId: slackOrgConnections.slackUserId,
        workspaceId: slackOrgConnections.slackWorkspaceId,
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
          slackOrgConnections.slackWorkspaceId,
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
          eq(slackOrgInstallations.orgId, args.orgId),
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

  const [mentionerCount, featureContext, orgRows, agentRows] =
    await Promise.all([
      countCanonicalSlackMentioners({
        db: args.db,
        workspaceId: binding.workspaceId,
        channelId: args.channelId,
        threadTs: args.routeThreadTs ?? args.threadTs,
      }),
      loadUserFeatureSwitchContext(args.db, args.orgId, args.userId),
      args.db
        .select({ defaultAgentId: orgMetadata.defaultAgentId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, args.orgId))
        .limit(1),
      args.db
        .select({ displayName: agents.displayName, name: agents.name })
        .from(agents)
        .where(eq(agents.id, args.agentId))
        .limit(1),
    ]);
  signal.throwIfAborted();
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
    featureContext,
  );
  signal.throwIfAborted();
  const result = await createSlackClient(botToken).postMessage(
    args.channelId,
    event.content,
    {
      threadTs: args.threadTs,
      blocks: buildAgentResponseMessage(
        event.content,
        footerParts.length > 0 ? footerParts.join(" · ") : undefined,
      ),
    },
  );
  if (result.kind === "slack_error") {
    throw new Error(`Slack API error: ${result.error}`);
  }
}
