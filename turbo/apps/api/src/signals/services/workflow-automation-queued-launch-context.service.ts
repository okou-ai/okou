import {
  EVENT_POLICY,
  restoredWorkflowAutomationEventPayload,
  storedWorkflowAutomationContext,
  workflowAutomationAgentPrompt,
  workflowAutomationEventTypeSchema,
  type WorkflowAutomationEventPayload,
} from "./workflow-automation-context.service";
import {
  buildWorkflowAutomationCallbacks,
  type AutomationRow,
} from "./workflow-automation-launch.service";

interface WorkflowAutomationQueuedLaunchMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string | undefined;
  readonly callbacks: ReturnType<typeof buildWorkflowAutomationCallbacks>;
  readonly activePreviousRunPolicy: "block" | "allow";
  readonly recordLastRunId: boolean;
  readonly recordLastRunAt: boolean;
  readonly allowClaimedOnceScheduleAutomation: boolean;
}

export function buildWorkflowAutomationQueuedLaunchMaterial(args: {
  readonly workflowName: string | null;
  readonly eventType: string | null;
  readonly eventPayload: WorkflowAutomationEventPayload | null;
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly chatThreadId: string;
}): WorkflowAutomationQueuedLaunchMaterial | null {
  if (
    args.workflowName === null ||
    args.eventType === null ||
    args.eventPayload === null
  ) {
    return null;
  }
  const eventType = workflowAutomationEventTypeSchema.parse(args.eventType);
  const eventPayload = restoredWorkflowAutomationEventPayload(
    args.eventPayload,
  );
  if (!eventPayload) {
    return null;
  }
  const context = storedWorkflowAutomationContext({
    workflowName: args.workflowName,
    eventType,
    eventPayload,
  });
  return {
    prompt: workflowAutomationAgentPrompt(context),
    appendSystemPrompt: undefined,
    callbacks: buildWorkflowAutomationCallbacks(
      args.automation,
      args.agentId,
      args.chatThreadId,
      args.workflowName,
    ),
    ...EVENT_POLICY[eventType],
    allowClaimedOnceScheduleAutomation: args.automation.scheduleType === "once",
  };
}
