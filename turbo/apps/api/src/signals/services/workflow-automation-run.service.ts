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
import { enqueueChatInput$ } from "./chat-thread-queue-drain.service";
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
 * a journaled schedule occurrence, then persist any trigger-source transition.
 * Neither present means the event is admitted without a caller-owned write.
 *
 * A journaled tick replaces this automation's older pending ticks only after
 * its own claim succeeded, in the same transaction and excluding its new
 * event, so a tick that loses the occurrence never revokes the winner's event.
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
  if (!scheduleClaim && !persistSourceTransition) {
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
        if (replacePendingTicks) {
          await revokePendingScheduleTicks(tx, {
            ...replacePendingTicks,
            excludeEventId: eventId,
          });
        }
      }
      await persistSourceTransition?.(tx);
    },
  };
}

/**
 * Automation-event producer. Producer-owned state stays here: an automated
 * schedule tick first revokes this automation's still-pending tick, and a
 * journaled Morning Brief occurrence and any trigger-source transition commit
 * with the queue event. The event then goes through the single chat enqueue
 * entry like every other input.
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
    // An unjournaled tick's occurrence was already claimed by the cron before
    // this call, so it may replace older ticks up front. A journaled tick
    // replaces them only after its own claim succeeds (see above).
    if (replacePendingTicks && !scheduleClaim) {
      await revokePendingScheduleTicks(db, replacePendingTicks);
      signal.throwIfAborted();
    }

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
            set(
              enqueueChatInput$,
              {
                chatThreadId,
                orgId: automation.orgId,
                apiStartTime: args.apiStartTime,
                dispatchFailedCallbacks: args.dispatchFailedCallbacks,
                automationTiming: timing,
                appendInput,
                ...queueAdmissionSourceTransition({
                  scheduleClaim,
                  persistSourceTransition,
                  replacePendingTicks,
                }),
              },
              signal,
            ),
          );
          if (!attempt.ok) {
            if (attempt.error instanceof ScheduleOccurrenceUnavailableError) {
              admissionOutcome = "superseded";
              return null;
            }
            throw attempt.error;
          }
          admissionOutcome = "inserted";
          return attempt.value;
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

    // A superseded occurrence starts no run and adds no queue item; the claim
    // plan's owner records why.
    if (!enqueued) {
      return { kind: "enqueued" };
    }
    await publishChatThreadMessageCreatedSafely({
      userId: automation.ownerUserId,
      orgId: automation.orgId,
      threadId: chatThreadId,
    });
    signal.throwIfAborted();

    const { eventId, pick } = enqueued;
    if (eventId === null || pick.eventId !== eventId) {
      return { kind: "enqueued" };
    }
    if (pick.reason === "launched" && pick.runId !== undefined) {
      return { kind: "ok", runId: pick.runId };
    }
    if (pick.reason === "rejected") {
      return (
        pick.rejection ?? {
          kind: "conflict",
          message: "Workflow queue event was rejected",
        }
      );
    }
    return { kind: "enqueued" };
  },
);
