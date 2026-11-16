import {
  preparedExecutionContextSchema,
  type ExecutionInput,
} from "@okouai/api-contracts/contracts/runners";
import type { agentRuns } from "@okouai/db/runtime/agent-run";
import type { PersistedStorageMount } from "@okouai/db/types";
import { computed, type Computed } from "ccstate";
import { createExecutionRuntimeContext } from "./execution-runtime-context";
import type { AdmittedExecutionFacts } from "./admitted-execution-facts";

/** Captured inputs for one admitted Thread Run. */
export type ExecutionContextRun = Pick<
  typeof agentRuns.$inferSelect,
  | "id"
  | "orgId"
  | "userId"
  | "modelProvider"
  | "modelProviderId"
  | "modelProviderCredentialScope"
  | "modelProviderAccountIdentity"
  | "selectedModel"
  | "modelRuntimeProvider"
  | "modelRuntimeModel"
  | "builtInModelKeyId"
  | "modelUsageProvider"
  | "modelLongContextMinTotalInputTokens"
  | "reasoningEffort"
  | "codexServiceTier"
  | "officialWorkflowProvenance"
> & {
  readonly agentId: string;
  readonly chatThreadId: string;
  readonly framework: "claude-code" | "codex" | "pi";
  readonly vars: Record<string, string>;
  readonly storageMounts: readonly PersistedStorageMount[];
};

/** Read admitted execution input, then assemble the Run from its authoritative sources. */
export function createExecutionContext(
  input$: Computed<
    Promise<{
      readonly run: ExecutionContextRun;
      readonly context: ExecutionInput;
      readonly facts: AdmittedExecutionFacts;
    }>
  >,
) {
  const runtime$ = createExecutionRuntimeContext(input$);
  return computed(async (get) => {
    const runtime = await get(runtime$);
    return {
      ...runtime,
      context: preparedExecutionContextSchema.parse(runtime.context),
    };
  });
}
