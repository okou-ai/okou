import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { admitWorkflowAutomationEvent } from "./workflow-chat-event-queue.service";
import { drainChatThreadQueueForThread$ } from "./chat-thread-queue-drain.service";
import {
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
} from "./api-dispatch-timing.service";
import {
  persistedWorkflowAutomationEventPayload,
  workflowAutomationDisplayMessage,
} from "./workflow-automation-context.service";
import type {
  RunWorkflowAutomationNowArgs,
  RunWorkflowAutomationResult,
} from "./workflow-automation-launch.service";

/**
 * Durable automation-event ingress. Every event enters the chat thread queue
 * before the shared scheduler prepares a run; the run persistence transaction
 * later owns the authoritative queue claim.
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

    const admission = await measureApiDispatchTiming(
      timing,
      "api_dispatch_pre_create_agent_workflow_automation_queue_admission",
      "nested",
      async () => {
        return await admitWorkflowAutomationEvent(db, {
          automation,
          workflowName: args.automationContext.workflowName,
          displayPrompt: workflowAutomationDisplayMessage(
            args.automationContext,
          ),
          agentRunSource: args.agentRunSource,
          workflowAutomationEventType: args.automationContext.eventType,
          workflowAutomationEventPayload:
            persistedWorkflowAutomationEventPayload(
              args.automationContext.event,
            ),
          connectorSourceId: args.connectorSourceId,
          publicBrand: args.publicBrand,
          chatThreadId,
          triggerSource: args.triggerSource ?? "automation-schedule",
          triggerBrief: args.triggerBrief,
          coalescePendingScheduleRun: args.coalescePendingScheduleRun !== false,
          persistSourceTransition: args.persistSourceTransition,
          scheduleClaim: args.scheduleClaim,
        });
      },
    );
    signal.throwIfAborted();

    // An unconsumed occurrence starts no run and adds no queue item, exactly
    // like a coalesced tick. The claim plan's owner records why, so the
    // scheduler accounts for it without widening this shared result type.
    if (admission.kind === "schedule_unavailable") {
      return { kind: "enqueued" };
    }

    if (admission.kind === "inserted") {
      await publishChatThreadMessageCreatedSafely({
        userId: automation.ownerUserId,
        orgId: automation.orgId,
        threadId: chatThreadId,
      });
      signal.throwIfAborted();
    }

    const drained = await set(
      drainChatThreadQueueForThread$,
      {
        chatThreadId,
        dispatchFailedCallbacks: args.dispatchFailedCallbacks,
        ...(admission.kind === "inserted"
          ? {
              automationEventLaunch: {
                eventId: admission.eventId,
                apiStartTime: args.apiStartTime,
                timing,
              },
            }
          : {}),
      },
      signal,
    );
    signal.throwIfAborted();

    if (
      admission.kind === "inserted" &&
      drained?.eventId === admission.eventId
    ) {
      return drained.result;
    }
    return { kind: "enqueued" };
  },
);
