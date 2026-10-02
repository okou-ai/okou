import { workflowAutomations } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";
type AutomationRow = typeof workflowAutomations.$inferSelect;

export function officialAutomationLifecycleCondition(
  automation: AutomationRow,
) {
  if (automation.officialBlueprintKey === null) {
    return eq(workflowAutomations.id, automation.id);
  }
  if (automation.officialReconciliationStatus === null) {
    throw new Error("Official Workflow automation state is incomplete");
  }
  return and(
    eq(workflowAutomations.id, automation.id),
    eq(workflowAutomations.updatedAt, automation.updatedAt),
    eq(
      workflowAutomations.officialReconciliationStatus,
      automation.officialReconciliationStatus,
    ),
  );
}
