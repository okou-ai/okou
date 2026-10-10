import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatSlackContext } from "@okouai/db/schema/chat-slack-context";
import { slackChatIngress } from "@okouai/db/schema/slack-chat-ingress";
import { slackChatThreadRoutes } from "@okouai/db/schema/slack-chat-thread-route";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { command } from "ccstate";
import { and, eq, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { createSlackClient } from "../external/slack-message-client";
import { tapError } from "../utils";
import { cancelRun$ } from "./agent-run-terminal-transition.service";
import {
  clearCanonicalSlackThreadStatusIfIdle$,
  refreshCanonicalSlackThreadStatus$,
} from "./canonical-slack-thread-status.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import {
  appendInterruptUserMessage$,
  appendRecallChatEvent$,
} from "./chat-events.command";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import {
  dispatchCancelSideEffects$,
  shouldDispatchCancelSideEffects,
} from "./run-cancel.service";

const L = logger("SlackSessionStop");
const stopQueueRevoker = alias(chatEvents, "slack_stop_queue_revoker");
const slackTimestamp = z.string().regex(/^\d{1,12}\.\d{1,6}$/);

export const slackSessionStoppedEventSchema = z.object({
  type: z.literal("agent_session_stopped"),
  channel: z.string().min(1),
  thread_ts: slackTimestamp,
  user: z.string().min(1),
  event_ts: slackTimestamp,
});

export type SlackSessionStoppedEvent = z.infer<
  typeof slackSessionStoppedEventSchema
>;

interface SlackSessionStopScope {
  readonly event: SlackSessionStoppedEvent;
  readonly userId: string;
  readonly orgId: string;
  readonly encryptedBotToken: string;
  readonly routes: readonly {
    readonly routeId: string;
    readonly routeThreadTs: string;
    readonly chatThreadId: string;
  }[];
}

function stoppedSlackContextScope(scope: SlackSessionStopScope) {
  return and(
    eq(chatEvents.contextType, "slack"),
    inArray(
      chatEvents.chatThreadId,
      scope.routes.map((route) => {
        return route.chatThreadId;
      }),
    ),
    eq(chatSlackContext.channelId, scope.event.channel),
    eq(chatSlackContext.threadTs, scope.event.thread_ts),
    sql`${chatSlackContext.messageTs}::numeric <= ${scope.event.event_ts}::numeric`,
  );
}

const stopSlackSessionInputs$ = command(
  async (
    { set },
    scope: SlackSessionStopScope,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const { event } = scope;
    // Stop admission first. The enqueue owner conditionally consumes this state,
    // so an enrichment already in flight cannot revive a stopped input.
    const stoppedIngress = await db
      .update(slackChatIngress)
      .set({
        status: "terminal",
        retryAt: null,
        lastErrorClass: "user_stopped",
        lastError: "Stopped by the Slack sender",
        updatedAt: nowDate(),
      })
      .where(
        and(
          inArray(
            slackChatIngress.routeId,
            scope.routes.map((route) => {
              return route.routeId;
            }),
          ),
          inArray(slackChatIngress.status, [
            "pending",
            "processing",
            "retryable",
          ]),
          sql`${slackChatIngress.payload}::jsonb -> 'event' ->> 'channel' = ${event.channel}`,
          sql`coalesce(${slackChatIngress.payload}::jsonb -> 'event' ->> 'thread_ts', ${slackChatIngress.payload}::jsonb -> 'event' ->> 'ts') = ${event.thread_ts}`,
          sql`(${slackChatIngress.payload}::jsonb -> 'event' ->> 'ts')::numeric <= ${event.event_ts}::numeric`,
        ),
      )
      .returning({ id: slackChatIngress.id });
    signal.throwIfAborted();
    let changed = stoppedIngress.length > 0;
    // Use Slack's event time, not delivery time: retries and delayed Stop events
    // must not recall messages the user sent after clicking Stop.
    const queued = await db
      .select({ id: chatEvents.id, chatThreadId: chatEvents.chatThreadId })
      .from(chatEvents)
      .innerJoin(
        chatSlackContext,
        eq(chatSlackContext.id, chatEvents.contextId),
      )
      .where(
        and(
          stoppedSlackContextScope(scope),
          chatEventTypeIn(["input.prompt"]),
          isNull(chatEvents.runId),
          notExists(
            db
              .select({ id: stopQueueRevoker.id })
              .from(stopQueueRevoker)
              .where(eq(stopQueueRevoker.revokesEventId, chatEvents.id)),
          ),
        ),
      );
    signal.throwIfAborted();
    for (const input of queued) {
      const recalled = await set(
        appendRecallChatEvent$,
        {
          threadId: input.chatThreadId,
          revokesEventId: input.id,
          clientEventId: undefined,
        },
        signal,
      );
      signal.throwIfAborted();
      changed ||= recalled.ok;
    }
    return changed;
  },
);

