import { command } from "ccstate";
import type { Tx } from "../../lib/db-types";
import { writeDb$ } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { settle, settleIncludingAbort } from "../utils";
import { waitUntil } from "../context/wait-until";
import { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import type { ChatInputEnqueueCommit } from "./chat-input-enqueue-observation";
import {
  enqueueChatInput,
  pickEnqueuedChatThread$,
  notifyRunningChatRunOfPendingInput$,
} from "./chat-thread-queue-drain.service";
import {
  persistedWorkflowAutomationEventPayload,
  workflowAutomationDisplayMessage,
} from "./workflow-automation-context.service";
import {
  revokePendingScheduleTicks,
  ScheduleOccurrenceUnavailableError,
  workflowAutomationQueueEventWriter,
  type PersistWorkflowQueueSourceTransition,
  type RunWorkflowAutomationNowArgs,
  type RunWorkflowAutomationResult,
  type WorkflowScheduleClaimPlan,
} from "./workflow-automation-enqueue.service";
import {
  censusWorkflowAdmission,
  measureWorkflowAdmissionStep,
  type WorkflowAdmissionOutcome,
  type WorkflowAdmissionSchedulePath,
} from "./workflow-queue-admission-timing.service";
import { persistWorkflowScheduleOccurrence } from "./workflow-schedule-queue.service";

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

const WORKFLOW_ENQUEUE_ACTIONS = {
  transaction: "api_dispatch_workflow_enqueue_transaction",
  callback: "api_dispatch_workflow_enqueue_transaction_callback",
  queue_upsert: "api_dispatch_workflow_enqueue_queue_upsert",
} as const;

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

/**
 * The producer-owned write that commits with the queue event: claim and bind
 * a journaled schedule occurrence, coalesce this automation's older
 * unconsumed ticks, then persist any trigger-source transition.
 *
 * Coalescing runs after the new tick's own claim succeeded, in its insert
 * transaction and excluding its new event, so a tick that loses the
 * occurrence never revokes the winner's event.
 */
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

function queueAdmissionSourceTransition(args: {
  readonly scheduleClaim: WorkflowScheduleClaimPlan | undefined;
  readonly persistSourceTransition:
    | PersistWorkflowQueueSourceTransition
    | undefined;
  readonly replacePendingTicks:
    | { readonly chatThreadId: string; readonly automationId: string }
    | undefined;
  readonly timing: ApiDispatchTimingCollector;
}): {
  readonly persistSourceTransition?: (tx: Tx, eventId: string) => Promise<void>;
} {
  const { scheduleClaim, persistSourceTransition, replacePendingTicks } = args;
  if (!scheduleClaim && !persistSourceTransition && !replacePendingTicks) {
    return {};
  }
  return {
    persistSourceTransition: async (tx, eventId) => {
      if (scheduleClaim) {
        await measureWorkflowAdmissionStep(
          args.timing,
          "api_dispatch_workflow_enqueue_schedule_claim",
          () => {
            return persistWorkflowScheduleOccurrence(
              tx,
              scheduleClaim,
              eventId,
            );
          },
        );
      }
      if (replacePendingTicks) {
        await measureWorkflowAdmissionStep(
          args.timing,
          "api_dispatch_workflow_enqueue_replace_pending_ticks",
          async () => {
            await revokePendingScheduleTicks(tx, {
              ...replacePendingTicks,
              excludeEventId: eventId,
            });
          },
        );
      }
      if (persistSourceTransition) {
        await measureWorkflowAdmissionStep(
          args.timing,
          "api_dispatch_workflow_enqueue_source_transition",
          async () => {
            await persistSourceTransition(tx);
          },
        );
      }
    },
  };
}

/**
 * Workflow entry for every trigger. Entry-owned state stays here: an automated
 * schedule tick coalesces this automation's older unconsumed ticks, and a
 * journaled Morning Brief occurrence and any trigger-source transition commit
 * with the queue event. The event and its automation context then go through
 * the single chat enqueue, and the thread is picked in the background: no
 * trigger waits for a launch, and a launch rejection appears in the thread as
 * `input.rejected`.
 */
export const runWorkflowAutomationNow$ = command(
  async (
    { set },
    args: RunWorkflowAutomationNowArgs,
    signal: AbortSignal,
  ): Promise<RunWorkflowAutomationResult> => {
    const db = set(writeDb$);
    const { automation, chatThreadId } = args.due;
    const timing = args.timing ?? new ApiDispatchTimingCollector();
    if (!args.timing) {
      timing.recordElapsed(
        "api_dispatch_pre_create_agent_workflow_automation_entrypoint_gap",
        "nested",
        args.apiStartTime,
      );
    }

    const { scheduleClaim, persistSourceTransition } = args;
    const replacePendingTicks =
      automation.kind === "schedule" &&
      args.replacePendingScheduleTick !== false
        ? { chatThreadId, automationId: automation.id }
        : undefined;

    const appendInput = await workflowAutomationQueueEventWriter(db, {
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
      timing,
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
              enqueueChatInput(db, {
                chatThreadId,
                orgId: automation.orgId,
                onCommitted: (receipt) => {
                  enqueueCommit = receipt;
                },
                appendInput,
                measureStep: (step, operation) => {
                  return measureWorkflowAdmissionStep(
                    timing,
                    WORKFLOW_ENQUEUE_ACTIONS[step],
                    operation,
                  );
                },
                ...queueAdmissionSourceTransition({
                  scheduleClaim,
                  persistSourceTransition,
                  replacePendingTicks,
                  timing,
                }),
              }),
            );
            if (!attempt.ok) {
              if (attempt.error instanceof ScheduleOccurrenceUnavailableError) {
                admissionOutcome = "superseded";
                return false;
              }
              throw attempt.error;
            }
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
