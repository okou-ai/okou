import type { OfficialWorkflowBlueprintBindings } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { command, state, type Command } from "ccstate";

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

type OfficialWorkflowReconciliationCommand = Command<
  Promise<OfficialWorkflowReconciliationResult>,
  [OfficialWorkflowReconciliationArgs, AbortSignal]
>;

const configuredOfficialWorkflowReconciliationCommand$ = state<
  OfficialWorkflowReconciliationCommand | undefined
>(undefined);

/** Initialize the request's implementation from the API composition root. */
export const configureOfficialWorkflowReconciliationCommand$ = command(
  ({ get, set }, commandValue: OfficialWorkflowReconciliationCommand): void => {
    const configuredCommand = get(
      configuredOfficialWorkflowReconciliationCommand$,
    );
    if (configuredCommand !== undefined && configuredCommand !== commandValue) {
      throw new Error(
        "Official Workflow reconciliation command is already configured",
      );
    }
    set(configuredOfficialWorkflowReconciliationCommand$, commandValue);
  },
);

export const dispatchConfiguredOfficialWorkflowReconciliation$ = command(
  async (
    { get, set },
    args: OfficialWorkflowReconciliationArgs,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult> => {
    const commandValue = get(configuredOfficialWorkflowReconciliationCommand$);
    if (commandValue === undefined) {
      throw new Error(
        "Official Workflow reconciliation command is not configured",
      );
    }
    return await set(commandValue, args, signal);
  },
);
