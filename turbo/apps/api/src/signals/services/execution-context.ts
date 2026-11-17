import { preparedExecutionContextSchema } from "@okouai/api-contracts/contracts/runners";
import type { agentRuns } from "@okouai/db/runtime/agent-run";
import type { PersistedStorageMount } from "@okouai/db/types";
import { computed, type Computed } from "ccstate";
import { createExecutionRuntimeContext } from "./execution-runtime-context";
import type { AdmittedExecutionFacts } from "./admitted-execution-facts";
import type { ModelFirstPin } from "./model-selection.service";

/** Captured inputs for one admitted Thread Run. */
export type ExecutionContextRun = Pick<
  typeof agentRuns.$inferSelect,
  | "id"
  | "orgId"
  | "userId"
  | "modelProviderId"
  | "modelProviderAccountIdentity"
  | "modelRuntimeProvider"
  | "modelRuntimeModel"
  | "builtInModelKeyId"
  | "modelUsageProvider"
  | "modelLongContextMinTotalInputTokens"
  | "reasoningEffort"
  | "codexServiceTier"
  | "officialWorkflowProvenance"
> & {
  readonly modelProvider: ModelFirstPin["modelProviderType"];
  readonly selectedModel: string;
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
      readonly facts: AdmittedExecutionFacts;
    }>
  >,
) {
  const runtime = createExecutionRuntimeContext(input$);
  const prepared$ = computed(async (get) => {
    const prepared = await get(runtime.prepared$);
    return {
      ...prepared,
      context: preparedExecutionContextSchema.parse(prepared.context),
    };
  });
  return { prepared$, packageContext$: runtime.packageContext$ };
}
