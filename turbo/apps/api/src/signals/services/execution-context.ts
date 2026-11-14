import {
  preparedExecutionContextSchema,
  type ExecutionInput,
} from "@okouai/api-contracts/contracts/runners";
import type { agentRuns } from "@okouai/db/runtime/agent-run";
import { computed, type Computed } from "ccstate";
import { createExecutionRuntimeContext } from "./execution-runtime-context";

export type ExecutionContextRun = Pick<
  typeof agentRuns.$inferSelect,
  | "id"
  | "orgId"
  | "userId"
  | "agentId"
  | "chatThreadId"
  | "launchSnapshot"
  | "vars"
  | "storageMounts"
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
>;

/** Read admitted execution input, then assemble the Run from its authoritative sources. */
export function createExecutionContext(
  input$: Computed<
    Promise<{
      readonly run: ExecutionContextRun;
      readonly context: ExecutionInput;
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
