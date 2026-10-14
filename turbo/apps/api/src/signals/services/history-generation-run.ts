import type { StoredExecutionContext } from "@okouai/api-contracts/contracts/runners";

export function historyGenerationRunIdForStoredExecutionContext(
  executionContext: Pick<
    StoredExecutionContext,
    "resumeSession" | "nativeContinuation"
  >,
): string | undefined {
  if (executionContext.nativeContinuation) {
    return executionContext.nativeContinuation.generationRunId ?? undefined;
  }
  const resumeSession = executionContext.resumeSession;
  return resumeSession && "historyRef" in resumeSession
    ? resumeSession.historyGenerationRunId
    : undefined;
}
