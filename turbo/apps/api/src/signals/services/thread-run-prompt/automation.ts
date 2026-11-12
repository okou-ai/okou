import { computed, type Computed } from "ccstate";
import type { createThreadAutomationContext } from "../thread-automation-context.service";
import {
  restoredWorkflowAutomationEventPayload,
  storedWorkflowAutomationContext,
  workflowAutomationAgentPrompt,
  workflowAutomationEventTypeSchema,
} from "../workflow-automation-context.service";
import type { RunPromptAndSkills } from "../run-prompt-and-skills";
import type { PickedThreadInputEvent } from "./types";
import type { ThreadContext } from "../thread-context.signals";
import { STAFF_SINGLE_AGENT_ORG_ID } from "@okouai/core/staff-single-agent-migration";

export function createAutomationThreadPrompt(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  context$: ReturnType<typeof createThreadAutomationContext>,
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
    const eventPayload = restoredWorkflowAutomationEventPayload(
      context.eventPayload,
    );
    if (!eventPayload) {
      return null;
    }
    // Temporary staff migration reader: queued events retain the old immutable
    // name. New-mode executions use the same Automation's copied Workflow;
    // already admitted legacy Runs keep their source namespace. Remove after
    // pre-cutover inputs and pending Runs have drained.
    const target = await get(target$);
    const workflowName =
      target?.workflow.orgId === STAFF_SINGLE_AGENT_ORG_ID &&
      (await get(singleAgent$))
        ? target.workflow.name
        : context.workflowName;
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
