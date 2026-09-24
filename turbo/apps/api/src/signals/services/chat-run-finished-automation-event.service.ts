import { command } from "ccstate";
import { z } from "zod";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { v5 as uuidv5 } from "uuid";
import {
  chatRunFinishedEventConfigSchema,
  type ChatRunFinishedEventConfig,
} from "@okouai/api-contracts/contracts/workflows";
import {
  workflowUserAutomationThreads,
  workflowAutomations,
  workflows,
} from "@okouai/db/schema/workflow";
import { and, eq, not, sql } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import { settle } from "../utils";

import { writeDb$, type Db } from "../external/db";
import { AUTONOMY_BUDGET_EXHAUSTED_MESSAGE } from "../../lib/error";
import { now, nowDate } from "../../lib/time";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { loadRunAutonomyBudget } from "./autonomy-budget.service";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import type { ChatRunFinishedEvent } from "./chat-run-finished-event";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import { drainChatThreadQueueForThread$ } from "./chat-thread-queue-drain.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";
import { ensureWorkflowUserAutomationThread } from "./workflow-user-automation-thread.service";
import { insertChatEvent } from "./chat-event.service";
import {
  touchChatThreadLastMessageAt,
  touchChatThreadLastMessageAtIndependently,
} from "./chat-event-shared.service";
import { isSplitChatEventWriteEnabled } from "./chat-event-write-mode.service";
import { attemptChatEventSideEffect } from "./chat-event-write-side-effects.service";
import { agentRunSourceTitleSnapshot } from "./chat-user-message.service";

const CHAT_RUN_FINISHED_EVENT_TYPE = "chat-run-finished";
// Bounds the finished run's output copied into the triggered run's context.
const OUTPUT_EXCERPT_CHAR_CAP = 4000;
const CHAT_RUN_FINISHED_QUEUE_EVENT_NAMESPACE =
  "ed97d605-f9df-4ce3-b2df-f7ccf318cb53";
const AUTONOMY_BUDGET_ERROR_EVENT_NAMESPACE =
  "e020ef30-b3ec-4465-83e0-f040094ef14b";

async function appendAutonomyBudgetError(args: {
  readonly db: Db;
  readonly chatThreadId: string;
  readonly sourceRunId: string;
}): Promise<boolean> {
  const splitWrites = await isSplitChatEventWriteEnabled(args.db);
  const event = {
    id: uuidv5(
      `${args.chatThreadId}:${args.sourceRunId}`,
      AUTONOMY_BUDGET_ERROR_EVENT_NAMESPACE,
    ),
    chatThreadId: args.chatThreadId,
    eventType: "output.error",
    content: AUTONOMY_BUDGET_EXHAUSTED_MESSAGE,
    runId: null,
    error: "AUTONOMY_BUDGET_EXHAUSTED",
  } as const;
  if (splitWrites) {
    const errorEvent = await insertChatEvent(args.db, event, "id", {
      splitWrites,
    });
    if (!errorEvent) {
      return false;
    }
    await attemptChatEventSideEffect("thread_touch", args.chatThreadId, () => {
      return touchChatThreadLastMessageAtIndependently(
        args.db,
        args.chatThreadId,
        errorEvent.createdAt,
        errorEvent.id,
      );
    });
    return true;
  }
  return await args.db.transaction(async (tx) => {
    const errorEvent = await insertChatEvent(tx, event, "id", { splitWrites });
    if (!errorEvent) {
      return false;
    }
    await touchChatThreadLastMessageAt(
      tx,
      args.chatThreadId,
      errorEvent.createdAt,
    );
    return true;
  });
}

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
  config: ChatRunFinishedEventConfig,
  event: ChatRunFinishedEvent,
): boolean {
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
      lastResultText: excerpt ?? null,
      lastResultTextTruncated:
        (args.event.lastResultText?.length ?? 0) > OUTPUT_EXCERPT_CHAR_CAP,
    },
  };
}

class ChatRunFinishedAutomationAlreadyAdmittedError extends Error {}

async function loadAdmittedChatRunFinishedAutomations(
  db: Db,
  event: ChatRunFinishedEvent,
): Promise<ReadonlySet<string>> {
  if (event.sourceCallbackId === undefined) {
    return new Set();
  }
  const [source] = await db
    .select({
      automationIds:
        sql`coalesce(${agentRunCallbacks.payload}->'chatRunFinishedAutomationIds', '[]'::jsonb)`.mapWith(
          zodDriverValueDecoder(z.array(z.uuid())),
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
  if (!source) {
    throw new Error("Chat run finished event is missing its source callback");
  }
  return new Set(source.automationIds);
}

async function recordChatRunFinishedAutomationAdmission(
  tx: Tx,
  sourceCallbackId: string,
  runId: string,
  automationId: string,
): Promise<void> {
  const receipts = sql`coalesce(${agentRunCallbacks.payload}->'chatRunFinishedAutomationIds', '[]'::jsonb)`;
  const [recorded] = await tx
    .update(agentRunCallbacks)
    .set({
      payload: sql`jsonb_set(${agentRunCallbacks.payload}, '{chatRunFinishedAutomationIds}', ${receipts} || to_jsonb(${automationId}::text))`,
    })
    .where(
      and(
        eq(agentRunCallbacks.id, sourceCallbackId),
        eq(agentRunCallbacks.runId, runId),
        eq(agentRunCallbacks.internalKind, "chat"),
        not(sql`${receipts} @> to_jsonb(ARRAY[${automationId}::text])`),
      ),
    )
    .returning({ id: agentRunCallbacks.id });
  if (!recorded) {
    const [admitted] = await tx
      .select({ id: agentRunCallbacks.id })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.id, sourceCallbackId),
          eq(agentRunCallbacks.runId, runId),
          eq(agentRunCallbacks.internalKind, "chat"),
          sql`${receipts} @> to_jsonb(ARRAY[${automationId}::text])`,
        ),
      )
      .limit(1);
    if (!admitted) {
      throw new Error("Chat run finished admission lost its source callback");
    }
    // A competing callback already committed this automation's queue input.
    // Roll back this admission, including its event, before returning success.
    throw new ChatRunFinishedAutomationAlreadyAdmittedError();
  }
}

