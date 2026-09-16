import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { teamsChatThreadRoutes } from "@okouai/db/schema/teams-chat-thread-route";
import { teamsOrgConnections } from "@okouai/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { agents } from "@okouai/db/schema/agent";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { and, countDistinct, eq, isNotNull } from "drizzle-orm";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import {
  deleteTeamsReaction,
  sendTeamsMessageReply,
} from "../external/teams-bot-client";
import { now, nowDate } from "../../lib/time";
import { settleIncludingAbort } from "../utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { resolveIntegrationAgentResponsePresentation } from "./integration-agent-response-presentation.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import {
  teamsChatCallbackPayloadSchema,
  type TeamsDeliveryTarget,
} from "./teams-chat-callback-payload";
import { snapshotIntegrationReply } from "./integration-artifact-reply.service";

const L = logger("InternalCallbacksTeamsChat");
const TEAMS_THINKING_REACTION_TYPE = "1f4ad_thoughtballoon";

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
    actionType: "teams_chat_delivery",
    durationMs: Math.max(0, now() - args.startedAt),
    success: args.success,
    runId: args.runId,
    dimensions: { outcome: args.outcome },
  });
}

interface ClaimedTeamsChatDelivery {
  readonly id: string;
  readonly runId: string;
  readonly payload: unknown;
}

async function claimTeamsChatDelivery(
  db: Db,
  callbackId: string,
): Promise<ClaimedTeamsChatDelivery | undefined> {
  const [callback] = await db
    .update(agentRunCallbacks)
    .set({ attempts: 1, lastAttemptAt: nowDate() })
    .where(
      and(
        eq(agentRunCallbacks.id, callbackId),
        eq(agentRunCallbacks.internalKind, "teams:chat"),
        eq(agentRunCallbacks.status, "pending"),
        eq(agentRunCallbacks.attempts, 0),
      ),
    )
    .returning({
      id: agentRunCallbacks.id,
      runId: agentRunCallbacks.runId,
      payload: agentRunCallbacks.payload,
    });
  return callback;
}

