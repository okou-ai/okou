import type { OfficialWorkflowBlueprintBindings } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { command, type Command } from "ccstate";
import { singleton } from "../../lib/singleton";
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

// This is process-level composition identity, not request-owned signal state.
class OfficialWorkflowReconciliationRegistry {
  command: OfficialWorkflowReconciliationCommand | undefined;
}

const reconciliationRegistry = singleton(() => {
  return new OfficialWorkflowReconciliationRegistry();
});

/** Configure Official Workflow reconciliation from the API composition root. */
export function configureOfficialWorkflowReconciliationCommand(
  commandValue: OfficialWorkflowReconciliationCommand,
): void {
  const registry = reconciliationRegistry();
  const configuredCommand = registry.command;
  if (configuredCommand !== undefined && configuredCommand !== commandValue) {
    throw new Error(
      "Official Workflow reconciliation command is already configured",
    );
  }
  registry.command = commandValue;
}

export const dispatchConfiguredOfficialWorkflowReconciliation$ = command(
  async (
    { set },
    args: OfficialWorkflowReconciliationArgs,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconciliationResult> => {
    const commandValue = reconciliationRegistry().command;
    if (commandValue === undefined) {
      throw new Error(
        "Official Workflow reconciliation command is not configured",
      );
    }
    return await set(commandValue, args, signal);
  },
);