const admitChatRunFinishedAutomation$ = command(
  async (
    { set },
    args: {
      readonly event: ChatRunFinishedEvent;
      readonly automation: typeof workflowAutomations.$inferSelect;
      readonly agentId: string;
      readonly chatThreadId: string;
      readonly workflowName: string;
    },
    signal: AbortSignal,
  ) => {
    const { event, automation, agentId, chatThreadId, workflowName } = args;
    const context = chatRunFinishedTriggerContext({
      workflowName,
      automationId: automation.id,
      event,
    });
    const sourceCallbackId = event.sourceCallbackId;
    const admission = await settle(
      set(
        runWorkflowAutomationNow$,
        {
          due: {
            automation,
            agentId,
            chatThreadId,
          },
          automationContext: context,
          queueEventId:
            event.sourceCallbackId === undefined
              ? undefined
              : uuidv5(
                  `${automation.id}:${event.runId}`,
                  CHAT_RUN_FINISHED_QUEUE_EVENT_NAMESPACE,
                ),
          persistSourceTransition:
            sourceCallbackId === undefined
              ? undefined
              : (tx) => {
                  return recordChatRunFinishedAutomationAdmission(
                    tx,
                    sourceCallbackId,
                    event.runId,
                    automation.id,
                  );
                },
          apiStartTime: now(),
          agentRunSource: {
            runId: event.runId,
            threadId: event.chatThreadId,
            agentId: event.sourceAgentId,
            titleSnapshot: agentRunSourceTitleSnapshot(event.sourceThreadTitle),
          },
          triggerSource: "automation-event",
          triggerBrief: `Chat run ${event.runStatus} in watched thread`,
          dispatchFailedCallbacks: dispatchFailedRunCallbacks,
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
      await set(
        drainChatThreadQueueForThread$,
        {
          chatThreadId,
          dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        },
        signal,
      );
    }
  },
);

/**
 * Fires `chat-run-finished` automations watching the thread whose run just
 * reached a terminal state. Called from the terminal chat callback after the
 * run lifecycle marker is durable, so the matched output is final.
 */
export const dispatchChatRunFinishedAutomationEvents$ = command(
  async ({ set }, event: ChatRunFinishedEvent, signal: AbortSignal) => {
    const db = set(writeDb$);
    const sourceAutonomyBudget = await loadRunAutonomyBudget(db, event.runId);
    signal.throwIfAborted();
    if (sourceAutonomyBudget === null) {
      return;
    }
    const automationRows = await db
      .select({
        automation: workflowAutomationColumns(),
        agentId: workflows.agentId,
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
            event.chatThreadId,
          ),
        ),
      );
    signal.throwIfAborted();

    const admittedAutomationIds = await loadAdmittedChatRunFinishedAutomations(
      db,
      event,
    );
    signal.throwIfAborted();
    const currentTime = nowDate();
    const exhaustedThreadIds = new Set<string>();
    for (const row of automationRows) {
      const config = chatRunFinishedEventConfigSchema.safeParse(
        row.automation.eventConfig,
      );
      if (!config.success || !automationMatchesEvent(config.data, event)) {
        continue;
      }

      if (admittedAutomationIds.has(row.automation.id)) {
        // Queue admission is durable independently of its launch. A source retry
        // also retries the target wakeup, including after hot-event retention.
        if (row.chatThreadId !== null) {
          await set(
            drainChatThreadQueueForThread$,
            {
              chatThreadId: row.chatThreadId,
              dispatchFailedCallbacks: dispatchFailedRunCallbacks,
            },
            signal,
          );
          signal.throwIfAborted();
        }
        continue;
      }

      const chatThreadId =
        row.chatThreadId ??
        (await db.transaction(async (tx) => {
          return await ensureWorkflowUserAutomationThread(tx, {
            orgId: row.automation.orgId,
            userId: row.automation.ownerUserId,
            workflowId: row.automation.workflowId,
            agentId: row.agentId,
            workflowTitle: row.workflowDisplayName ?? row.workflowName,
            currentTime,
          });
        }));
      signal.throwIfAborted();

      if (sourceAutonomyBudget === 0) {
        if (exhaustedThreadIds.has(chatThreadId)) {
          continue;
        }
        exhaustedThreadIds.add(chatThreadId);
        const inserted = await appendAutonomyBudgetError({
          db,
          chatThreadId,
          sourceRunId: event.runId,
        });
        signal.throwIfAborted();
        if (inserted) {
          await publishChatThreadMessageCreatedSafely({
            userId: row.automation.ownerUserId,
            orgId: row.automation.orgId,
            threadId: chatThreadId,
          });
          signal.throwIfAborted();
        }
        continue;
      }

      await set(
        admitChatRunFinishedAutomation$,
        {
          event,
          automation: row.automation,
          agentId: row.agentId,
          chatThreadId,
          workflowName: row.workflowName,
        },
        signal,
      );
      signal.throwIfAborted();
    }
  },
);
