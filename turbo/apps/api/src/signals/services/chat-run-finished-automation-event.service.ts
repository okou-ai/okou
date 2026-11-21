import {
  publishChatThreadMessageCreated$,
  projectCommittedChatThreadSearch$,
} from "./chat-event-publication.service";
import { chatEventCommandResultSchema } from "./chat-event-append.service";
import { parseRawRows } from "../../lib/db-raw-rows";
import { chatRunFinishedEventConfigSchema } from "@okouai/api-contracts/contracts/workflows";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import {
  workflows,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { array, uuid } from "zod";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import { AUTONOMY_BUDGET_EXHAUSTED_MESSAGE } from "../../lib/error";
import { now, nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";

import { settle, settleIncludingAbort } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { loadRunAutonomyBudget$ } from "./autonomy-budget.service";
import { touchChatThreadLastMessageAtIndependently$ } from "./chat-event-shared.service";
import { reportChatEventSideEffect } from "./chat-event-write-side-effects.service";
import { chatEventInsertSql } from "./chat-event.service";
import type { ChatRunFinishedEvent } from "./chat-run-finished-event";
import {
  notifyRunningChatRunOfPendingInput$,
  pickEnqueuedChatThread$,
} from "./chat-thread-queue-drain.service";
import { waitUntil } from "../context/wait-until";
import { agentRunSourceTitleSnapshot } from "./chat-user-message.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import {
  ChatRunFinishedAutomationAlreadyAdmittedError,
  ChatRunFinishedAutomationBindingChangedError,
} from "./workflow-input-queue.service";
import { ensureWorkflowUserAutomationThread$ } from "./workflow-user-automation-thread.service";

const CHAT_RUN_FINISHED_EVENT_TYPE = "chat-run-finished";
// Bounds the finished run's output copied into the triggered run's context.
const OUTPUT_EXCERPT_CHAR_CAP = 4000;
const CHAT_RUN_FINISHED_QUEUE_EVENT_NAMESPACE =
  "ed97d605-f9df-4ce3-b2df-f7ccf318cb53";
const AUTONOMY_BUDGET_ERROR_EVENT_NAMESPACE =
  "e020ef30-b3ec-4465-83e0-f040094ef14b";

const appendAutonomyBudgetError$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly sourceRunId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const errorEvent =
      parseRawRows(
        chatEventCommandResultSchema,
        await set(writeDb$).execute(
          chatEventInsertSql(
            {
              id: uuidv5(
                `${args.chatThreadId}:${args.sourceRunId}`,
                AUTONOMY_BUDGET_ERROR_EVENT_NAMESPACE,
              ),
              chatThreadId: args.chatThreadId,
              eventType: "output.error",
              content: AUTONOMY_BUDGET_EXHAUSTED_MESSAGE,
              runId: null,
              error: "AUTONOMY_BUDGET_EXHAUSTED",
            },
            "id",
          ),
        ),
      )[0] ?? null;
    signal.throwIfAborted();
    if (!errorEvent) {
      return false;
    }
    const startedAt = performance.now();
    const result = await settleIncludingAbort(
      set(
        touchChatThreadLastMessageAtIndependently$,
        args.chatThreadId,
        { touchedAt: errorEvent.createdAt, eventId: errorEvent.id },
        signal,
      ),
    );
    signal.throwIfAborted();
    reportChatEventSideEffect(
      "thread_touch",
      args.chatThreadId,
      startedAt,
      result,
    );
    return true;
  },
);

/**
 * Anchored case-insensitive `*`-wildcard match. Every character except `*`
 * matches literally; a greedy left-to-right segment scan avoids building a
 * regular expression from user input.
 */
