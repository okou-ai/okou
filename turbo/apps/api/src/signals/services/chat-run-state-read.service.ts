import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import {
  chatEvents,
  chatEventTerminalPredicate,
} from "@okouai/db/schema/chat-event";
import { command } from "ccstate";
import {
  and,
  desc,
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
import { canonicalChatEventContent } from "./canonical-chat-event-read.service";
import { chatEventTypeIn } from "./chat-event-type.service";

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

export function canonicalDeliveryEventReadPlan(runId: string) {
  return {
    columns: { id: chatEvents.id },
    condition: and(
      eq(chatEvents.runId, runId),
      chatEventTypeIn(["output.message"]),
      isNotNull(canonicalChatEventContent()),
      isNotNull(chatEvents.runEventSequenceNumber),
    ),
    order: desc(chatEvents.runEventSequenceNumber),
    limit: 1,
  };
}

export function integrationCompletionFallbackReadPlan(eventId: string) {
  return {
    columns: { id: chatEvents.id },
    condition: eq(chatEvents.id, eventId),
    limit: 1,
  };
}

export function runLifecycleMarkerReadPlan(
  runId: string,
  eventType: "run.completed" | "run.cancelled" | "run.failed",
) {
  return {
    columns: {
      id: chatEvents.id,
      createdAt: chatEvents.createdAt,
      failureReason: chatEvents.failureReason,
    },
    condition: and(
      eq(chatEvents.runId, runId),
      eq(chatEvents.eventType, eventType),
    ),
    limit: 1,
  };
}

export const requireSourceChatCallback$ = command(
  async (
    { get },
    args: { readonly runId: string; readonly sourceCallbackId: string },
  ): Promise<string> => {
    const [source] = await get(db$)
      .select({ id: agentRunCallbacks.id })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.id, args.sourceCallbackId),
          eq(agentRunCallbacks.runId, args.runId),
          eq(agentRunCallbacks.internalKind, "chat"),
        ),
      )
      .limit(1);
    if (!source) {
      throw new Error("Canonical delivery run is missing its chat callback");
    }
    return source.id;
  },
);

export interface ChatThreadForRunRow {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly title: string | null;
  readonly archived: boolean;
  readonly projectId: string | null;
  readonly muted: boolean;
  readonly hidden: boolean;
}

export interface ChatRunInfo {
  readonly prompt: string;
  readonly status: string;
  readonly failureReason: RunFailureReasonToken | null;
  readonly modelProvider: string | null;
  readonly modelRuntimeProvider: string | null;
  readonly selectedModel: string | null;
  readonly lastEventSequence: number | null;
  readonly cancellationRecoveryCompleted: boolean | null;
  readonly autonomyBudget: number | null;
}

export type TerminalChatCallbackContext =
  | { readonly kind: "not-chat-run" }
  | { readonly kind: "missing-thread"; readonly persistedThreadId: string }
  | {
      readonly kind: "missing-source-callback";
      readonly persistedThreadId: string;
    }
  | {
      readonly kind: "ready";
      readonly persistedThreadId: string;
      readonly run: ChatRunInfo;
      readonly chatThread: ChatThreadForRunRow;
      readonly sourceCallbackId: string;
    };

export const loadTerminalChatCallbackContext$ = command(
  async (
    { get },
    args: {
      readonly runId: string;
      readonly callbackStatus: "completed" | "failed";
      readonly payloadThreadId: string;
      readonly sourceCallbackId: string;
    },
    signal: AbortSignal,
  ): Promise<TerminalChatCallbackContext> => {
    const db = get(db$);
    const [row] = await db
      .select({
        chatThreadId: agentRuns.chatThreadId,
        triggerSource: agentRuns.triggerSource,
        prompt: agentRuns.prompt,
        status: agentRuns.status,
        failureReason: agentRuns.failureReason,
        modelProvider: agentRuns.modelProvider,
        modelRuntimeProvider: agentRuns.modelRuntimeProvider,
        selectedModel: agentRuns.selectedModel,
        lastEventSequence: agentRuns.lastEventSequence,
        cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
        autonomyBudget: agentRuns.autonomyBudget,
        orgId: agentRuns.orgId,
        joinedThreadId: chatThreads.id,
        joinedUserId: chatThreads.userId,
        joinedTitle: chatThreads.title,
        joinedArchived: chatThreads.archived,
        joinedProjectId: chatThreads.projectId,
        joinedMuted: chatThreads.muted,
        joinedHidden: chatThreads.hidden,
        sourceCallbackId: agentRunCallbacks.id,
      })
      .from(agentRuns)
      .leftJoin(
        chatThreads,
        and(
          eq(agentRuns.chatThreadId, chatThreads.id),
          eq(agentRuns.orgId, chatThreads.orgId),
          eq(agentRuns.userId, chatThreads.userId),
        ),
      )
      .leftJoin(
        agentRunCallbacks,
        and(
          eq(agentRunCallbacks.id, args.sourceCallbackId),
          eq(agentRunCallbacks.runId, agentRuns.id),
          eq(agentRunCallbacks.internalKind, "chat"),
        ),
      )
      .where(eq(agentRuns.id, args.runId))
      .limit(1);
    signal.throwIfAborted();

    if (!row?.chatThreadId || row.triggerSource === null) {
      return { kind: "not-chat-run" };
    }

    const persistedThreadId = row.chatThreadId;
    if (!row.joinedThreadId || !row.joinedUserId) {
      log.debug("Skipping terminal chat callback for missing chat thread", {
        runId: args.runId,
        status: args.callbackStatus,
        payloadThreadId: args.payloadThreadId,
      });
      return { kind: "missing-thread", persistedThreadId };
    }

    if (persistedThreadId !== args.payloadThreadId) {
      log.warn("Chat callback payload thread does not match run mapping", {
        runId: args.runId,
        payloadThreadId: args.payloadThreadId,
        chatThreadId: persistedThreadId,
      });
    }

    if (!row.sourceCallbackId) {
      return { kind: "missing-source-callback", persistedThreadId };
    }

    return {
      kind: "ready",
      persistedThreadId,
      run: {
        prompt: row.prompt,
        status: row.status,
        failureReason: row.failureReason,
        modelProvider: row.modelProvider,
        modelRuntimeProvider: row.modelRuntimeProvider,
        selectedModel: row.selectedModel,
        lastEventSequence: row.lastEventSequence,
        cancellationRecoveryCompleted: row.cancellationRecoveryCompleted,
        autonomyBudget: row.autonomyBudget,
      },
      chatThread: {
        chatThreadId: persistedThreadId,
        userId: row.joinedUserId,
        orgId: row.orgId,
        title: row.joinedTitle,
        archived: row.joinedArchived ?? false,
        projectId: row.joinedProjectId,
        muted: row.joinedMuted ?? false,
        hidden: row.joinedHidden ?? false,
      },
      sourceCallbackId: row.sourceCallbackId,
    };
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
