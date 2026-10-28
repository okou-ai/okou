import { teamsDeliveryAccess$ } from "./teams-delivery-access.service";
import { teamsAccountOwnerCondition } from "./teams-workspace-identity.service";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { teamsChatThreadRoutes } from "@okouai/db/schema/teams-chat-thread-route";
import { teamsOrgConnections } from "@okouai/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { agents } from "@okouai/db/schema/agent";
import { and, countDistinct, eq, isNotNull } from "drizzle-orm";
import { logger } from "../../lib/log";
import { command } from "ccstate";
import { db$, writeDb$ } from "../external/db";
import { getRunModelDisplayName } from "@okouai/core/model-display-name";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import {
  deleteTeamsReaction,
  sendTeamsMessageReply,
} from "../external/teams-bot-client";
import { now, nowDate } from "../../lib/time";
import { settleIncludingAbort } from "../utils";
import { integrationAgentResponsePresentation } from "./integration-agent-response-presentation.service";
import {
  runModelSelectionColumns,
  runModelSelectionCondition,
  runModelSelectionFromRow,
} from "./run-model-selection.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import {
  teamsChatCallbackPayloadSchema,
  type TeamsDeliveryTarget,
} from "./teams-chat-callback-payload";

const L = logger("InternalCallbacksTeamsChat");
const TEAMS_THINKING_REACTION_TYPE = "1f4ad_thoughtballoon";

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
  readonly runId: string;
  readonly payload: unknown;
}

const loadTeamsChatDeliveryContext$ = command(
  async (
    { get },
    args: {
      readonly callback: ClaimedTeamsChatDelivery;
    },
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const payload = teamsChatCallbackPayloadSchema.parse(args.callback.payload);
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
          eq(agentRuns.triggerSource, "teams"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!run?.chatThreadId) {
      throw new Error("Teams chat delivery run context is unavailable");
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
      throw new Error("Teams chat delivery message is unavailable");
    }

    const [binding] = await db
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
          eq(teamsChatThreadRoutes.chatThreadId, run.chatThreadId),
          eq(teamsChatThreadRoutes.conversationId, payload.conversationId),
          eq(teamsChatThreadRoutes.threadId, payload.threadId),
          eq(teamsChatThreadRoutes.userId, run.userId),
          eq(teamsChatThreadRoutes.connectionId, payload.connectionId),
          eq(teamsOrgConnections.userId, run.userId),
          eq(teamsOrgConnections.teamsTenantId, payload.tenantId),
          teamsAccountOwnerCondition({ orgId: run.orgId, userId: run.userId }),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return { payload, run, messageContent: event.content, binding };
  },
);

function buildTeamsResponseText(args: {
  readonly mainText: string;
  readonly footerText: string | undefined;
}): string {
  return [args.mainText, args.footerText ? `_${args.footerText}_` : undefined]
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

const readTeamsResponsePresentation$ = command(
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
        signal.throwIfAborted();
        if (args.agentId === org?.defaultAgentId) {
          return undefined;
        }
        const [agent] = await db
          .select({ displayName: agents.displayName, name: agents.name })
          .from(agents)
          .where(eq(agents.id, args.agentId))
          .limit(1);
        signal.throwIfAborted();
        return agent?.displayName ?? agent?.name;
      })(),
      (async () => {
        const [row] = await db
          .select(runModelSelectionColumns())
          .from(agentRuns)
          .where(runModelSelectionCondition(args.runId))
          .limit(1);
        signal.throwIfAborted();
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

const deliverClaimedTeamsChatCallback$ = command(
  async (
    { get, set },
    args: {
      readonly callback: ClaimedTeamsChatDelivery;
    },
    signal: AbortSignal,
  ): Promise<"delivered" | "skipped_revoked"> => {
    const db = get(db$);
    const { payload, run, messageContent, binding } = await set(
      loadTeamsChatDeliveryContext$,
      args,
      signal,
    );
    if (!binding) {
      return "skipped_revoked";
    }

    const mentionerCount = await (async () => {
      const tenantId = payload.tenantId;
      const conversationId = payload.conversationId;
      const threadId = payload.threadId;
      const [row] = await db
        .select({ count: countDistinct(teamsChatThreadRoutes.connectionId) })
        .from(teamsChatThreadRoutes)
        .innerJoin(
          teamsOrgConnections,
          eq(teamsOrgConnections.id, teamsChatThreadRoutes.connectionId),
        )
        .where(
          and(
            eq(teamsOrgConnections.teamsTenantId, tenantId),
            eq(teamsChatThreadRoutes.conversationId, conversationId),
            eq(teamsChatThreadRoutes.threadId, threadId),
          ),
        );
      return row?.count ?? 0;
    })();
    signal.throwIfAborted();
    const replyTo =
      payload.teamsUserDisplayName ??
      payload.teamsUserPrincipalName ??
      payload.teamsUserId;
    const presentation = await set(
      readTeamsResponsePresentation$,
      {
        orgId: run.orgId,
        runId: args.callback.runId,
        agentId: run.agentId,
        replyToMention:
          payload.conversationType !== "personal" && mentionerCount > 1
            ? replyTo
            : undefined,
      },
      signal,
    );
    signal.throwIfAborted();

    if (
      !(await set(
        teamsDeliveryAccess$,
        { ...payload, orgId: run.orgId, userId: run.userId },
        signal,
      ))
    ) {
      return "skipped_revoked";
    }
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
  },
);

/** Return the claimed outcome so cancellation cannot strand an attempted delivery. */
const claimTeamsChatDelivery$ = command(
  async (
    { set },
    callbackId: string,
    signal: AbortSignal,
  ): Promise<readonly ClaimedTeamsChatDelivery[]> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    return await db
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
        runId: agentRunCallbacks.runId,
        payload: agentRunCallbacks.payload,
      });
  },
);

