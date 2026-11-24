import { computed, type Computed } from "ccstate";
import {
  storedWorkflowAutomationContext,
  workflowAutomationAgentPrompt,
  workflowAutomationEventTypeSchema,
} from "../workflow-automation-context.service";
import type { RunPrompt } from "../run-prompt-and-skills";
import type { ThreadContext } from "../thread-context.signals";

export function createAutomationThreadPrompt(
  snapshot$: ThreadContext["automationSnapshot$"],
  payload$: ThreadContext["automationPayload$"],
): Computed<Promise<RunPrompt | null>> {
  return computed(async (get) => {
    const snapshot = await get(snapshot$);
    if (!snapshot) {
      return null;
    }
    const { event: context, target } = snapshot;
    if (
      context.workflowName === null ||
      context.eventType === null ||
      context.eventPayload === null
    ) {
      return null;
    }
    const eventType = workflowAutomationEventTypeSchema.parse(
      context.eventType,
    );
    const eventPayload = await get(payload$);
    if (!eventPayload) {
      return null;
    }
    // Invoke the same ordinary Workflow name that the Runner will mount.
    const workflowName = target?.ordinaryWorkflowName ?? context.workflowName;
    return {
      userPromptVariables: {
        message: [
          workflowAutomationAgentPrompt(
            storedWorkflowAutomationContext({
              workflowName,
              eventType,
              eventPayload,
            }),
          ),
          "",
          "Automation identity:",
          JSON.stringify(
            {
              automationId: context.automationId,
              automationEventId: context.id,
            },
            null,
            2,
          ),
        ].join("\n"),
      },
      systemPromptVariables: {
        integrationContext: [
          "# Integration Note",
          "",
          "- Use integration-specific messaging or file commands only when the task names an explicit delivery target or the current surface provides one.",
        ].join("\n"),
      },
    };
  });
}
