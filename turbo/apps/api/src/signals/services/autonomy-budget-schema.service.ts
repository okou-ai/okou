import { workflowAutomations } from "@okouai/db/schema/workflow";

import { workflowAutomationSnapshotColumns } from "./workflow-automation-snapshot";

export function workflowAutomationColumns() {
  return {
    ...workflowAutomationSnapshotColumns(),
    id: workflowAutomations.id,
    orgId: workflowAutomations.orgId,
    workflowId: workflowAutomations.workflowId,
    ownerUserId: workflowAutomations.ownerUserId,
    kind: workflowAutomations.kind,
    eventType: workflowAutomations.eventType,
    eventConfig: workflowAutomations.eventConfig,
    eventConnectorId: workflowAutomations.eventConnectorId,
    scheduleType: workflowAutomations.scheduleType,
    cronExpression: workflowAutomations.cronExpression,
    intervalSeconds: workflowAutomations.intervalSeconds,
    atTime: workflowAutomations.atTime,
    timezone: workflowAutomations.timezone,
    enabled: workflowAutomations.enabled,
    nextRunAt: workflowAutomations.nextRunAt,
    deferredAnchorAt: workflowAutomations.deferredAnchorAt,
    deferredUntil: workflowAutomations.deferredUntil,
    deferredReason: workflowAutomations.deferredReason,
    lastRunAt: workflowAutomations.lastRunAt,
    lastRunId: workflowAutomations.lastRunId,
    consecutiveFailures: workflowAutomations.consecutiveFailures,
    autonomyBudget: workflowAutomations.autonomyBudget,
    officialBlueprintKey: workflowAutomations.officialBlueprintKey,
    officialAppliedFingerprint: workflowAutomations.officialAppliedFingerprint,
    officialReconciliationStatus:
      workflowAutomations.officialReconciliationStatus,
    officialParameterBindings: workflowAutomations.officialParameterBindings,
    officialIntendedEnabled: workflowAutomations.officialIntendedEnabled,
    officialResultEmailEnabled: workflowAutomations.officialResultEmailEnabled,
    createdAt: workflowAutomations.createdAt,
    updatedAt: workflowAutomations.updatedAt,
  };
}
