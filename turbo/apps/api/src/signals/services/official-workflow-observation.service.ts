import {
  OfficialWorkflowRunAdmissionError,
  type OfficialWorkflowObservation,
} from "./official-workflow-run.service";

/** A run's source claim is checked against the same captured workflow selection. */
export function assertRequiredOfficialWorkflows(
  observation: OfficialWorkflowObservation | undefined,
  requiredWorkflowIds: readonly string[],
): void {
  const workflowIds = new Set(
    observation?.definitions.map((definition) => {
      return definition.workflowId;
    }),
  );
  if (
    new Set(requiredWorkflowIds).size !== requiredWorkflowIds.length ||
    requiredWorkflowIds.some((workflowId) => {
      return !workflowIds.has(workflowId);
    })
  ) {
    throw new OfficialWorkflowRunAdmissionError();
  }
}