const cancelSlackSessionRuns$ = command(
  async (
    { set },
    scope: SlackSessionStopScope,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    // Recall precedes cancellation. If a picker won the revoke edge, its
    // committed Run is included here instead of escaping the Stop.
    const runs = await db
      .selectDistinct({
        id: agentRuns.id,
        status: agentRuns.status,
        chatThreadId: chatEvents.chatThreadId,
      })
      .from(agentRuns)
      .innerJoin(chatEvents, eq(chatEvents.runId, agentRuns.id))
      .innerJoin(
        chatSlackContext,
        eq(chatSlackContext.id, chatEvents.contextId),
      )
      .where(
        and(
          stoppedSlackContextScope(scope),
          chatEventTypeIn(["input.prompt"]),
          eq(agentRuns.userId, scope.userId),
          eq(agentRuns.orgId, scope.orgId),
          eq(agentRuns.triggerSource, "slack"),
          inArray(agentRuns.status, ["pending", "running", "cancelled"]),
        ),
      );
    signal.throwIfAborted();
    let changed = false;
    for (const run of runs) {
      if (run.status !== "cancelled") {
        await set(
          appendInterruptUserMessage$,
          {
            threadId: run.chatThreadId,
            interruptsRunId: run.id,
            clientEventId: undefined,
          },
          signal,
        );
        signal.throwIfAborted();
      }
      const cancelled = await set(
        cancelRun$,
        {
          runId: run.id,
          userId: scope.userId,
          orgId: scope.orgId,
          runnerCancellationMode: "cooperative",
        },
        signal,
      );
      signal.throwIfAborted();
      if (!("alreadyCancelled" in cancelled)) {
        // Completion may win the terminal transition; it is no longer work to stop.
        continue;
      }
      changed ||= !cancelled.alreadyCancelled;
      if (shouldDispatchCancelSideEffects(cancelled)) {
        await set(dispatchCancelSideEffects$, cancelled, signal);
        signal.throwIfAborted();
      }
    }
    return changed;
  },
);

const confirmStoppedSlackSession$ = command(
  async (
    { set },
    scope: SlackSessionStopScope,
    signal: AbortSignal,
  ): Promise<void> => {
    for (const route of scope.routes) {
      await publishChatThreadMessageCreatedSafely({
        userId: scope.userId,
        orgId: scope.orgId,
        threadId: route.chatThreadId,
      });
      signal.throwIfAborted();
    }
    const featureContext = await set(
      loadUserFeatureSwitchContext$,
      scope.orgId,
      scope.userId,
      signal,
    );
    signal.throwIfAborted();
    const botToken = await decryptPersistentSecretValue(
      scope.encryptedBotToken,
      featureContext,
    );
    signal.throwIfAborted();
    await tapError(
      (async () => {
        const posted = await createSlackClient(botToken).postMessage(
          scope.event.channel,
          "Stopped your tasks and cleared their queued messages in this thread.",
          { threadTs: scope.event.thread_ts },
        );
        if (posted.kind === "slack_error") {
          throw new Error(posted.error);
        }
      })(),
      (error) => {
        L.warn("Failed to confirm Slack session stop", { error });
      },
    );
    signal.throwIfAborted();
  },
);

/** The signed Slack actor can stop only their own inputs in this physical thread. */
export const stopSlackSession$ = command(
  async (
    { set },
    args: {
      readonly workspaceId: string;
      readonly event: SlackSessionStoppedEvent;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const { event } = args;
    const routes = await db
      .select({
        routeId: slackChatThreadRoutes.id,
        routeThreadTs: slackChatThreadRoutes.threadTs,
        chatThreadId: slackChatThreadRoutes.chatThreadId,
        userId: slackChatThreadRoutes.userId,
        orgId: slackOrgInstallations.orgId,
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
      .innerJoin(
        chatThreads,
        eq(chatThreads.id, slackChatThreadRoutes.chatThreadId),
      )
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(
        and(
          eq(slackOrgConnections.userId, slackChatThreadRoutes.userId),
          eq(chatThreads.userId, slackChatThreadRoutes.userId),
          eq(agents.orgId, slackOrgInstallations.orgId),
          eq(slackOrgConnections.slackWorkspaceId, args.workspaceId),
          eq(slackOrgConnections.slackUserId, event.user),
          eq(slackChatThreadRoutes.channelId, event.channel),
          or(
            eq(slackChatThreadRoutes.threadTs, event.thread_ts),
            eq(slackChatThreadRoutes.threadTs, INTEGRATION_DM_SESSION_KEY),
          ),
        ),
      );
    signal.throwIfAborted();
    const binding = routes[0];
    if (!binding?.orgId) {
      return;
    }
    const scope: SlackSessionStopScope = {
      event,
      routes,
      userId: binding.userId,
      orgId: binding.orgId,
      encryptedBotToken: binding.encryptedBotToken,
    };
    const inputsStopped = await set(stopSlackSessionInputs$, scope, signal);
    signal.throwIfAborted();
    const runsCancelled = await set(cancelSlackSessionRuns$, scope, signal);
    signal.throwIfAborted();
    if (inputsStopped || runsCancelled) {
      await set(confirmStoppedSlackSession$, scope, signal);
      signal.throwIfAborted();
    }
    for (const route of routes) {
      const target = {
        chatThreadId: route.chatThreadId,
        channelId: event.channel,
        threadTs: event.thread_ts,
        routeThreadTs: route.routeThreadTs,
      };
      const cleared = await set(
        clearCanonicalSlackThreadStatusIfIdle$,
        target,
        signal,
      );
      signal.throwIfAborted();
      if (!cleared) {
        // Another sender or a newer input can still own this agent's loading UX.
        await set(refreshCanonicalSlackThreadStatus$, target, signal);
        signal.throwIfAborted();
      }
    }
  },
);
