import {
  measurePiPreparation,
  measurePiPreparationSync,
  startPiPreparationObservation,
} from "./preparation-timing";
import type {
  PiPreparationObservation,
  PiPreparationObserver,
} from "./preparation-timing";
import {
  classifyPiApiProviderFailure,
  PiApiModelRequestError,
  type PiApiModelFailureDiagnostic,
} from "./api-failure";
import {
  runPiApiFirstTurn as runPiApiFirstTurnImpl,
  preparePiApiTurn as preparePiApiTurnImpl,
  executePreparedPiApiTurn as executePreparedPiApiTurnImpl,
} from "./api-turn";
import { MemoryPiSession } from "./session-memory";
import type {
  PiApiAssistantContent,
  PiApiAssistantMessage,
  PiApiAssistantStopReason,
  PiApiAssistantTextContent,
  PiApiAssistantToolCallContent,
  PiApiTurnPreparationArgs,
  PiApiTurnExecutionArgs,
  PreparedPiApiTurn,
  PiApiFirstTurnArgs,
  PiApiFirstTurnResult,
  PiObservedServiceTier,
  PiMemoryRecallOutcome,
  PiMemoryRecallOutcomeStatus,
  PiMemoryRecallParity,
  PiMemoryRecallSelection,
  PiPreheatedAgentsFile,
  PiPreheatedResourceSnapshot,
  PiPreheatedSkill,
  PiSessionInspection,
  RunPiApiFirstTurn,
} from "./api-types";
import {
  PiApiFirstTurnCompactionRequiredError,
  UnsupportedPiResourceSnapshotError,
  UnsupportedPiSessionVersionError,
} from "./errors";
import { PI_MEMORY_STAGE1_MODEL } from "./memory-background-config";
import { piMemoryPhase2SelectionDigest } from "./phase2-memory-selection";
import { createPiApiFirstTurnOwnership } from "./provider-ownership";
import type {
  PiApiFirstTurnOwnership,
  PiApiFirstTurnOwnershipStage,
} from "./provider-ownership";
import {
  PI_MEMORY_STAGE1_RESPONSE_SCHEMA,
  PiMemoryStage1ProviderError,
  projectPiMemoryStage1Evidence,
  runPiMemoryStage1Extraction,
} from "./stage1-memory";
import type {
  PiMemoryStage1ProviderResult,
  PiMemoryStage1ProviderUsage,
} from "./stage1-memory";
import {
  PiMemoryStage1BudgetError,
  type PiMemoryStage1Evidence,
} from "./stage1-input";
import { redactPiMemoryStage1Secrets } from "./stage1-secrets";
export {
  piMemoryPhase2SelectionDigest,
  classifyPiApiProviderFailure,
  PiApiModelRequestError,
  PI_MEMORY_STAGE1_MODEL,
  PI_MEMORY_STAGE1_RESPONSE_SCHEMA,
  PiMemoryStage1ProviderError,
  PiMemoryStage1BudgetError,
  projectPiMemoryStage1Evidence,
  redactPiMemoryStage1Secrets,
  runPiMemoryStage1Extraction,
  PiApiFirstTurnCompactionRequiredError,
  UnsupportedPiResourceSnapshotError,
  UnsupportedPiSessionVersionError,
};
export { createPiApiFirstTurnOwnership };
export {
  measurePiPreparation,
  measurePiPreparationSync,
  startPiPreparationObservation,
};
export type { PiPreparationObservation, PiPreparationObserver };
export type {
  PiApiModelFailureDiagnostic,
  PiApiAssistantContent,
  PiApiAssistantMessage,
  PiApiAssistantStopReason,
  PiApiAssistantTextContent,
  PiApiAssistantToolCallContent,
  PiApiTurnPreparationArgs,
  PiApiTurnExecutionArgs,
  PreparedPiApiTurn,
  PiApiFirstTurnArgs,
  PiApiFirstTurnResult,
  PiObservedServiceTier,
  PiMemoryRecallOutcome,
  PiMemoryRecallOutcomeStatus,
  PiMemoryRecallParity,
  PiMemoryRecallSelection,
  PiPreheatedAgentsFile,
  PiPreheatedResourceSnapshot,
  PiPreheatedSkill,
  PiSessionInspection,
  PiApiFirstTurnOwnership,
  PiApiFirstTurnOwnershipStage,
  PiMemoryStage1ProviderResult,
  PiMemoryStage1Evidence,
  PiMemoryStage1ProviderUsage,
};

export const preparePiApiTurn: (
  args: PiApiTurnPreparationArgs,
  signal?: AbortSignal,
) => Promise<PreparedPiApiTurn> = preparePiApiTurnImpl;
export const executePreparedPiApiTurn: (
  prepared: PreparedPiApiTurn,
  args: PiApiTurnExecutionArgs,
  signal?: AbortSignal,
) => Promise<PiApiFirstTurnResult> = executePreparedPiApiTurnImpl;

/** Run one provider turn without exposing Pi's native declaration surface. */
export const runPiApiFirstTurn: RunPiApiFirstTurn = runPiApiFirstTurnImpl;

/** Create the canonical empty native Pi history for a new API-first launch. */
export function createPiSessionJsonl(args: {
  readonly cwd: string;
  readonly sessionId: string;
  readonly timestamp: string;
}): string {
  return MemoryPiSession.create({
    cwd: args.cwd,
    id: args.sessionId,
    timestamp: args.timestamp,
  }).toJsonl();
}

/** Project canonical Pi JSONL into a citation-free user export derivative. */
export function projectPiSessionJsonlForExport(jsonl: string): string {
  return MemoryPiSession.fromJsonl(jsonl).toPublicJsonl();
}

/** Inspect one native Pi JSONL session through a stable structural result. */
export function inspectPiSessionJsonl(jsonl: string): PiSessionInspection {
  const session = MemoryPiSession.fromJsonl(jsonl);
  return {
    sessionId: session.getSessionId(),
    messageCount: session.buildSessionContext().messages.length,
    hasPendingToolCalls: session.hasPendingToolCalls(),
    pendingToolIds: session.pendingToolIds(),
    isSettledCheckpoint: session.isSettledCheckpoint(),
  };
}
