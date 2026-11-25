import type {
  AgentRunOfficialWorkflowBundleDefinitionProvenance,
  AgentRunOfficialWorkflowProvenance,
} from "@okouai/db/jsonb-contracts/agent-run-session-conversation";

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

type ResolvedOfficialWorkflowDefinition =
  AgentRunOfficialWorkflowBundleDefinitionProvenance & {
    readonly workflowId: string;
  };

export interface OfficialWorkflowObservation {
  readonly prompt: string;
  readonly definitions: readonly ResolvedOfficialWorkflowDefinition[];
  readonly provenance: Extract<
    AgentRunOfficialWorkflowProvenance,
    { readonly schemaVersion: 2 }
  >;
}
