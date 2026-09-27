import { command } from "ccstate";

import type { Tx } from "../../lib/db-types";
import { writeDb$ } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { settle } from "../utils";
import {
  revokePendingScheduleTicks,
  ScheduleOccurrenceUnavailableError,
  workflowAutomationQueueEventWriter,
  type PersistWorkflowQueueSourceTransition,
  type WorkflowScheduleClaimPlan,
} from "./workflow-chat-event-queue.service";
import {
  censusWorkflowAdmission,
  measureWorkflowAdmissionStep,
  type WorkflowAdmissionOutcome,
  type WorkflowAdmissionSchedulePath,
} from "./workflow-queue-admission-timing.service";
import {
  enqueueChatInput,
  scheduleEnqueuedChatThreadPick$,
} from "./chat-thread-queue-drain.service";
import { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import {
  persistedWorkflowAutomationEventPayload,
  workflowAutomationDisplayMessage,
} from "./workflow-automation-context.service";
import type {
  RunWorkflowAutomationNowArgs,
  RunWorkflowAutomationResult,
} from "./workflow-automation-launch.service";

/**
 * The producer-owned write that commits with the queue event: claim and bind
 * a journaled schedule occurrence, coalesce this automation's older
 * unconsumed ticks, then persist any trigger-source transition.
 *
 * Coalescing runs after the new tick's own claim succeeded, in its insert
 * transaction and excluding its new event, so a tick that loses the
 * occurrence never revokes the winner's event.
 */
function queueAdmissionSourceTransition(args: {
  readonly scheduleClaim: WorkflowScheduleClaimPlan | undefined;
  readonly persistSourceTransition:
    | PersistWorkflowQueueSourceTransition
    | undefined;
  readonly replacePendingTicks:
    | { readonly chatThreadId: string; readonly automationId: string }
    | undefined;
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
        const claim = await scheduleClaim.claim(tx);
        if (claim.kind === "unavailable") {
          throw new ScheduleOccurrenceUnavailableError();
        }
        await scheduleClaim.bindQueueEvent(tx, {
          claimId: claim.claimId,
          queueEventId: eventId,
        });
      }
      if (replacePendingTicks) {
        await revokePendingScheduleTicks(tx, {
          ...replacePendingTicks,
          excludeEventId: eventId,
        });
      }
      await persistSourceTransition?.(tx);
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
    });
    signal.throwIfAborted();

    const schedulePath: WorkflowAdmissionSchedulePath =
      automation.kind !== "schedule"
        ? "non_schedule"
        : scheduleClaim
          ? "journaled_schedule"
          : "unjournaled_schedule";
    let admissionOutcome: WorkflowAdmissionOutcome = "failed";
    const enqueued = await censusWorkflowAdmission(
      schedulePath,
      measureWorkflowAdmissionStep(
        timing,
        "api_dispatch_pre_create_agent_workflow_automation_queue_admission",
        async () => {
          const attempt = await settle(
            enqueueChatInput(db, {
              chatThreadId,
              orgId: automation.orgId,
              appendInput,
              ...queueAdmissionSourceTransition({
                scheduleClaim,
                persistSourceTransition,
                replacePendingTicks,
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
    );
    signal.throwIfAborted();
    // The entry's timing ends at the enqueue commit; the background pick and
    // the launch are measured by the pick itself.
    timing.flushWithoutRun(
      args.triggerSource ? { trigger_source: args.triggerSource } : undefined,
    );

    // A superseded occurrence adds no queue item; the claim plan's owner
    // records why.
    if (enqueued) {
      set(scheduleEnqueuedChatThreadPick$, {
        chatThreadId,
        publish: async () => {
          await publishChatThreadMessageCreatedSafely({
            userId: automation.ownerUserId,
            orgId: automation.orgId,
            threadId: chatThreadId,
          });
        },
      });
    }
    return { kind: "enqueued" };
  },
);
