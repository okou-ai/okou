import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq } from "drizzle-orm";

export function googleMeetAutomationProjectionColumns() {
  return {
    id: workflowAutomations.id,
    workflowId: workflowAutomations.workflowId,
    eventConnectorId: workflowAutomations.eventConnectorId,
  };
}

export function googleMeetAutomationProjectionCondition(args: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return and(
    eq(workflowAutomations.orgId, args.orgId),
    eq(workflowAutomations.ownerUserId, args.userId),
    eq(workflowAutomations.kind, "event"),
    eq(workflowAutomations.eventType, "google-meet-transcript-generated"),
  );
}
