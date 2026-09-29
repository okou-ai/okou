import { enqueueStripeWorkflowInput$ } from "./workflow-stripe-queue.service";
import { enqueueNotionWorkflowInput$ } from "./workflow-notion-queue.service";
import { enqueueGoogleMeetWorkflowInput$ } from "./workflow-google-meet-queue.service";
import { enqueueWorkflowInput$ } from "./workflow-input-queue.service";
import { enqueueGmailWorkflowInput$ } from "./workflow-gmail-queue.service";
import { enqueueGoogleCalendarWorkflowInput$ } from "./workflow-google-calendar-queue.service";
import { command } from "ccstate";

import type { Tx } from "../../lib/db-types";
import { writeDb$ } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { settle, settleIncludingAbort } from "../utils";
import {
  revokePendingScheduleTicks,
  prepareWorkflowAutomationQueueInput$,
  ScheduleOccurrenceUnavailableError,
  workflowAutomationQueueEventWriter,
  type WorkflowScheduleClaimPlan,
  type PreparedWorkflowAutomationQueueInput,
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
import { enqueueGoogleFormsWorkflowInput$ } from "./workflow-google-forms-queue.service";

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
  readonly replacePendingTicks:
    | { readonly chatThreadId: string; readonly automationId: string }
    | undefined;
  readonly timing: ApiDispatchTimingCollector;
}): {
  readonly persistSourceTransition?: (tx: Tx, eventId: string) => Promise<void>;
} {
  const { scheduleClaim, replacePendingTicks } = args;
  if (!scheduleClaim && !replacePendingTicks) {
    return {};
  }
  return {
    persistSourceTransition: async (tx, eventId) => {
      if (scheduleClaim) {
        const claim = await measureWorkflowAdmissionStep(
          args.timing,
          "api_dispatch_workflow_enqueue_schedule_claim",
          async () => {
            return await scheduleClaim.claim(tx);
          },
        );
        if (claim.kind === "unavailable") {
          throw new ScheduleOccurrenceUnavailableError();
        }
        await measureWorkflowAdmissionStep(
          args.timing,
          "api_dispatch_workflow_enqueue_event_binding",
          async () => {
            await scheduleClaim.bindQueueEvent(tx, {
              claimId: claim.claimId,
              queueEventId: eventId,
            });
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
    },
  };
}

function workflowQueueSchedulePath(
  args: RunWorkflowAutomationNowArgs,
): WorkflowAdmissionSchedulePath {
  return args.due.automation.kind !== "schedule"
    ? "non_schedule"
    : args.scheduleClaim
      ? "journaled_schedule"
      : "unjournaled_schedule";
}

function workflowQueueInputPreparation(
  args: RunWorkflowAutomationNowArgs,
  timing: ApiDispatchTimingCollector,
) {
  if (
    (args.googleFormsSource ||
      args.googleCalendarSource ||
      args.gmailSource ||
      args.googleMeetSource ||
      args.notionSource ||
      args.stripeSource ||
      args.queueReceipt) &&
    (args.scheduleClaim || args.due.automation.kind === "schedule")
  ) {
    throw new Error(
      "Provider watch admission cannot carry another source transition",
    );
  }
  return {
    automation: args.due.automation,
    queueEventId: args.queueEventId,
    workflowName: args.automationContext.workflowName,
    displayPrompt: workflowAutomationDisplayMessage(args.automationContext),
    agentRunSource: args.agentRunSource,
    workflowAutomationEventType: args.automationContext.eventType,
    workflowAutomationEventPayload: persistedWorkflowAutomationEventPayload(
      args.automationContext.event,
    ),
    connectorSourceId: args.connectorSourceId,
    chatThreadId: args.due.chatThreadId,
    triggerBrief: args.triggerBrief,
    timing,
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
function workflowQueueAdmissionStepAction(
  step: "transaction" | "callback" | "queue_upsert",
) {
  const actions = {
    transaction: "api_dispatch_workflow_enqueue_transaction",
    callback: "api_dispatch_workflow_enqueue_transaction_callback",
    queue_upsert: "api_dispatch_workflow_enqueue_queue_upsert",
  } as const;
  return actions[step];
}

function workflowQueueEntryTiming(
  supplied: ApiDispatchTimingCollector | undefined,
  apiStartTime: RunWorkflowAutomationNowArgs["apiStartTime"],
) {
  const timing = supplied ?? new ApiDispatchTimingCollector();
  if (!supplied) {
    timing.recordElapsed(
      "api_dispatch_pre_create_agent_workflow_automation_entrypoint_gap",
      "nested",
      apiStartTime,
    );
  }
  return timing;
}

type WorkflowQueueSources = Pick<
  RunWorkflowAutomationNowArgs,
  | "googleFormsSource"
  | "googleCalendarSource"
  | "gmailSource"
  | "googleMeetSource"
  | "notionSource"
  | "stripeSource"
  | "queueReceipt"
>;

function hasWorkflowQueueSource(source: WorkflowQueueSources): boolean {
  return Boolean(
    source.googleFormsSource ||
    source.googleCalendarSource ||
    source.gmailSource ||
    source.googleMeetSource ||
    source.notionSource ||
    source.stripeSource,
  );
}

/** Route prepared business values to the command that owns that source's SQL. */
const enqueuePreparedWorkflowInput$ = command(
  async (
    { set },
    input: PreparedWorkflowAutomationQueueInput,
    source: WorkflowQueueSources,
    orgId: string,
    signal: AbortSignal,
  ): Promise<string | null> => {
    return await (source.googleFormsSource
      ? set(
          enqueueGoogleFormsWorkflowInput$,
          {
            input,
            source: source.googleFormsSource,
          },
          signal,
        )
      : source.googleCalendarSource
        ? set(
            enqueueGoogleCalendarWorkflowInput$,
            {
              input,
              source: source.googleCalendarSource,
            },
            signal,
          )
        : source.gmailSource
          ? set(
              enqueueGmailWorkflowInput$,
              { input, source: source.gmailSource },
              signal,
            )
          : source.googleMeetSource
            ? set(
                enqueueGoogleMeetWorkflowInput$,
                {
                  input,
                  source: source.googleMeetSource,
                },
                signal,
              )
            : source.notionSource
              ? set(
                  enqueueNotionWorkflowInput$,
                  { input, source: source.notionSource },
                  signal,
                )
              : source.stripeSource
                ? set(
                    enqueueStripeWorkflowInput$,
                    {
                      input,
                      source: source.stripeSource,
                    },
                    signal,
                  )
                : set(
                    enqueueWorkflowInput$,
                    { input, orgId, receipt: source.queueReceipt },
                    signal,
                  ));
  },
);

export const runWorkflowAutomationNow$ = command(
  async (
    { set },
    args: RunWorkflowAutomationNowArgs,
    signal: AbortSignal,
  ): Promise<RunWorkflowAutomationResult> => {
    const db = set(writeDb$);
    const { automation, chatThreadId } = args.due;
    const timing = workflowQueueEntryTiming(args.timing, args.apiStartTime);

    const { scheduleClaim } = args;
    const replacePendingTicks =
      automation.kind === "schedule" &&
      args.replacePendingScheduleTick !== false
        ? { chatThreadId, automationId: automation.id }
        : undefined;

    const preparedInput = await set(
      prepareWorkflowAutomationQueueInput$,
      workflowQueueInputPreparation(args, timing),
      signal,
    );
    signal.throwIfAborted();
    const appendInput = workflowAutomationQueueEventWriter(
      preparedInput,
      timing,
    );

    const sources: WorkflowQueueSources = {
      googleFormsSource: args.googleFormsSource,
      googleCalendarSource: args.googleCalendarSource,
      gmailSource: args.gmailSource,
      googleMeetSource: args.googleMeetSource,
      notionSource: args.notionSource,
      stripeSource: args.stripeSource,
      queueReceipt: args.queueReceipt,
    };
    const schedulePath = workflowQueueSchedulePath(args);
    let admissionOutcome: WorkflowAdmissionOutcome = "failed";
    const enqueued = await flushWorkflowAdmission(
      censusWorkflowAdmission(
        schedulePath,
        measureWorkflowAdmissionStep(
          timing,
          "api_dispatch_pre_create_agent_workflow_automation_queue_admission",
          async () => {
            const attempt = await settle(
              hasWorkflowQueueSource(sources) ||
                (!scheduleClaim && !replacePendingTicks)
                ? set(
                    enqueuePreparedWorkflowInput$,
                    preparedInput,
                    sources,
                    automation.orgId,
                    signal,
                  )
                : enqueueChatInput(db, {
                    chatThreadId,
                    orgId: automation.orgId,
                    appendInput,
                    measureStep: (step, operation) => {
                      return measureWorkflowAdmissionStep(
                        timing,
                        workflowQueueAdmissionStepAction(step),
                        operation,
                      );
                    },
                    ...queueAdmissionSourceTransition({
                      scheduleClaim,
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
