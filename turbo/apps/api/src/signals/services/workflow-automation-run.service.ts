import { AUTO_SELECTED_MODEL } from "@okouai/core/auto-run-model";
import { synchronizeOfficialWorkflowThread$ } from "./official-workflow-thread.service";
import {
  threadModelReplacementWritePlan,
  resolveEnqueuedChatInputModel$,
  type EnqueuedChatInputModel,
} from "./chat-input-model.service";
import { command } from "ccstate";
import { db$, writeDb$ } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { safeSync, settle, settleIncludingAbort } from "../utils";
import { waitUntil } from "../context/wait-until";
import { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
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
  type RunWorkflowAutomationNowArgs,
  type RunWorkflowAutomationResult,
} from "./workflow-automation-enqueue.service";
import {
  censusWorkflowAdmission,
  recordWorkflowAdmissionDuration,
  type WorkflowAdmissionOutcome,
  type WorkflowAdmissionSchedulePath,
} from "./workflow-queue-admission-timing.service";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq, isNull, sql } from "drizzle-orm";
import { now, nowDate } from "../../lib/time";
import { parseRawRows } from "../../lib/db-raw-rows";
import {
  workflowInputCommitSql,
  workflowInputCommitRowSchema,
  workflowInputRollbackReason,
} from "./workflow-input-commit-plan";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { queuedChatThreadEnqueuePlan } from "./queued-chat-thread.service";
import { canonicalChatEventAppendCtes } from "./chat-event-append.service";
import { PROACTIVE_JOBS_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/proactive-jobs";
import { runnableJobsExistSql } from "./user-jobs-query";
import { proactiveWorkflowKind } from "./proactive-workflow-definitions";
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
  googleFormsQueueReceiptPlan,
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
              ...googleFormsQueueReceiptPlan(plan.source, nowDate()),
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

interface PreparedWorkflowInputCommit {
  readonly args: RunWorkflowAutomationNowArgs;
  readonly plan: ReturnType<typeof workflowAutomationQueueEventPlan>;
  readonly source: WorkflowSourceAdmissionPlan;
  readonly replacePendingTicks: ReturnType<typeof pendingTickReplacement>;
  readonly model: EnqueuedChatInputModel;
  readonly timing: ApiDispatchTimingCollector;
}

/** Each Proactive schedule anchor and its queue input commit together. */
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
        "Proactive admission requires an Official schedule without an external event source",
      );
    }
    const database = set(writeDb$);
    const at = nowDate();
    const owner = { orgId: automation.orgId, userId: automation.ownerUserId };
    const kind = proactiveWorkflowKind(args.automationContext.workflowName);
    if (kind === null || kind === "suggestions") {
      throw new Error("Expected a Tasks, Learning or Planning schedule");
    }
    if (kind !== "jobs" && automation.cronExpression === null) {
      throw new Error("Nightly workflow is missing its cron schedule");
    }
    const next =
      automation.cronExpression === null
        ? null
        : calculateNextRun(automation.cronExpression, automation.timezone, at);
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
          proactiveWorkflowOwnerEnabledSql(owner, agentId, kind),
          kind === "jobs"
            ? runnableJobsExistSql(owner)
            : sql`EXISTS (SELECT 1 FROM org_members_metadata AS preference
                WHERE preference.org_id = ${owner.orgId} AND preference.user_id = ${owner.userId}
                  AND preference.timezone = ${automation.timezone})`,
          sql`NOT EXISTS (SELECT 1 FROM agent_runs AS running WHERE running.workflow_automation_id = ${automation.id}::uuid AND running.status IN ('pending', 'running'))`,
          sql`NOT EXISTS (SELECT 1 FROM chat_events AS pending JOIN chat_automation_context AS context ON context.id = pending.context_id WHERE context.automation_id = ${automation.id}::uuid AND pending.run_id IS NULL AND pending.event_type = 'input.automation' AND NOT EXISTS (SELECT 1 FROM chat_events AS revoker WHERE revoker.revokes_event_id = pending.id))`,
        ),
      )
      .returning({ id: workflowAutomations.id });
    const queue = queuedChatThreadEnqueuePlan({
      chatThreadId,
      orgId: automation.orgId,
    });
    // Context is inserted only for the canonical event accepted in this statement.
    const inserted = (
      await database.execute(sql`WITH accepted_proactive_anchor AS (${claim.getSQL()}),
    ${canonicalChatEventAppendCtes([plan.row], plan.conflict, sql`EXISTS (SELECT 1 FROM accepted_proactive_anchor)`)},
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

function usesProactiveWorkflowInput(input: PreparedWorkflowInputCommit) {
  const proactiveKind =
    input.args.due.automation.officialBlueprintKey === null
      ? null
      : proactiveWorkflowKind(input.args.automationContext.workflowName);
  return (
    input.args.due.automation.officialBlueprintKey ===
      PROACTIVE_JOBS_BLUEPRINT_KEY ||
    (input.args.automationContext.eventType === "schedule" &&
      (proactiveKind === "learning" || proactiveKind === "planning"))
  );
}

const commitWorkflowInput$ = command(
  async (
    { set },
    input: PreparedWorkflowInputCommit,
    signal: AbortSignal,
  ): Promise<ChatInputEnqueueCommit | null> => {
    if (usesProactiveWorkflowInput(input)) {
      return await set(commitProactiveWorkflowInput$, input, signal);
    }
    signal.throwIfAborted();
    const { args, plan, source, replacePendingTicks, model, timing } = input;
    const { automation, chatThreadId } = args.due;
    const database = set(writeDb$);
    const startedAt = now();
    const currentTime = nowDate();
    const queue = queuedChatThreadEnqueuePlan({
      chatThreadId,
      orgId: automation.orgId,
    });
    const queueStatement = database
      .insert(queuedChatThreads)
      .select(
        sql`SELECT ${queue.values.chatThreadId}::uuid, ${queue.values.orgId},
        ${sql.param(queue.values.queuedAt, queuedChatThreads.queuedAt)}, NULL::uuid, NULL::timestamp
        FROM inserted`,
      )
      .onConflictDoUpdate(queue.conflict)
      .returning({ id: queuedChatThreads.chatThreadId })
      .getSQL();
    const replacement = model.threadModelReplacement;
    const write = replacement
      ? threadModelReplacementWritePlan(replacement, currentTime)
      : null;
    const replacementPlan = write
      ? {
          statement: database
            .update(write.table)
            .set(write.values)
            .where(and(write.where, sql`EXISTS (SELECT 1 FROM inserted)`))
            .returning(write.returning)
            .getSQL(),
          eventScope: write.eventScope,
        }
      : undefined;
    const statement = workflowInputCommitSql({
      plan,
      source,
      automationId: automation.id,
      currentTime,
      replacePendingTicks: replacePendingTicks !== undefined,
      scheduleClaim: args.scheduleClaim,
      queueStatement,
      replacement: replacementPlan,
    });
    let tickCount: number | undefined;
    const executionStartedAt = now();
    const result = await settle(
      (async () => {
        const [row] = parseRawRows(
          workflowInputCommitRowSchema,
          await database.execute(statement),
        );
        signal.throwIfAborted();
        if (!row || row.guard !== 0) {
          throw new Error("Workflow queue commit returned no accepted input");
        }
        tickCount = row.tickCount;
        return row.eventId;
      })().finally(() => {
        safeSync(() => {
          const finishedAt = now();
          const dimensions =
            tickCount === undefined
              ? undefined
              : {
                  workflow_pending_tick_target_count_bucket:
                    workflowPendingTickTargetCountBucket(tickCount),
                };
          // Keep the historical total metric; leaf timings no longer describe
          // separate round trips in this atomic statement.
          timing.recordElapsed(
            "api_dispatch_workflow_enqueue_transaction",
            "nested",
            startedAt,
            finishedAt,
            dimensions,
          );
          timing.recordElapsed(
            "api_dispatch_workflow_enqueue_transaction_callback",
            "nested",
            executionStartedAt,
            finishedAt,
            dimensions,
          );
        });
      }),
    );
    signal.throwIfAborted();
    if (!result.ok) {
      const reason = workflowInputRollbackReason(result.error);
      if (reason === "DUPLICATE") {
        return null;
      }
      if (reason === "SCHEDULE") {
        throw new ScheduleOccurrenceUnavailableError();
      }
      if (reason === "JOURNAL") {
        throw new Error("Morning Brief schedule claim was not journaled");
      }
      const failed = source.steps.find((_, index) => {
        return reason === `SOURCE_${String(index)}`;
      });
      if (failed?.failure) {
        // The failed statement rolled back. Read a fresh snapshot to recognize
        // a receipt committed by the concurrent callback winner.
        if (source.callbackDuplicateSql) {
          const duplicate = (
            await database.execute(source.callbackDuplicateSql)
          ).rowCount;
          signal.throwIfAborted();
          if (duplicate !== 0) {
            throw new ChatRunFinishedAutomationAlreadyAdmittedError();
          }
        }
        throw workflowSourceAdmissionError(failed.failure);
      }
      throw result.error;
    }
    return { eventId: result.value, committedAt: now() };
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

function workflowQueueArgs(
  args: RunWorkflowAutomationNowArgs,
  model: EnqueuedChatInputModel,
  displayName: string | null,
  automation: RunWorkflowAutomationNowArgs["due"]["automation"],
  chatThreadId: string,
) {
  return {
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
  };
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
    const plan = workflowAutomationQueueEventPlan(
      workflowQueueArgs(args, model, displayName, automation, chatThreadId),
    );
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
        (async () => {
          const startedAt = performance.now();
          const measured = await settleIncludingAbort(
            (async () => {
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
                if (
                  attempt.error instanceof ScheduleOccurrenceUnavailableError
                ) {
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
            })(),
          );
          await recordWorkflowAdmissionDuration(
            timing,
            "api_dispatch_pre_create_agent_workflow_automation_queue_admission",
            performance.now() - startedAt,
            () => {
              return {
                schedule_path: schedulePath,
                admission_outcome: admissionOutcome,
              };
            },
          );
          if (!measured.ok) {
            throw measured.error;
          }
          return measured.value;
        })(),
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
