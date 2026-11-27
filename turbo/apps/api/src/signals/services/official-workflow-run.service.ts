const OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE =
  "Official Workflow execution state is not current; retry";

export class OfficialWorkflowRunAdmissionError extends Error {
  constructor(options?: {
    readonly cause?: unknown;
    readonly message?: string;
  }) {
    super(options?.message ?? OFFICIAL_WORKFLOW_RUN_ADMISSION_MESSAGE, options);
    this.name = "OfficialWorkflowRunAdmissionError";
  }
}