function chatRunFinishedPatternMatches(pattern: string, text: string): boolean {
  const segments = pattern.toLowerCase().split("*");
  const haystack = text.toLowerCase();
  if (segments.length === 1) {
    return haystack === segments[0];
  }
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  if (!haystack.startsWith(first)) {
    return false;
  }
  let cursor = first.length;
  for (const segment of segments.slice(1, -1)) {
    if (segment.length === 0) {
      continue;
    }
    const index = haystack.indexOf(segment, cursor);
    if (index === -1) {
      return false;
    }
    cursor = index + segment.length;
  }
  return haystack.length - last.length >= cursor && haystack.endsWith(last);
}

function automationMatchesEvent(
  automation: typeof workflowAutomations.$inferSelect,
  event: ChatRunFinishedEvent,
): boolean {
  const parsed = chatRunFinishedEventConfigSchema.safeParse(
    automation.eventConfig,
  );
  if (!parsed.success) {
    return false;
  }
  const config = parsed.data;
  const statuses = config.runStatuses ?? ["completed", "failed", "cancelled"];
  if (!statuses.includes(event.runStatus)) {
    return false;
  }
  if (config.outputPattern === undefined) {
    return true;
  }
  // Failed and cancelled runs often carry no assistant text; error messages
  // are intentionally not searched because users never see them verbatim.
  if (event.lastResultText === null) {
    return false;
  }
  return chatRunFinishedPatternMatches(
    config.outputPattern,
    event.lastResultText,
  );
}

function chatRunFinishedTriggerContext(args: {
  readonly workflowName: string;
  readonly automationId: string;
  readonly event: ChatRunFinishedEvent;
}): WorkflowAutomationContext {
  const excerpt = args.event.lastResultText?.slice(0, OUTPUT_EXCERPT_CHAR_CAP);
  return {
    workflowName: args.workflowName,
    eventType: "chat-run-finished",
    trigger: `run ${args.event.runId} in watched chat thread ${args.event.chatThreadId} finished with status "${args.event.runStatus}".`,
    notes: [
      'Not included below: the finished run\'s full transcript, and its final output beyond the excerpt. `okou search "<runId>" --source agent-session` prints both local session-file locations for direct analysis.',
    ],
    event: {
      automationId: args.automationId,
      eventType: CHAT_RUN_FINISHED_EVENT_TYPE,
      watchedChatThreadId: args.event.chatThreadId,
      runId: args.event.runId,
      runStatus: args.event.runStatus,
      failureReason: args.event.failureReason,
      lastResultText: excerpt ?? null,
      lastResultTextTruncated:
        (args.event.lastResultText?.length ?? 0) > OUTPUT_EXCERPT_CHAR_CAP,
    },
  };
}

// Chat callback writers do not seed this receipt key; the first admission
// creates it. An absent key therefore means no automation has been admitted
// for this source callback yet.
const loadAdmittedChatRunFinishedAutomations$ = command(
  async (
    { get },
    event: ChatRunFinishedEvent,
    signal: AbortSignal,
  ): Promise<ReadonlySet<string>> => {
    const [source] = await get(db$)
      .select({
        automationIds:
          sql`coalesce(${agentRunCallbacks.payload}->'chatRunFinishedAutomationIds', '[]'::jsonb)`.mapWith(
            zodDriverValueDecoder(array(uuid())),
          ),
      })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.id, event.sourceCallbackId),
          eq(agentRunCallbacks.runId, event.runId),
          eq(agentRunCallbacks.internalKind, "chat"),
        ),
      )
      .limit(1);
    if (signal.aborted) {
      // Keep a missing source callback's invariant error ahead of cancellation.
      if (source) {
        signal.throwIfAborted();
      }
    }
    if (!source) {
      throw new Error("Chat run finished event is missing its source callback");
    }
    return new Set(source.automationIds);
  },
);