const tryTeamsChatDelivery$ = command(
  ({ set }, callback: ClaimedTeamsChatDelivery, signal: AbortSignal) => {
    return settleIncludingAbort(
      set(deliverClaimedTeamsChatCallback$, { callback }, signal),
    );
  },
);

/** Finalization remains awaited even when the provider delivery was aborted. */
const completeTeamsChatDelivery$ = command(
  async (
    { set },
    args: {
      readonly callbackId: string;
      readonly runId: string;
      readonly startedAt: number;
    },
    delivery: Awaited<ReturnType<typeof tryTeamsChatDelivery$.write>>,
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
      L.warn("Canonical Teams delivery failed", {
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
      L.debug("Skipped canonical Teams delivery after binding revocation", {
        callbackId: args.callbackId,
        runId: args.runId,
      });
    }
  },
);

export const dispatchTeamsChatDeliveryOnce$ = command(
  async ({ set }, callbackId: string, signal: AbortSignal): Promise<void> => {
    const startedAt = now();
    const [callback] = await set(claimTeamsChatDelivery$, callbackId, signal);
    if (!callback) {
      return;
    }
    const delivery = await set(tryTeamsChatDelivery$, callback, signal);
    return await set(
      completeTeamsChatDelivery$,
      { callbackId, runId: callback.runId, startedAt },
      delivery,
    );
  },
);

interface TeamsChatAdmissionFailureArgs {
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

const loadTeamsAdmissionFailureContext$ = command(
  async (
    { get },
    args: TeamsChatAdmissionFailureArgs,
    signal: AbortSignal,
  ): Promise<TeamsAdmissionFailureContext | undefined> => {
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
            eq(teamsChatThreadRoutes.chatThreadId, args.chatThreadId),
            eq(teamsChatThreadRoutes.connectionId, args.target.connectionId),
            eq(
              teamsChatThreadRoutes.conversationId,
              args.target.conversationId,
            ),
            eq(teamsChatThreadRoutes.threadId, args.target.threadId),
            eq(teamsChatThreadRoutes.userId, args.userId),
            eq(teamsOrgConnections.userId, args.userId),
            eq(teamsOrgConnections.teamsTenantId, args.target.tenantId),
            teamsAccountOwnerCondition({
              orgId: args.orgId,
              userId: args.userId,
            }),
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
  },
);

interface TeamsAdmissionFailurePresentation {
  readonly footerText: string | undefined;
}

const resolveTeamsAdmissionFailurePresentation$ = command(
  async (
    { get },
    args: TeamsChatAdmissionFailureArgs,
    signal: AbortSignal,
  ): Promise<TeamsAdmissionFailurePresentation> => {
    const db = get(db$);
    const [mentionerCount, orgRows, agentRows] = await Promise.all([
      (async () => {
        const tenantId = args.target.tenantId;
        const conversationId = args.target.conversationId;
        const threadId = args.target.threadId;
        const [row] = await db
          .select({ count: countDistinct(teamsChatThreadRoutes.connectionId) })
          .from(teamsChatThreadRoutes)
          .innerJoin(
            teamsOrgConnections,
            eq(teamsOrgConnections.id, teamsChatThreadRoutes.connectionId),
          )
          .where(
            and(
              eq(teamsOrgConnections.teamsTenantId, tenantId),
              eq(teamsChatThreadRoutes.conversationId, conversationId),
              eq(teamsChatThreadRoutes.threadId, threadId),
            ),
          );
        return row?.count ?? 0;
      })(),
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
    return {
      footerText: footerParts.length > 0 ? footerParts.join(" · ") : undefined,
    };
  },
);

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

export const deliverTeamsChatAdmissionFailure$ = command(
  async (
    { set },
    args: TeamsChatAdmissionFailureArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const context = await set(loadTeamsAdmissionFailureContext$, args, signal);
    if (!context) {
      return;
    }
    if (
      !(await set(
        teamsDeliveryAccess$,
        { ...args.target, orgId: args.orgId, userId: args.userId },
        signal,
      ))
    ) {
      return;
    }
    const presentation = await set(
      resolveTeamsAdmissionFailurePresentation$,
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
  },
);
