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
        and(
          eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
          eq(slackOrgConnections.userId, slackChatThreadRoutes.userId),
        ),
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
        and(
          eq(chatThreads.id, slackChatThreadRoutes.chatThreadId),
          eq(chatThreads.userId, slackChatThreadRoutes.userId),
        ),
      )
      .innerJoin(
        agents,
        and(
          eq(agents.id, chatThreads.agentId),
          eq(agents.orgId, slackOrgInstallations.orgId),
        ),
      )
      .where(
        and(
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
    const routeIds = routes.map((route) => {
      return route.routeId;
    });
    const threadIds = routes.map((route) => {
      return route.chatThreadId;
    });

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
          inArray(slackChatIngress.routeId, routeIds),
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
    const contextScope = and(
      eq(chatEvents.contextType, "slack"),
      inArray(chatEvents.chatThreadId, threadIds),
      eq(chatSlackContext.channelId, event.channel),
      eq(chatSlackContext.threadTs, event.thread_ts),
      sql`${chatSlackContext.messageTs}::numeric <= ${event.event_ts}::numeric`,
    );
    const queued = await db
      .select({ id: chatEvents.id, chatThreadId: chatEvents.chatThreadId })
      .from(chatEvents)
      .innerJoin(
        chatSlackContext,
        eq(chatSlackContext.id, chatEvents.contextId),
      )
      .where(
        and(
          contextScope,
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

    // Recall before cancellation releases a slot. If a picker won the revoke
    // edge, its committed Run is included here instead of escaping the Stop.
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
          contextScope,
          chatEventTypeIn(["input.prompt"]),
          eq(agentRuns.userId, binding.userId),
          eq(agentRuns.orgId, binding.orgId),
          eq(agentRuns.triggerSource, "slack"),
          inArray(agentRuns.status, ["pending", "running", "cancelled"]),
        ),
      );
    signal.throwIfAborted();
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
          userId: binding.userId,
          orgId: binding.orgId,
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

    if (changed) {
      for (const route of routes) {
        await publishChatThreadMessageCreatedSafely({
          userId: binding.userId,
          orgId: binding.orgId,
          threadId: route.chatThreadId,
        });
        signal.throwIfAborted();
      }
      const featureContext = await set(
        loadUserFeatureSwitchContext$,
        binding.orgId,
        binding.userId,
        signal,
      );
      signal.throwIfAborted();
      const botToken = await decryptPersistentSecretValue(
        binding.encryptedBotToken,
        featureContext,
      );
      signal.throwIfAborted();
      await tapError(
        (async () => {
          const posted = await createSlackClient(botToken).postMessage(
            event.channel,
            "Stopped your tasks and cleared their queued messages in this thread.",
            { threadTs: event.thread_ts },
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
