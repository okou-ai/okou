import { computed, type Computed } from "ccstate";
import type { createThreadAutomationContext } from "../thread-automation-context.service";
import {
  restoredWorkflowAutomationEventPayload,
  storedWorkflowAutomationContext,
  workflowAutomationAgentPrompt,
  workflowAutomationEventTypeSchema,
} from "../workflow-automation-context.service";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { ThreadPromptSource } from "./types";

export function createAutomationThreadPrompt(
  source$: Computed<Promise<ThreadPromptSource | null>>,
  context$: ReturnType<typeof createThreadAutomationContext>,
): Computed<Promise<RunPromptAndSkills | null>> {
  return computed(async (get) => {
    const source = await get(source$);
    if (source?.event.contextType !== "automation") {
      return null;
    }
    const context = await get(context$);
    if (
      !context ||
      context.workflowName === null ||
      context.eventType === null ||
      context.eventPayload === null
    ) {
      return null;
    }
    const eventType = workflowAutomationEventTypeSchema.parse(
      context.eventType,
    );
    const eventPayload = restoredWorkflowAutomationEventPayload(
      context.eventPayload,
    );
    if (!eventPayload) {
      return null;
    }
    return {
      userPromptVariables: {
        message: workflowAutomationAgentPrompt(
          storedWorkflowAutomationContext({
            workflowName: context.workflowName,
            eventType,
            eventPayload,
          }),
        ),
      },
      systemPromptVariables: {
        integrationContext: [
          "# Integration Note",
          "",
          "- Use integration-specific messaging or file commands only when the task names an explicit delivery target or the current surface provides one.",
        ].join("\n"),
      },
      skillVolumes: [],
    };
  });
}