async function loadTeamsChatDeliveryContext(
  args: {
    readonly db: Db;
    readonly callback: ClaimedTeamsChatDelivery;
  },
  signal: AbortSignal,
) {
  const payload = teamsChatCallbackPayloadSchema.parse(args.callback.payload);
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
        eq(agentRuns.triggerSource, "teams"),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!run?.chatThreadId) {
    throw new Error("Teams chat delivery run context is unavailable");
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
    throw new Error("Teams chat delivery message is unavailable");
  }

  const [binding] = await args.db
    .select({
      serviceUrl: teamsOrgInstallations.serviceUrl,
    })
    .from(teamsChatThreadRoutes)
    .innerJoin(
      teamsOrgConnections,
      eq(teamsOrgConnections.id, teamsChatThreadRoutes.connectionId),
    )
    .innerJoin(
      teamsOrgInstallations,
      eq(
        teamsOrgInstallations.teamsTenantId,
        teamsOrgConnections.teamsTenantId,
      ),
    )
    .where(
      and(
        eq(teamsChatThreadRoutes.conversationId, payload.conversationId),
        eq(teamsChatThreadRoutes.threadId, payload.threadId),
        eq(teamsChatThreadRoutes.userId, run.userId),
        eq(teamsChatThreadRoutes.connectionId, payload.connectionId),
        eq(teamsOrgConnections.userId, run.userId),
        eq(teamsOrgConnections.teamsTenantId, payload.tenantId),
        eq(teamsOrgInstallations.orgId, run.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return { payload, run, messageContent: event.content, binding };
}

async function countTeamsMentioners(args: {
  readonly db: Db;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly threadId: string;
}): Promise<number> {
  const [row] = await args.db
    .select({ count: countDistinct(teamsChatThreadRoutes.connectionId) })
    .from(teamsChatThreadRoutes)
    .innerJoin(
      teamsOrgConnections,
      eq(teamsOrgConnections.id, teamsChatThreadRoutes.connectionId),
    )
    .where(
      and(
        eq(teamsOrgConnections.teamsTenantId, args.tenantId),
        eq(teamsChatThreadRoutes.conversationId, args.conversationId),
        eq(teamsChatThreadRoutes.threadId, args.threadId),
      ),
    );
  return row?.count ?? 0;
}

function buildTeamsResponseText(args: {
  readonly mainText: string;
  readonly logsUrl: string | undefined;
  readonly footerText: string | undefined;
}): string {
  return [
    args.mainText,
    args.logsUrl ? `[Audit](${args.logsUrl})` : undefined,
    args.footerText ? `_${args.footerText}_` : undefined,
  ]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
}

async function clearTeamsThinkingReaction(
  args: {
    readonly payload: TeamsDeliveryTarget;
    readonly serviceUrl: string;
  },
  signal: AbortSignal,
): Promise<void> {
  if (
    args.payload.conversationType === "personal" ||
    !args.payload.activityId
  ) {
    return;
  }

  const cleared = await settleIncludingAbort(
    deleteTeamsReaction(
      {
        serviceUrl: args.serviceUrl,
        conversationId: args.payload.conversationId,
        activityId: args.payload.activityId,
        tenantId: args.payload.tenantId,
        reactionType: TEAMS_THINKING_REACTION_TYPE,
      },
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!cleared.ok) {
    L.warn("Failed to clear canonical Teams thinking reaction", {
      conversationId: args.payload.conversationId,
      activityId: args.payload.activityId,
      error: cleared.error,
    });
    return;
  }
  if (cleared.value.kind === "teams-error") {
    L.warn("Failed to clear canonical Teams thinking reaction", {
      conversationId: args.payload.conversationId,
      activityId: args.payload.activityId,
      error: cleared.value.error,
    });
  }
}

async function deliverClaimedTeamsChatCallback(
  args: {
    readonly db: Db;
    readonly callback: ClaimedTeamsChatDelivery;
  },
  signal: AbortSignal,
): Promise<"delivered" | "skipped_revoked"> {
  const {
    payload,
    run,
    messageContent: sourceContent,
    binding,
  } = await loadTeamsChatDeliveryContext(args, signal);
  if (!binding) {
    return "skipped_revoked";
  }
  const messageContent = await snapshotIntegrationReply(
    {
      db: args.db,
      runId: args.callback.runId,
      deliveryKey: `callback:${args.callback.id}`,
      publicBrand: payload.publicBrand,
      content: sourceContent,
    },
    signal,
  );

  const [mentionerCount, featureContext] = await Promise.all([
    countTeamsMentioners({
      db: args.db,
      tenantId: payload.tenantId,
      conversationId: payload.conversationId,
      threadId: payload.threadId,
    }),
    loadUserFeatureSwitchContext(args.db, run.orgId, run.userId),
  ]);
  signal.throwIfAborted();
  const replyTo =
    payload.teamsUserDisplayName ??
    payload.teamsUserPrincipalName ??
    payload.teamsUserId;
  const presentation = await resolveIntegrationAgentResponsePresentation(
    {
      db: args.db,
      orgId: run.orgId,
      userId: run.userId,
      runId: args.callback.runId,
      agentId: run.agentId,
      replyToMention:
        payload.conversationType !== "personal" && mentionerCount > 1
          ? replyTo
          : undefined,
      getFeatureOverrides: () => {
        return Promise.resolve(featureContext.overrides ?? {});
      },
    },
    signal,
  );
  signal.throwIfAborted();

  const serviceUrl = payload.serviceUrl.trim() || binding.serviceUrl || "";
  if (!serviceUrl) {
    throw new Error("Microsoft Teams serviceUrl is missing");
  }
  const result = await sendTeamsMessageReply(
    {
      serviceUrl,
      conversationId: payload.conversationId,
      activityId: payload.activityId ?? undefined,
      tenantId: payload.tenantId,
      text: buildTeamsResponseText({
        mainText: messageContent,
        logsUrl: presentation.logsUrl,
        footerText: presentation.footerText,
      }),
    },
    signal,
  );
  signal.throwIfAborted();
  await clearTeamsThinkingReaction(
    {
      payload,
      serviceUrl,
    },
    signal,
  );
  if (result.kind === "teams-error") {
    throw new Error(`Microsoft Teams API error: ${result.error}`);
  }
  return "delivered";
}

export async function dispatchTeamsChatDeliveryOnce(
  db: Db,
  callbackId: string,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = now();
  signal.throwIfAborted();
  const callback = await claimTeamsChatDelivery(db, callbackId);
  if (!callback) {
    return;
  }

  const delivery = await settleIncludingAbort(
    deliverClaimedTeamsChatCallback(
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
    L.warn("Canonical Teams delivery failed", {
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
    L.debug("Skipped canonical Teams delivery after binding revocation", {
      callbackId,
      runId: callback.runId,
    });
  }
}

interface TeamsChatAdmissionFailureArgs {
  readonly db: Db;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly target: TeamsDeliveryTarget;
  readonly chatEventId: string;
}

interface TeamsAdmissionFailureContext {
  readonly messageContent: string;
  readonly installationServiceUrl: string | null;
}

async function loadTeamsAdmissionFailureContext(
  args: TeamsChatAdmissionFailureArgs,
  signal: AbortSignal,
): Promise<TeamsAdmissionFailureContext | undefined> {
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
        serviceUrl: teamsOrgInstallations.serviceUrl,
      })
      .from(teamsChatThreadRoutes)
      .innerJoin(
        teamsOrgConnections,
        eq(teamsOrgConnections.id, teamsChatThreadRoutes.connectionId),
      )
      .innerJoin(
        teamsOrgInstallations,
        eq(
          teamsOrgInstallations.teamsTenantId,
          teamsOrgConnections.teamsTenantId,
        ),
      )
      .where(
        and(
          eq(teamsChatThreadRoutes.connectionId, args.target.connectionId),
          eq(teamsChatThreadRoutes.conversationId, args.target.conversationId),
          eq(teamsChatThreadRoutes.threadId, args.target.threadId),
          eq(teamsChatThreadRoutes.userId, args.userId),
          eq(teamsOrgConnections.userId, args.userId),
          eq(teamsOrgConnections.teamsTenantId, args.target.tenantId),
          eq(teamsOrgInstallations.orgId, args.orgId),
        ),
      )
      .limit(1),
  ]);
  signal.throwIfAborted();
  const event = eventRows[0];
  const binding = bindingRows[0];
  if (!event?.content || !binding) {
    return undefined;
  }
  return {
    messageContent: event.content,
    installationServiceUrl: binding.serviceUrl,
  };
}

interface TeamsAdmissionFailurePresentation {
  readonly logsUrl: string | undefined;
  readonly footerText: string | undefined;
}

async function resolveTeamsAdmissionFailurePresentation(
  args: TeamsChatAdmissionFailureArgs,
  signal: AbortSignal,
): Promise<TeamsAdmissionFailurePresentation> {
  const [mentionerCount, featureContext, orgRows, agentRows] =
    await Promise.all([
      countTeamsMentioners({
        db: args.db,
        tenantId: args.target.tenantId,
        conversationId: args.target.conversationId,
        threadId: args.target.threadId,
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

  const footerParts: string[] = [];
  const agentLabel = agentRows[0]?.displayName ?? agentRows[0]?.name;
  if (agentLabel && args.agentId !== orgRows[0]?.defaultAgentId) {
    footerParts.push(`Sent via ${agentLabel}`);
  }
  if (args.target.conversationType !== "personal" && mentionerCount > 1) {
    footerParts.push(
      `Reply to ${
        args.target.teamsUserDisplayName ??
        args.target.teamsUserPrincipalName ??
        args.target.teamsUserId
      }`,
    );
  }
  const logsUrl = isFeatureEnabled(FeatureSwitchKey.OkouDebug, featureContext)
    ? `${env("APP_URL")}/activities`
    : undefined;
  return {
    logsUrl,
    footerText: footerParts.length > 0 ? footerParts.join(" · ") : undefined,
  };
}

async function clearTeamsAdmissionThinkingReaction(
  args: {
    readonly target: TeamsDeliveryTarget;
    readonly serviceUrl: string;
  },
  signal: AbortSignal,
): Promise<void> {
  if (args.target.conversationType === "personal" || !args.target.activityId) {
    return;
  }
  const clearResult = await deleteTeamsReaction(
    {
      serviceUrl: args.serviceUrl,
      conversationId: args.target.conversationId,
      activityId: args.target.activityId,
      tenantId: args.target.tenantId,
      reactionType: TEAMS_THINKING_REACTION_TYPE,
    },
    signal,
  );
  signal.throwIfAborted();
  if (clearResult.kind === "teams-error") {
    L.warn("Failed to clear Teams admission thinking reaction", {
      conversationId: args.target.conversationId,
      activityId: args.target.activityId,
      error: clearResult.error,
    });
  }
}

export async function deliverTeamsChatAdmissionFailure(
  args: TeamsChatAdmissionFailureArgs,
  signal: AbortSignal,
): Promise<void> {
  const context = await loadTeamsAdmissionFailureContext(args, signal);
  if (!context) {
    return;
  }
  const presentation = await resolveTeamsAdmissionFailurePresentation(
    args,
    signal,
  );
  const serviceUrl =
    args.target.serviceUrl.trim() || context.installationServiceUrl || "";
  if (!serviceUrl) {
    throw new Error("Microsoft Teams serviceUrl is missing");
  }
  const result = await sendTeamsMessageReply(
    {
      serviceUrl,
      conversationId: args.target.conversationId,
      activityId: args.target.activityId ?? undefined,
      tenantId: args.target.tenantId,
      text: buildTeamsResponseText({
        mainText: context.messageContent,
        logsUrl: presentation.logsUrl,
        footerText: presentation.footerText,
      }),
    },
    signal,
  );
  signal.throwIfAborted();
  await clearTeamsAdmissionThinkingReaction(
    {
      target: args.target,
      serviceUrl,
    },
    signal,
  );
  if (result.kind === "teams-error") {
    throw new Error(`Microsoft Teams API error: ${result.error}`);
  }
}
