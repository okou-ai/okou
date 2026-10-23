import type { WorkflowAutomationEventType } from "@okouai/api-contracts/contracts/workflows";

export const WORKFLOW_AUTOMATION_ACCOUNT_CONNECTOR_SLUGS = [
  "gmail",
  "google-calendar",
  "google-forms",
  "google-meet",
  "notion",
] as const;

export type WorkflowAutomationAccountConnectorSlug =
  (typeof WORKFLOW_AUTOMATION_ACCOUNT_CONNECTOR_SLUGS)[number];

const accountConnectorByEventType = {
  "chat-run-finished": null,
  "gmail-new-message": "gmail",
  "gmail-label-applied": "gmail",
  "github-deployment-status-created": null,
  "github-issue-comment-created": null,
  "github-pull-request": null,
  "github-pull-request-review-submitted": null,
  "github-workflow-job-completed": null,
  "github-workflow-run-completed": null,
  "google-calendar-event-created": "google-calendar",
  "google-calendar-event-updated": "google-calendar",
  "google-calendar-event-cancelled": "google-calendar",
  "google-forms-response-submitted": "google-forms",
  "google-meet-transcript-generated": "google-meet",
  "notion-child-page-created": "notion",
  "notion-database-item-created": "notion",
  "notion-page-content-updated": "notion",
  "webhook-received": null,
} satisfies Record<
  WorkflowAutomationEventType,
  WorkflowAutomationAccountConnectorSlug | null
>;

const accountConnectorByInput: Readonly<
  Record<string, WorkflowAutomationAccountConnectorSlug | null | undefined>
> = accountConnectorByEventType;

export function isWorkflowAutomationAccountConnectorSlug(
  connectorSlug: string,
): connectorSlug is WorkflowAutomationAccountConnectorSlug {
  return WORKFLOW_AUTOMATION_ACCOUNT_CONNECTOR_SLUGS.some((candidate) => {
    return candidate === connectorSlug;
  });
}

export function workflowAutomationAccountConnectorSlug(
  eventType: string | null,
): WorkflowAutomationAccountConnectorSlug | null {
  return eventType === null
    ? null
    : (accountConnectorByInput[eventType] ?? null);
}
