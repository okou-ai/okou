import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agents } from "@okouai/db/schema/agent";
import {
  chatEvents,
  chatEventTerminalPredicate,
} from "@okouai/db/schema/chat-event";
import { command } from "ccstate";
import {
  and,
  asc,
  eq,
  exists,
  isNotNull,
  notExists,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { logger } from "../../lib/log";
import { db$ } from "../external/db";

const log = logger("callback:chat");

function terminalChatCallbackRunReadPlan(runId: string) {
  return {
    columns: {
      threadId: agentRuns.chatThreadId,
      triggerSource: agentRuns.triggerSource,
    },
    condition: eq(agentRuns.id, runId),
    limit: 1,
  };
}

export const loadTerminalChatCallbackLocator$ = command(
  async ({ get }, runId: string) => {
    const db = get(db$);
    const plan = terminalChatCallbackRunReadPlan(runId);
    const [run] = await db
      .select(plan.columns)
      .from(agentRuns)
      .where(plan.condition)
      .limit(plan.limit);
    return run;
  },
);

export function runLifecycleMarkerReadPlan(
  runId: string,
  eventType: "run.completed" | "run.cancelled" | "run.failed",
) {
  return {
    columns: { id: chatEvents.id, createdAt: chatEvents.createdAt },
    condition: and(
      eq(chatEvents.runId, runId),
      eq(chatEvents.eventType, eventType),
    ),
    limit: 1,
  };
}

export function sourceChatCallbackReadPlan(args: {
  readonly runId: string;
  readonly sourceCallbackId?: string;
}) {
  return {
    columns: {
      id: agentRunCallbacks.id,
      encryptedSecret: agentRunCallbacks.encryptedSecret,
    },
    condition: and(
      eq(agentRunCallbacks.runId, args.runId),
      eq(agentRunCallbacks.internalKind, "chat"),
      args.sourceCallbackId
        ? eq(agentRunCallbacks.id, args.sourceCallbackId)
        : undefined,
    ),
    order: asc(agentRunCallbacks.id),
    limit: 1,
  };
}

export const requireSourceChatCallback$ = command(
  async (
    { get },
    args: {
      readonly runId: string;
      readonly sourceCallbackId?: string;
    },
  ) => {
    const db = get(db$);
    const plan = sourceChatCallbackReadPlan(args);
    const [source] = await db
      .select(plan.columns)
      .from(agentRunCallbacks)
      .where(plan.condition)
      .orderBy(plan.order)
      .limit(plan.limit);
    if (!source) {
      throw new Error("Canonical delivery run is missing its chat callback");
    }

    return source;
  },
);

export interface ChatThreadForRunRow {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly title: string | null;
}

export interface ChatRunInfo {
  readonly prompt: string;
  readonly error: string | null;
  readonly failureReason: RunFailureReasonToken | null;
  readonly modelProvider: string | null;
  readonly lastEventSequence: number | null;
  readonly cancellationRecoveryCompleted: boolean | null;
}

export const loadTerminalChatCallback$ = command(
  async (
    { get },
    args: {
      readonly runId: string;
      readonly callbackStatus: "completed" | "failed";
      readonly payloadThreadId: string;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly run: ChatRunInfo;
    readonly chatThread: ChatThreadForRunRow;
  } | null> => {
    const db = get(db$);
    const [run] = await db
      .select({
        prompt: agentRuns.prompt,
        error: agentRuns.error,
        failureReason: agentRuns.failureReason,
        modelProvider: agentRuns.modelProvider,
        lastEventSequence: agentRuns.lastEventSequence,
        cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, args.runId))
      .limit(1);
    signal.throwIfAborted();

    if (!run) {
      return null;
    }

    const runId = args.runId;
    const chatThread = await (async (): Promise<ChatThreadForRunRow | null> => {
      const [row] = await db
        .select({
          chatThreadId: agentRuns.chatThreadId,
          userId: chatThreads.userId,
          orgId: agentRuns.orgId,
          agentId: agents.id,
          title: chatThreads.title,
        })
        .from(agentRuns)
        .innerJoin(chatThreads, eq(agentRuns.chatThreadId, chatThreads.id))
        .innerJoin(agents, eq(agents.id, chatThreads.agentId))
        .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
        .limit(1);

      if (!row?.chatThreadId) {
        return null;
      }
      return {
        chatThreadId: row.chatThreadId,
        userId: row.userId,
        orgId: row.orgId,
        agentId: row.agentId,
        title: row.title,
      };
    })();
    signal.throwIfAborted();
    if (!chatThread) {
      log.debug("Skipping terminal chat callback for missing chat thread", {
        runId: args.runId,
        status: args.callbackStatus,
        payloadThreadId: args.payloadThreadId,
      });
      return null;
    }

    if (chatThread.chatThreadId !== args.payloadThreadId) {
      log.warn("Chat callback payload thread does not match run mapping", {
        runId: args.runId,
        payloadThreadId: args.payloadThreadId,
        chatThreadId: chatThread.chatThreadId,
      });
    }

    return { run, chatThread };
  },
);

const terminalEvent = alias(chatEvents, "chat_run_state_terminal");

/** Active rows can outlive the terminal event while the Runner stops. */
export function unfinishedActiveChatRunExists(
  scope: { readonly runId: SQLWrapper } | { readonly chatThreadId: SQLWrapper },
): SQL {
  return exists(
    new QueryBuilder()
      .select({ runId: activeAgentRuns.runId })
      .from(activeAgentRuns)
      .where(
        and(
          "runId" in scope
            ? eq(activeAgentRuns.runId, scope.runId)
            : eq(activeAgentRuns.chatThreadId, scope.chatThreadId),
          notExists(
            new QueryBuilder()
              .select({ id: terminalEvent.id })
              .from(terminalEvent)
              .where(
                and(
                  eq(terminalEvent.runId, activeAgentRuns.runId),
                  chatEventTerminalPredicate(terminalEvent.eventType),
                ),
              ),
          ),
        ),
      ),
  );
}
