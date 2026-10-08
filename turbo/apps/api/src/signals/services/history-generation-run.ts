import type { StoredExecutionContext } from "@okouai/api-contracts/contracts/runners";

export function historyGenerationRunIdForStoredExecutionContext(
  executionContext: Pick<StoredExecutionContext, "resumeSession">,
): string | undefined {
  const resumeSession = executionContext.resumeSession;
  return resumeSession && "historyRef" in resumeSession
    ? resumeSession.historyGenerationRunId
    : undefined;
}
