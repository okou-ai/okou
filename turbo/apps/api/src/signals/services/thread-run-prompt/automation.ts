import { computed, type Computed } from "ccstate";
import type { createThreadAutomationContext } from "../thread-automation-context.service";
import {
  storedWorkflowAutomationContext,
  workflowAutomationAgentPrompt,
  workflowAutomationEventTypeSchema,
} from "../workflow-automation-context.service";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./types";
import type { ThreadContext } from "../thread-context.signals";
import { STAFF_SINGLE_AGENT_ORG_ID } from "@okouai/core/single-agent-migration";

export function createAutomationThreadPrompt(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  context$: ReturnType<typeof createThreadAutomationContext>,
  payload$: ThreadContext["automationPayload$"],
  target$: ThreadContext["automationTarget$"],
  singleAgent$: Computed<Promise<boolean>>,
): Computed<Promise<RunPromptAndSkills | null>> {
  return computed(async (get) => {
    const pickedEvent = await get(pickedEvent$);
    if (
      pickedEvent?.contextType !== "automation" ||
      pickedEvent.contextId === null
    ) {
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
    const eventPayload = await get(payload$);
    if (!eventPayload) {
      return null;
    }
    // Invoke the same ordinary Workflow name that the Runner will mount.
    // Official Workflow names retain the staff cutover's compatibility rule.
    const target = await get(target$);
    const workflowName =
      target?.ordinaryWorkflowName ??
      (target?.workflow.orgId === STAFF_SINGLE_AGENT_ORG_ID &&
      (await get(singleAgent$))
        ? target.workflow.name
        : context.workflowName);
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
              automationEventId: pickedEvent.contextId,
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
      skillVolumes: [],
    };
  });
}