const admitChatRunFinishedAutomation$ = command(
  async (
    { set },
    args: {
      readonly event: ChatRunFinishedEvent;
      readonly automation: typeof workflowAutomations.$inferSelect;
      readonly chatThreadId: string;
      readonly workflowName: string;
    },
    signal: AbortSignal,
  ) => {
    const { event, automation, chatThreadId, workflowName } = args;
    const context = chatRunFinishedTriggerContext({
      workflowName,
      automationId: automation.id,
      event,
    });
    const admission = await settle(
      set(
        runWorkflowAutomationNow$,
        {
          automation,
          chatThreadId,
          automationContext: context,
          queueEventId: uuidv5(
            `${automation.id}:${event.runId}`,
            CHAT_RUN_FINISHED_QUEUE_EVENT_NAMESPACE,
          ),
          sourcePlan: {
            kind: "chat-run-finished",
            sourceCallbackId: event.sourceCallbackId,
            runId: event.runId,
          },
          apiStartTime: now(),
          agentRunSource: {
            runId: event.runId,
            threadId: event.chatThreadId,
            titleSnapshot: agentRunSourceTitleSnapshot(event.sourceThreadTitle),
          },
          triggerSource: "automation-event",
          triggerBrief: `Chat run ${event.runStatus} in watched thread`,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!admission.ok) {
      if (
        !(
          admission.error instanceof
          ChatRunFinishedAutomationAlreadyAdmittedError
        )
      ) {
        throw admission.error;
      }
      // A competing callback committed this input; wake the thread anyway.
      waitUntil(
        set(
          pickEnqueuedChatThread$,
          { orgId: automation.orgId, chatThreadId },
          signal,
        ),
      );
      waitUntil(set(notifyRunningChatRunOfPendingInput$, chatThreadId, signal));
    }
  },
);

const loadChatRunFinishedAutomationTargets$ = command(
  async (
    { set },
    target: { readonly chatThreadId: string; readonly automationId?: string },
    signal: AbortSignal,
  ) => {
    const automationRows = await set(writeDb$)
      .select({
        automation: workflowAutomationColumns(),
        workflowName: workflows.name,
        workflowDisplayName: workflows.displayName,
        chatThreadId: workflowUserAutomationThreads.chatThreadId,
      })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflowAutomations.workflowId, workflows.id))
      .leftJoin(
        workflowUserAutomationThreads,
        and(
          eq(workflowUserAutomationThreads.orgId, workflowAutomations.orgId),
          eq(
            workflowUserAutomationThreads.userId,
            workflowAutomations.ownerUserId,
          ),
          eq(
            workflowUserAutomationThreads.workflowId,
            workflowAutomations.workflowId,
          ),
        ),
      )
      .where(
        and(
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.kind, "event"),
          eq(workflowAutomations.eventType, CHAT_RUN_FINISHED_EVENT_TYPE),
          eq(
            sql`${workflowAutomations.eventConfig}->>'chatThreadId'`,
            target.chatThreadId,
          ),
          target.automationId === undefined
            ? undefined
            : eq(workflowAutomations.id, target.automationId),
        ),
      );
    signal.throwIfAborted();
    return automationRows;
  },
);

interface ChatRunFinishedAutomationTarget {
  readonly automation: typeof workflowAutomations.$inferSelect;
  readonly chatThreadId: string | null;
  readonly workflowName: string;
  readonly workflowDisplayName: string | null;
}

const resolveChatRunFinishedAutomationThread$ = command(
  async (
    { set },
    row: ChatRunFinishedAutomationTarget,
    currentTime: Date,
    signal: AbortSignal,
  ) => {
    return (
      row.chatThreadId ??
      (await set(
        ensureWorkflowUserAutomationThread$,
        {
          orgId: row.automation.orgId,
          userId: row.automation.ownerUserId,
          workflowId: row.automation.workflowId,
          workflowTitle: row.workflowDisplayName ?? row.workflowName,
          currentTime,
        },
        signal,
      ))
    );
  },
);

