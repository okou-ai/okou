import type { StoredExecutionContext } from "@okouai/api-contracts/contracts/runners";

export function historyGenerationRunIdForStoredExecutionContext(
  executionContext: Pick<StoredExecutionContext, "nativeContinuation">,
): string | undefined {
  return executionContext.nativeContinuation.generationRunId ?? undefined;
}
