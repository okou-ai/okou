import type { OfficialWorkflowBlueprintBindings } from "@okouai/api-contracts/contracts/official-workflow-catalog";

import type { WorkflowMember } from "./workflow-data.service";

export type OfficialWorkflowReconciliationResult =
  | { readonly kind: "current"; readonly workflowId: string }
  | {
      readonly kind: "needs-reconfiguration";
      readonly workflowId: string;
      readonly message: string;
    }
  | {
      readonly kind: "retry";
      readonly workflowId: string;
      readonly message: string;
    }
  | {
      readonly kind: "invalid";
      readonly workflowId: string;
      readonly message: string;
    }
  | { readonly kind: "removed"; readonly workflowId: string }
  | { readonly kind: "not-found" };

export interface OfficialWorkflowReconciliationArgs {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly targetAutomationId?: string;
  readonly overrides?: readonly OfficialWorkflowBlueprintBindings[];
  /** Proactive workers must stop if the Definition retires mid-reconcile. */
  readonly activeDefinitionOnly?: boolean;
}