const admitChatRunFinishedWithBindingRetry$ = command(
  async (
    { set },
    target: ChatRunFinishedAutomationTarget & { readonly chatThreadId: string },
    event: ChatRunFinishedEvent,
    currentTime: Date,
    signal: AbortSignal,
  ) => {
    const admission = await settle(
      set(admitChatRunFinishedAutomation$, { ...target, event }, signal),
      signal,
    );
    signal.throwIfAborted();
    if (admission.ok) {
      return;
    }
    if (
      !(admission.error instanceof ChatRunFinishedAutomationBindingChangedError)
    ) {
      throw admission.error;
    }
    // Reload only this consumer. The existing callback and queue input IDs
    // deduplicate the retry if another dispatch admitted the same event.
    const [current] = await set(
      loadChatRunFinishedAutomationTargets$,
      { chatThreadId: event.chatThreadId, automationId: target.automation.id },
      signal,
    );
    if (!current || !automationMatchesEvent(current.automation, event)) {
      return;
    }
    const chatThreadId = await set(
      resolveChatRunFinishedAutomationThread$,
      current,
      currentTime,
      signal,
    );
    await set(
      admitChatRunFinishedAutomation$,
      { ...current, event, chatThreadId },
      signal,
    );
  },
);

/**
 * Fires `chat-run-finished` automations watching the thread whose run just
 * reached a terminal state. Called from the terminal chat callback after the
 * run lifecycle marker is durable, so the matched output is final.
 */
export const dispatchChatRunFinishedAutomationEvents$ = command(
  async ({ set }, event: ChatRunFinishedEvent, signal: AbortSignal) => {
    const sourceBudget = await set(loadRunAutonomyBudget$, event.runId, signal);
    signal.throwIfAborted();
    if (sourceBudget === null) {
      return;
    }
    const automationRows = await set(
      loadChatRunFinishedAutomationTargets$,
      { chatThreadId: event.chatThreadId },
      signal,
    );
    signal.throwIfAborted();

    const admittedAutomationIds = await set(
      loadAdmittedChatRunFinishedAutomations$,
      event,
      signal,
    );
    signal.throwIfAborted();
    const currentTime = nowDate();
    const exhaustedThreadIds = new Set<string>();
    for (const row of automationRows) {
      if (!automationMatchesEvent(row.automation, event)) {
        continue;
      }

      if (admittedAutomationIds.has(row.automation.id)) {
        // Queue admission is durable independently of its launch. A source retry
        // also retries the target wakeup, including after hot-event retention.
        if (row.chatThreadId !== null) {
          waitUntil(
            set(
              pickEnqueuedChatThread$,
              { orgId: row.automation.orgId, chatThreadId: row.chatThreadId },
              signal,
            ),
          );
          waitUntil(
            set(notifyRunningChatRunOfPendingInput$, row.chatThreadId, signal),
          );
        }
        continue;
      }

      const chatThreadId = await set(
        resolveChatRunFinishedAutomationThread$,
        row,
        currentTime,
        signal,
      );
      signal.throwIfAborted();

      if (sourceBudget === 0) {
        if (exhaustedThreadIds.has(chatThreadId)) {
          continue;
        }
        exhaustedThreadIds.add(chatThreadId);
        const inserted = await set(
          appendAutonomyBudgetError$,
          {
            chatThreadId,
            sourceRunId: event.runId,
          },
          signal,
        );
        signal.throwIfAborted();
        if (inserted) {
          waitUntil(
            set(
              projectCommittedChatThreadSearch$,
              {
                userId: row.automation.ownerUserId,
                orgId: row.automation.orgId,
                threadId: chatThreadId,
              },
              signal,
            ),
          );
          await set(
            publishChatThreadMessageCreated$,
            {
              userId: row.automation.ownerUserId,
              orgId: row.automation.orgId,
              threadId: chatThreadId,
            },
            signal,
          );
          signal.throwIfAborted();
        }
        continue;
      }

      await set(
        admitChatRunFinishedWithBindingRetry$,
        { ...row, chatThreadId },
        event,
        currentTime,
        signal,
      );
      signal.throwIfAborted();
    }
  },
);
