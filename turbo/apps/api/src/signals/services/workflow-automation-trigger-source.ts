import type { WorkflowAutomationKind } from "@okouai/db/schema/workflow";

export function workflowAutomationTriggerSource(automation: {
  readonly kind: WorkflowAutomationKind;
}): "automation-event" | "automation-schedule" {
  return automation.kind === "event"
    ? "automation-event"
    : "automation-schedule";
}
