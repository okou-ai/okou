import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, isNotNull } from "drizzle-orm";

interface RunModelSelection {
  readonly selectedModel: string | null;
  readonly codexServiceTier: CodexServiceTier | null;
}

export function runModelSelectionColumns() {
  return {
    selectedModel: agentRuns.selectedModel,
    codexServiceTier: agentRuns.codexServiceTier,
  };
}

export function runModelSelectionCondition(runId: string) {
  return and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource));
}

export function runModelSelectionFromRow(
  row:
    | Pick<typeof agentRuns.$inferSelect, "selectedModel" | "codexServiceTier">
    | undefined,
): RunModelSelection | undefined {
  if (!row) {
    return undefined;
  }
  // A historical run's retired Ultrafast tier reads as Standard.
  return {
    selectedModel: row.selectedModel,
    codexServiceTier: row.codexServiceTier === "fast" ? "fast" : null,
  };
}
