import { AUTO_SELECTED_MODEL } from "@okouai/core/auto-run-model";
import { synchronizeOfficialWorkflowThread$ } from "./official-workflow-thread.service";
import {
  applyThreadModelReplacement,
  resolveEnqueuedChatInputModel$,
  type EnqueuedChatInputModel,
} from "./chat-input-model.service";
import { command } from "ccstate";
import { db$, writeDb$ } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { safeSync, settle, settleIncludingAbort } from "../utils";
import { waitUntil } from "../context/wait-until";
import {
  ApiDispatchTimingCollector,
  type ApiDispatchTimingDimensions,
} from "./api-dispatch-timing.service";
import type { ChatInputEnqueueCommit } from "./chat-input-enqueue-observation";
import {
  pickEnqueuedChatThread$,
  notifyRunningChatRunOfPendingInput$,
} from "./chat-thread-queue-drain.service";
import {
  persistedWorkflowAutomationEventPayload,
  workflowAutomationDisplayMessage,
} from "./workflow-automation-context.service";
import {
  ScheduleOccurrenceUnavailableError,
  workflowAutomationQueueEventPlan,
  pendingWorkflowScheduleTickCondition,
  workflowScheduleRevocationRows,
  type RunWorkflowAutomationNowArgs,
  type RunWorkflowAutomationResult,
} from "./workflow-automation-enqueue.service";
import {
  censusWorkflowAdmission,
  measureWorkflowAdmissionStep,
  type WorkflowAdmissionOutcome,
  type WorkflowAdmissionSchedulePath,
} from "./workflow-queue-admission-timing.service";
import {
  consumeWorkflowScheduleAnchorSql,
  journalWorkflowScheduleClaimSql,
} from "./workflow-schedule-queue.service";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { now, nowDate } from "../../lib/time";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { queuedChatThreadEnqueuePlan } from "./queued-chat-thread.service";
import {
  appendCanonicalChatEventsSql,
  canonicalChatEventAppendCtes,
} from "./chat-event-append.service";
import { PROACTIVE_JOBS_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/proactive-jobs";
import { jobsOwnerEnabledSql, runnableJobsExistSql } from "./user-jobs-query";
import { proactiveWorkflowOwnerEnabledSql } from "./proactive-workflow-owner";
import { calculateNextRun } from "./time-automation";
import {
  workflowCallbackReceiptPlan,
  workflowWebhookReceiptPlan,
  workflowSourceAdmissionError,
  ChatRunFinishedAutomationAlreadyAdmittedError,
  type WorkflowSourceAdmissionPlan,
} from "./workflow-input-queue.service";
import { gmailQueueAdmissionSql } from "./workflow-gmail-queue.service";
import { googleCalendarQueueAdmissionSql } from "./workflow-google-calendar-queue.service";
import {
  googleFormsQueueReceiptSql,
  GoogleFormsSourceTransitionChangedError,
} from "./workflow-google-forms-queue.service";
import { googleMeetQueueAdmissionSql } from "./workflow-google-meet-queue.service";
import {
  notionConfigMatchesPendingEvent,
  notionQueueReceiptSql,
  type NotionQueueSource,
  NotionAutomationSourceChangedError,
} from "./workflow-notion-queue.service";

export const publishEnqueuedWorkflowInput$ = command(
  async (
    { set },
    input: {
      readonly orgId: string;
      readonly userId: string;
      readonly chatThreadId: string;
      readonly enqueueCommit?: ChatInputEnqueueCommit;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const picked = await settle(
      set(
        pickEnqueuedChatThread$,
        {
          orgId: input.orgId,
          chatThreadId: input.chatThreadId,
          ...(input.enqueueCommit
            ? { enqueueCommit: input.enqueueCommit }
            : {}),
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    await publishChatThreadMessageCreatedSafely({
      userId: input.userId,
      orgId: input.orgId,
      threadId: input.chatThreadId,
    });
    signal.throwIfAborted();
    if (!picked.ok) {
      throw picked.error;
    }
  },
);

function workflowEnqueueResult(
  journaled: boolean,
  enqueued: boolean,
): RunWorkflowAutomationResult {
  return {
    kind: "enqueued",
    scheduleOccurrence: journaled
      ? enqueued
        ? "claimed"
        : "superseded"
      : undefined,
  };
}

function workflowAdmissionSchedulePath(
  kind: string,
  hasScheduleClaim: boolean,
): WorkflowAdmissionSchedulePath {
  if (kind !== "schedule") {
    return "non_schedule";
  }
  return hasScheduleClaim ? "journaled_schedule" : "unjournaled_schedule";
}

/** Flush completed admission telemetry without replacing its result or error. */
async function flushWorkflowAdmission<T>(
  operation: Promise<T>,
  flush: () => void,
): Promise<T> {
  const result = await settleIncludingAbort(operation);
  // Emit completed steps even when admission fails. Telemetry must never
  // replace the committed result, original transaction error, or cancellation.
  await settleIncludingAbort(flush);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/**
 * Workflow entry for every trigger. Entry-owned state stays here: an automated
 * schedule tick coalesces this automation's older unconsumed ticks, and a
 * journaled Morning Brief occurrence and any trigger-source transition commit
 * with the queue event. This owner commits the prepared context, input and
 * queue row, and the thread is picked in the background: no
 * trigger waits for a launch, and a launch rejection appears in the thread as
 * `input.rejected`.
 */
function pendingTickReplacement(args: RunWorkflowAutomationNowArgs) {
  const { automation, chatThreadId } = args.due;
  return automation.kind === "schedule" &&
    args.replacePendingScheduleTick !== false
    ? { chatThreadId, automationId: automation.id }
    : undefined;
}

const workflowAutomationInputModel$ = command(
  async (
    { set },
    due: RunWorkflowAutomationNowArgs["due"],
    signal: AbortSignal,
  ) => {
    const official = await set(
      synchronizeOfficialWorkflowThread$,
      {
        workflowId: due.automation.workflowId,
        orgId: due.automation.orgId,
        userId: due.automation.ownerUserId,
      },
      signal,
    );
    if (official) {
      return {
        modelSelection: {
          selectedModel: AUTO_SELECTED_MODEL,
          codexServiceTier: null,
          reasoningEffort: null,
        },
        threadModelReplacement: null,
      };
    }
    return await set(
      resolveEnqueuedChatInputModel$,
      {
        threadId: due.chatThreadId,
        orgId: due.automation.orgId,
        userId: due.automation.ownerUserId,
      },
      signal,
    );
  },
);

const prepareNotionQueueSource$ = command(
  async (
    { get },
    source: NotionQueueSource,
    signal: AbortSignal,
  ): Promise<WorkflowSourceAdmissionPlan> => {
    const connectorId = source.pending.connectorId;
    if (connectorId === null) {
      throw new NotionAutomationSourceChangedError();
    }
    const [consumer] = await get(db$)
      .select({
        eventType: workflowAutomations.eventType,
        eventConfig: workflowAutomations.eventConfig,
      })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.id, source.automationId),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.eventConnectorId, connectorId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (
      !consumer ||
      !notionConfigMatchesPendingEvent(
        consumer.eventType,
        consumer.eventConfig,
        source.pending,
      )
    ) {
      throw new NotionAutomationSourceChangedError();
    }
    return {
      steps: [
        {
          statement: notionQueueReceiptSql({
            source,
            connectorId,
            ...consumer,
            currentTime: nowDate(),
          }),
          failure: { kind: "notion" },
        },
      ],
    };
  },
);

const prepareWorkflowQueueSource$ = command(
  async (
    { set },
    args: RunWorkflowAutomationNowArgs,
    signal: AbortSignal,
  ): Promise<WorkflowSourceAdmissionPlan> => {
    const plan = args.sourcePlan;
    switch (plan?.kind) {
      case undefined: {
        return { steps: [] };
      }
      case "chat-run-finished": {
        return workflowCallbackReceiptPlan(plan, args.due.automation.id);
      }
      case "webhook": {
        return workflowWebhookReceiptPlan(plan, args.due.automation.id);
      }
      case "gmail": {
        return {
          steps: [
            {
              statement: gmailQueueAdmissionSql(plan.source),
              failure: { kind: "gmail" },
            },
          ],
        };
      }
      case "google-calendar": {
        return {
          steps: [
            {
              statement: googleCalendarQueueAdmissionSql(plan.source),
              failure: { kind: "google-calendar" },
            },
          ],
        };
      }
      case "google-forms": {
        return {
          steps: [
            {
              statement: googleFormsQueueReceiptSql(plan.source, nowDate()),
              failure: { kind: "google-forms" },
            },
          ],
        };
      }
      case "google-meet": {
        return {
          steps: [
            {
              statement: googleMeetQueueAdmissionSql(plan.source),
              failure: { kind: "google-meet" },
            },
          ],
        };
      }
      case "notion": {
        return await set(prepareNotionQueueSource$, plan.source, signal);
      }
    }
  },
);

const WORKFLOW_SQL_TIMING_ACTIONS = {
  context: "api_dispatch_workflow_enqueue_event_context_insert",
  event: "api_dispatch_workflow_enqueue_event_insert",
  schedule: "api_dispatch_workflow_enqueue_schedule_claim",
  ticks: "api_dispatch_workflow_enqueue_replace_pending_ticks",
  source: "api_dispatch_workflow_enqueue_source_transition",
  queue: "api_dispatch_workflow_enqueue_queue_upsert",
} as const;
type WorkflowSqlTimingMark = {
  readonly step: keyof typeof WORKFLOW_SQL_TIMING_ACTIONS | "finished";
  readonly startedAt: number;
};

class WorkflowPendingTickTiming {
  lookupStartedAt?: number;
  lookupFinishedAt?: number;
  revocationStartedAt?: number;
  revocationFinishedAt?: number;
  targetCount?: number;

  readonly finishLookup = (): void => {
    safeSync(() => {
      this.lookupFinishedAt = now();
    });
  };

  startRevocation(): void {
    safeSync(() => {
      this.revocationStartedAt = now();
    });
  }

  readonly finishRevocation = (): void => {
    safeSync(() => {
      this.revocationFinishedAt = now();
    });
  };
}

function createWorkflowSqlTiming(): {
  readonly startedAt: number;
  readonly marks: WorkflowSqlTimingMark[];
  readonly tickTiming: WorkflowPendingTickTiming;
} {
  return {
    startedAt: now(),
    marks: [],
    tickTiming: new WorkflowPendingTickTiming(),
  };
}

function workflowPendingTickTargetCountBucket(count: number): string {
  if (count === 0) {
    return "0";
  }
  if (count === 1) {
    return "1";
  }
  if (count <= 4) {
    return "2_4";
  }
  if (count <= 16) {
    return "5_16";
  }
  return "17_plus";
}

function recordWorkflowPendingTickTimings(
  timing: ApiDispatchTimingCollector,
  observation: WorkflowPendingTickTiming,
  dimensions: ApiDispatchTimingDimensions | undefined,
): void {
  const intervals = [
    [
      "api_dispatch_workflow_enqueue_pending_tick_lookup",
      observation.lookupStartedAt,
      observation.lookupFinishedAt,
    ],
    [
      "api_dispatch_workflow_enqueue_pending_tick_revocation_append",
      observation.revocationStartedAt,
      observation.revocationFinishedAt,
    ],
  ] as const;
  for (const [action, startedAt, finishedAt] of intervals) {
    if (startedAt !== undefined && finishedAt !== undefined) {
      timing.recordElapsed(action, "nested", startedAt, finishedAt, dimensions);
    }
  }
}

/** Recording reads numeric metadata only, never SQL resources or query callbacks. */
function recordWorkflowSqlTimings(
  timing: ApiDispatchTimingCollector,
  marks: readonly WorkflowSqlTimingMark[],
  transactionStartedAt: number,
  pendingTickTiming: WorkflowPendingTickTiming,
) {
  safeSync(() => {
    const finishedAt = now();
    const pendingTickDimensions =
      pendingTickTiming.targetCount === undefined
        ? undefined
        : {
            workflow_pending_tick_target_count_bucket:
              workflowPendingTickTargetCountBucket(
                pendingTickTiming.targetCount,
              ),
          };
    timing.recordElapsed(
      "api_dispatch_workflow_enqueue_transaction",
      "nested",
      transactionStartedAt,
      finishedAt,
    );
    const first = marks[0];
    if (first) {
      const last = marks.at(-1);
      timing.recordElapsed(
        "api_dispatch_workflow_enqueue_transaction_callback",
        "nested",
        first.startedAt,
        last?.step === "finished" ? last.startedAt : finishedAt,
      );
    }
    for (const [index, mark] of marks.entries()) {
      if (mark.step !== "finished") {
        timing.recordElapsed(
          WORKFLOW_SQL_TIMING_ACTIONS[mark.step],
          "nested",
          mark.startedAt,
          marks[index + 1]?.startedAt ?? finishedAt,
          mark.step === "ticks" ? pendingTickDimensions : undefined,
        );
      }
    }
    recordWorkflowPendingTickTimings(
      timing,
      pendingTickTiming,
      pendingTickDimensions,
    );
  });
}

interface PreparedWorkflowInputCommit {
  readonly args: RunWorkflowAutomationNowArgs;
  readonly plan: ReturnType<typeof workflowAutomationQueueEventPlan>;
  readonly source: WorkflowSourceAdmissionPlan;
  readonly replacePendingTicks: ReturnType<typeof pendingTickReplacement>;
  readonly model: EnqueuedChatInputModel;
  readonly timing: ApiDispatchTimingCollector;
}

/** Proactive schedule anchors, nightly identities and queue inputs commit together. */
const commitProactiveWorkflowInput$ = command(
  async (
    { set },
    input: PreparedWorkflowInputCommit,
    signal: AbortSignal,
  ): Promise<ChatInputEnqueueCommit | null> => {
    const { args, plan, source, model } = input;
    const { automation, chatThreadId, agentId } = args.due;
    if (
      source.steps.length !== 0 ||
      automation.officialBlueprintKey === null ||
      model.threadModelReplacement !== null ||
      args.scheduleClaim
    ) {
      throw new Error(
        "Jobs admission requires an Official schedule without an external event source",
      );
    }
    const database = set(writeDb$);
    const at = nowDate();
    const owner = { orgId: automation.orgId, userId: automation.ownerUserId };
    const nightly = args.proactiveNightlyOccurrence;
    if (nightly && automation.cronExpression === null) {
      throw new Error("Nightly workflow is missing its cron schedule");
    }
    const next =
      nightly && automation.cronExpression !== null
        ? calculateNextRun(automation.cronExpression, automation.timezone, at)
        : null;
    const nightlyCondition = nightly
      ? sql`EXISTS (SELECT 1 FROM org_members_metadata AS preference
          WHERE preference.org_id = ${owner.orgId} AND preference.user_id = ${owner.userId}
            AND preference.timezone = ${nightly.timezone}
            AND COALESCE(preference.proactive_learning_enabled, false) = ${nightly.learningEnabled})
          AND (${nightly.learningEventId === null} OR EXISTS (
            SELECT 1 FROM chat_events AS learning_input
            JOIN agent_runs AS learning_run ON learning_run.id = learning_input.run_id
            WHERE learning_input.id = ${nightly.learningEventId}::uuid
              AND learning_run.org_id = ${owner.orgId} AND learning_run.user_id = ${owner.userId}
              AND learning_run.status = 'completed'
              AND learning_run.result @> ${JSON.stringify({ storageOutputs: [{ name: "memory", version: nightly.learningMemoryVersion }] })}::jsonb))`
      : undefined;
    const claim = database
      .update(workflowAutomations)
      .set({ nextRunAt: next, lastRunAt: at, updatedAt: at })
      .where(
        and(
          eq(workflowAutomations.id, automation.id),
          eq(workflowAutomations.enabled, true),
          eq(
            workflowAutomations.officialBlueprintKey,
            automation.officialBlueprintKey,
          ),
          automation.nextRunAt === null
            ? isNull(workflowAutomations.nextRunAt)
            : eq(workflowAutomations.nextRunAt, automation.nextRunAt),
          sql`${workflowAutomations.lastRunAt} IS NOT DISTINCT FROM ${automation.lastRunAt}::timestamp`,
          nightly
            ? proactiveWorkflowOwnerEnabledSql(owner, agentId, nightly.kind)
            : jobsOwnerEnabledSql(owner, agentId),
          nightly ? nightlyCondition : runnableJobsExistSql(owner),
          sql`NOT EXISTS (SELECT 1 FROM agent_runs AS running WHERE running.workflow_automation_id = ${automation.id}::uuid AND running.status IN ('pending', 'running'))`,
          sql`NOT EXISTS (SELECT 1 FROM chat_events AS pending JOIN chat_automation_context AS context ON context.id = pending.context_id WHERE context.automation_id = ${automation.id}::uuid AND pending.run_id IS NULL AND pending.event_type = 'input.automation' AND NOT EXISTS (SELECT 1 FROM chat_events AS revoker WHERE revoker.revokes_event_id = pending.id))`,
        ),
      )
      .returning({ id: workflowAutomations.id });
    const queue = queuedChatThreadEnqueuePlan({
      chatThreadId,
      orgId: automation.orgId,
    });
    const cycle = nightly
      ? sql`INSERT INTO proactive_nightly_cycles
          (org_id, user_id, kind, review_date, timezone, scheduled_at, automation_id,
           event_id, learning_event_id, learning_memory_version)
          SELECT ${owner.orgId}, ${owner.userId}, ${nightly.kind}, ${nightly.reviewDate}::date,
            ${nightly.timezone}, ${nightly.scheduledAt}::timestamp, id, ${plan.row.id}::uuid,
            ${nightly.learningEventId}::uuid, ${nightly.learningMemoryVersion}
          FROM accepted_proactive_anchor
          ON CONFLICT (org_id, user_id, review_date, kind) DO NOTHING RETURNING id`
      : sql`SELECT id FROM accepted_proactive_anchor`;
    // Context is inserted only for the canonical event accepted in this statement.
    const inserted = (
      await database.execute(sql`WITH accepted_proactive_anchor AS (${claim.getSQL()}),
    accepted_proactive_cycle AS (${cycle}),
    ${canonicalChatEventAppendCtes([plan.row], plan.conflict, sql`EXISTS (SELECT 1 FROM accepted_proactive_cycle)`)},
    automation_context AS (
      INSERT INTO chat_automation_context (id, chat_thread_id, automation_id, workflow_name, event_type, event_payload, connector_source_id, trigger_brief, created_at)
      SELECT ${plan.context.id}::uuid, ${plan.context.chatThreadId}::uuid, ${plan.context.automationId}::uuid, ${plan.context.workflowName}, ${plan.context.eventType}, ${sql.param(plan.context.eventPayload, chatAutomationContext.eventPayload)}, ${plan.context.connectorSourceId}::uuid, ${plan.context.triggerBrief}, ${sql.param(plan.context.createdAt, chatAutomationContext.createdAt)} FROM inserted
      ON CONFLICT DO NOTHING RETURNING id
    ), queued AS (
      INSERT INTO queued_chat_threads (chat_thread_id, org_id, queued_at)
      SELECT ${chatThreadId}::uuid, ${automation.orgId}, ${sql.param(queue.values.queuedAt, queuedChatThreads.queuedAt)} FROM automation_context
      ON CONFLICT (chat_thread_id) DO UPDATE SET queued_at = greatest(EXCLUDED.queued_at, queued_chat_threads.queued_at + interval '1 millisecond')
    ) SELECT id FROM inserted`)
    ).rowCount;
    signal.throwIfAborted();
    return inserted === 0 ? null : { eventId: plan.row.id, committedAt: now() };
  },
);

/** Compose the existing append from plain values; SQL executes in the owner. */
function pendingTickRevocationSql(
  chatThreadId: string,
  targets: Parameters<typeof workflowScheduleRevocationRows>[0]["targets"],
  currentTime: Date,
) {
  return appendCanonicalChatEventsSql(
    workflowScheduleRevocationRows({ chatThreadId, targets, currentTime }),
    "any",
  );
}

function requireWorkflowInputInserted(
  inserted: number | null,
  conflict: PreparedWorkflowInputCommit["plan"]["conflict"],
): boolean {
  if (inserted === 0 && conflict === "none") {
    throw new Error("Workflow queue event insert returned no row");
  }
  return inserted !== 0;
}

const commitWorkflowInput$ = command(
  async (
    { set },
    input: PreparedWorkflowInputCommit,
    signal: AbortSignal,
  ): Promise<ChatInputEnqueueCommit | null> => {
    if (
      input.args.due.automation.officialBlueprintKey ===
        PROACTIVE_JOBS_BLUEPRINT_KEY ||
      input.args.proactiveNightlyOccurrence !== undefined
    ) {
      return await set(commitProactiveWorkflowInput$, input, signal);
    }
    const { args, plan, source, replacePendingTicks, model, timing } = input;
    const { automation, chatThreadId } = args.due;
    const queueTarget = { chatThreadId, orgId: automation.orgId };
    const { startedAt, marks, tickTiming } = createWorkflowSqlTiming();
    // Context + input + thread model replacement + queue + receipt/claim share
    // one rollback authority.
    // The finite callback performs only SQL, never commands or external I/O.
    const eventId = await set(writeDb$)
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0333; new non-billing transactions are prohibited.
      .transaction(async (tx) => {
        signal.throwIfAborted();
        // Event sequence precedes the context FK's thread KEY SHARE, matching
        // the pick/session writer's lock order (main #37567).
        marks.push({ step: "event", startedAt: now() });
        const inserted = (
          await tx.execute(
            appendCanonicalChatEventsSql([plan.row], plan.conflict),
          )
        ).rowCount;
        if (!requireWorkflowInputInserted(inserted, plan.conflict)) {
          return null;
        }
        // Context failure rolls back the sequence and event with this owner;
        // an idempotent loser never writes a new context.
        marks.push({ step: "context", startedAt: now() });
        await tx
          .insert(chatAutomationContext)
          .values(plan.context)
          .onConflictDoNothing();
        signal.throwIfAborted();
        const eventId = plan.row.id;
        if (args.scheduleClaim) {
          marks.push({ step: "schedule", startedAt: now() });
          const claim = args.scheduleClaim;
          const admittedAt = nowDate();
          if (
            (
              await tx.execute(
                consumeWorkflowScheduleAnchorSql(claim, admittedAt),
              )
            ).rowCount !== 1
          ) {
            throw new ScheduleOccurrenceUnavailableError();
          }
          if (
            (
              await tx.execute(
                journalWorkflowScheduleClaimSql(claim, eventId, admittedAt),
              )
            ).rowCount !== 1
          ) {
            throw new Error("Morning Brief schedule claim was not journaled");
          }
        }
        // Claim first, so a losing tick never revokes the winner. Manual runs
        // stay distinct. A batch preserves target ordering and context edges.
        if (replacePendingTicks) {
          tickTiming.lookupStartedAt = now();
          marks.push({ step: "ticks", startedAt: tickTiming.lookupStartedAt });
          const targets = await tx
            .select({
              id: chatEvents.id,
              createdAt: chatEvents.createdAt,
              contextType: chatEvents.contextType,
              contextId: chatEvents.contextId,
            })
            .from(chatEvents)
            .innerJoin(
              chatAutomationContext,
              eq(chatAutomationContext.id, chatEvents.contextId),
            )
            .where(
              pendingWorkflowScheduleTickCondition({
                chatThreadId,
                automationId: automation.id,
                eventId,
              }),
            )
            .orderBy(asc(chatEvents.seqId))
            .finally(tickTiming.finishLookup);
          tickTiming.targetCount = targets.length;
          if (targets.length > 0) {
            tickTiming.startRevocation();
            // Discard raw rows inside the owner; only the void promise is observed.
            await (async () => {
              await tx.execute(
                pendingTickRevocationSql(chatThreadId, targets, nowDate()),
              );
            })().finally(tickTiming.finishRevocation);
          }
        }
        marks.push({ step: "source", startedAt: now() });
        for (const step of source.steps) {
          const rowCount = (await tx.execute(step.statement)).rowCount;
          if (step.failure && rowCount === 0) {
            if (
              source.callbackDuplicateSql &&
              (await tx.execute(source.callbackDuplicateSql)).rowCount !== 0
            ) {
              throw new ChatRunFinishedAutomationAlreadyAdmittedError();
            }
            throw workflowSourceAdmissionError(step.failure);
          }
        }
        await applyThreadModelReplacement(tx, model.threadModelReplacement);
        marks.push({ step: "queue", startedAt: now() });
        const queuePlan = queuedChatThreadEnqueuePlan(queueTarget);
        await tx
          .insert(queuedChatThreads)
          .values(queuePlan.values)
          .onConflictDoUpdate(queuePlan.conflict);
        signal.throwIfAborted();
        marks.push({ step: "finished", startedAt: now() });
        return eventId;
      })
      .finally(() => {
        recordWorkflowSqlTimings(timing, marks, startedAt, tickTiming);
      });
    signal.throwIfAborted();
    return eventId === null ? null : { eventId, committedAt: now() };
  },
);

const workflowQueueDisplayName$ = command(
  async (
    { get },
    workflowId: string,
    timing: ApiDispatchTimingCollector,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const database = get(db$);
    const displayNameStartedAt = now();
    const [workflow] = await database
      .select({ displayName: workflows.displayName })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1)
      .finally(() => {
        safeSync(() => {
          return timing.recordElapsed(
            "api_dispatch_workflow_enqueue_display_name",
            "nested",
            displayNameStartedAt,
          );
        });
      });
    signal.throwIfAborted();
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    return workflow.displayName;
  },
);

function workflowAutomationAdmissionTiming(args: RunWorkflowAutomationNowArgs) {
  const timing = args.timing ?? new ApiDispatchTimingCollector();
  if (!args.timing) {
    timing.recordElapsed(
      "api_dispatch_pre_create_agent_workflow_automation_entrypoint_gap",
      "nested",
      args.apiStartTime,
    );
  }

  return timing;
}

export const runWorkflowAutomationNow$ = command(
  async (
    { set },
    args: RunWorkflowAutomationNowArgs,
    signal: AbortSignal,
  ): Promise<RunWorkflowAutomationResult> => {
    const { automation, chatThreadId } = args.due;
    const timing = workflowAutomationAdmissionTiming(args);

    const { scheduleClaim } = args;
    const replacePendingTicks = pendingTickReplacement(args);

    const model = await set(workflowAutomationInputModel$, args.due, signal);
    const displayName = await set(
      workflowQueueDisplayName$,
      automation.workflowId,
      timing,
      signal,
    );
    const source = await set(prepareWorkflowQueueSource$, args, signal);
    const plan = workflowAutomationQueueEventPlan({
      displayName,
      modelSelection: model.modelSelection,
      automation,
      queueEventId: args.queueEventId,
      workflowName: args.automationContext.workflowName,
      displayPrompt: workflowAutomationDisplayMessage(args.automationContext),
      agentRunSource: args.agentRunSource,
      workflowAutomationEventType: args.automationContext.eventType,
      workflowAutomationEventPayload: persistedWorkflowAutomationEventPayload(
        args.automationContext.event,
      ),
      connectorSourceId: args.connectorSourceId,
      chatThreadId,
      triggerBrief: args.triggerBrief,
    });
    signal.throwIfAborted();

    const schedulePath = workflowAdmissionSchedulePath(
      automation.kind,
      scheduleClaim !== undefined,
    );
    let admissionOutcome: WorkflowAdmissionOutcome = "failed";
    let enqueueCommit: ChatInputEnqueueCommit | undefined;
    const enqueued = await flushWorkflowAdmission(
      censusWorkflowAdmission(
        schedulePath,
        measureWorkflowAdmissionStep(
          timing,
          "api_dispatch_pre_create_agent_workflow_automation_queue_admission",
          async () => {
            const attempt = await settle(
              set(
                commitWorkflowInput$,
                { args, plan, source, replacePendingTicks, model, timing },
                signal,
              ),
            );
            if (!attempt.ok) {
              if (
                args.sourcePlan?.kind === "google-forms" &&
                isForeignKeyViolation(attempt.error)
              ) {
                throw new GoogleFormsSourceTransitionChangedError();
              }
              if (attempt.error instanceof ScheduleOccurrenceUnavailableError) {
                admissionOutcome = "superseded";
                return false;
              }
              throw attempt.error;
            }
            if (
              attempt.value === null &&
              automation.officialBlueprintKey === PROACTIVE_JOBS_BLUEPRINT_KEY
            ) {
              admissionOutcome = "superseded";
              return false;
            }
            enqueueCommit = attempt.value ?? undefined;
            admissionOutcome = "inserted";
            return true;
          },
          () => {
            return {
              schedule_path: schedulePath,
              admission_outcome: admissionOutcome,
            };
          },
        ),
        () => {
          return admissionOutcome;
        },
      ),
      () => {
        timing.flushWithoutRun(
          {
            schedule_path: schedulePath,
            admission_outcome: admissionOutcome,
            ...(args.triggerSource
              ? { trigger_source: args.triggerSource }
              : {}),
          },
          admissionOutcome !== "failed",
        );
      },
    );
    signal.throwIfAborted();

    if (enqueued) {
      waitUntil(
        set(
          publishEnqueuedWorkflowInput$,
          {
            orgId: automation.orgId,
            userId: automation.ownerUserId,
            chatThreadId,
            ...(enqueueCommit ? { enqueueCommit } : {}),
          },
          signal,
        ),
      );
      waitUntil(set(notifyRunningChatRunOfPendingInput$, chatThreadId, signal));
    }
    return workflowEnqueueResult(
      scheduleClaim !== undefined ||
        automation.officialBlueprintKey === PROACTIVE_JOBS_BLUEPRINT_KEY,
      enqueued,
    );
  },
);
