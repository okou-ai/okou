import { computed, type Computed } from "ccstate";
import type { createThreadAutomationContext } from "../thread-automation-context.service";
import {
  restoredWorkflowAutomationEventPayload,
  storedWorkflowAutomationContext,
  workflowAutomationAgentPrompt,
  workflowAutomationEventTypeSchema,
} from "../workflow-automation-context.service";
import type { IntegrationPromptVariables, ThreadPromptSource } from "./types";

export function createAutomationThreadPrompt(
  source$: Computed<Promise<ThreadPromptSource | null>>,
  context$: ReturnType<typeof createThreadAutomationContext>,
): Computed<Promise<IntegrationPromptVariables | null>> {
  return computed(async (get) => {
    const [source, context] = await Promise.all([get(source$), get(context$)]);
    if (
      source?.event.contextType !== "automation" ||
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
        integrationContext: "",
        channelUserIdentity: "",
      },
    };
  });
}
