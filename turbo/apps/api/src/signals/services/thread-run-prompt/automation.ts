import { computed, type Computed } from "ccstate";
import {
  storedWorkflowAutomationContext,
  workflowAutomationAgentPrompt,
  workflowAutomationEventTypeSchema,
} from "../workflow-automation-context.service";
import type { RunPrompt } from "../run-prompt-and-skills";
import type { ThreadContext } from "../thread-context.signals";
import { STAFF_SINGLE_AGENT_ORG_ID } from "@okouai/core/single-agent-migration";

export function createAutomationThreadPrompt(
  snapshot$: ThreadContext["automationSnapshot$"],
  payload$: ThreadContext["automationPayload$"],
  singleAgent$: Computed<Promise<boolean>>,
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
    // A queued staff event can still carry the old name. Use the live Official
    // Workflow name until those events drain.
    // https://github.com/okou-ai/okou/issues/46783
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
