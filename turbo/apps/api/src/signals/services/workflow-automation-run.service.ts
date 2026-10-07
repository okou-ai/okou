import { resolveEnqueuedChatInputModel$ } from "./chat-input-model.service";
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
import { connectors } from "@okouai/db/schema/connector";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { and, asc, eq, inArray } from "drizzle-orm";
import { now, nowDate } from "../../lib/time";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { queuedChatThreadEnqueuePlan } from "./queued-chat-thread.service";
import { appendCanonicalChatEventsSql } from "./chat-event-append.service";
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
import {
  stripeSourceCredentialAccess,
  stripeQueueAdmissionPlan,
  type StripeQueueSource,
  StripeDeliveryTargetChangedError,
} from "./workflow-stripe-queue.service";
import {
  ORG_SENTINEL_USER_ID,
  userFeatureSwitchOverridesFromRows,
} from "./feature-switch-scope";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";

const publishEnqueuedWorkflowInput$ = command(
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

const prepareStripeQueueSource$ = command(
  async (
    { get },
    args: {
      readonly source: StripeQueueSource;
      readonly snapshot: ConnectorRuntimeSnapshot;
      readonly chatThreadId: string;
    },
    signal: AbortSignal,
  ): Promise<WorkflowSourceAdmissionPlan> => {
    const database = get(db$);
    const { source } = args;
    const [connector] = await database
      .select()
      .from(connectors)
      .where(eq(connectors.id, source.connectorId))
      .limit(1);
    signal.throwIfAborted();
    const [consumer] = await database
      .select()
      .from(workflowAutomations)
      .where(eq(workflowAutomations.id, source.automationId))
      .limit(1);
    signal.throwIfAborted();
    const access = stripeSourceCredentialAccess(
      source,
      consumer,
      connector,
      args.snapshot,
    );
    if (!consumer || !connector) {
      throw new StripeDeliveryTargetChangedError(
        "automation_target_unavailable",
      );
    }
    const overrides = await database
      .select({
        userId: userFeatureSwitches.userId,
        switches: userFeatureSwitches.switches,
      })
      .from(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, source.orgId),
          inArray(userFeatureSwitches.userId, [
            source.userId,
            ORG_SENTINEL_USER_ID,
          ]),
        ),
      );
    signal.throwIfAborted();
    // Brief feature-switch staleness is accepted. Execution authority and
    // the delivery revision are still checked by this owner's SQL transaction.
    if (
      !isFeatureEnabled(FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations, {
        orgId: source.orgId,
        userId: source.userId,
        overrides: userFeatureSwitchOverridesFromRows(overrides, source.userId),
      })
    ) {
      throw new StripeDeliveryTargetChangedError("feature_disabled");
    }
    return stripeQueueAdmissionPlan({
      source,
      chatThreadId: args.chatThreadId,
      automation: consumer,
      connector,
      access,
      currentTime: nowDate(),
    });
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
      case "stripe": {
        return await set(
          prepareStripeQueueSource$,
          {
            source: plan.source,
            snapshot: plan.snapshot,
            chatThreadId: args.due.chatThreadId,
          },
          signal,
        );
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
  readonly timing: ApiDispatchTimingCollector;
}

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
    const { args, plan, source, replacePendingTicks, timing } = input;
    const { automation, chatThreadId } = args.due;
    const queueTarget = { chatThreadId, orgId: automation.orgId };
    const { startedAt, marks, tickTiming } = createWorkflowSqlTiming();
    // Context + input + queue + receipt/claim share one rollback authority.
    // The finite callback performs only SQL, never commands or external I/O.
    const eventId = await set(writeDb$)
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

export const runWorkflowAutomationNow$ = command(
  async (
    { set },
    args: RunWorkflowAutomationNowArgs,
    signal: AbortSignal,
  ): Promise<RunWorkflowAutomationResult> => {
    const { automation, chatThreadId } = args.due;
    const timing = args.timing ?? new ApiDispatchTimingCollector();
    if (!args.timing) {
      timing.recordElapsed(
        "api_dispatch_pre_create_agent_workflow_automation_entrypoint_gap",
        "nested",
        args.apiStartTime,
      );
    }

    const { scheduleClaim } = args;
    const replacePendingTicks = pendingTickReplacement(args);

    const modelSelection = await set(
      workflowAutomationInputModel$,
      args.due,
      signal,
    );
    const displayName = await set(
      workflowQueueDisplayName$,
      automation.workflowId,
      timing,
      signal,
    );
    const source = await set(prepareWorkflowQueueSource$, args, signal);
    const plan = workflowAutomationQueueEventPlan({
      displayName,
      modelSelection,
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
                { args, plan, source, replacePendingTicks, timing },
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
    return workflowEnqueueResult(scheduleClaim !== undefined, enqueued);
  },
);
