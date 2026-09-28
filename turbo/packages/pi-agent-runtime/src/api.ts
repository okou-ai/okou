import {
  measurePiPreparation,
  measurePiPreparationSync,
  startPiPreparationObservation,
} from "./preparation-timing";
import type {
  PiPreparationObservation,
  PiPreparationObserver,
} from "./preparation-timing";
import { MemoryPiSession } from "./session-memory";
import type {
  PiMemoryRecallOutcome,
  PiMemoryRecallOutcomeStatus,
  PiMemoryRecallParity,
  PiMemoryRecallSelection,
  PiPreheatedAgentsFile,
  PiPreheatedResourceSnapshot,
  PiPreheatedSkill,
  PiSessionInspection,
} from "./api-types";
import { UnsupportedPiSessionVersionError } from "./errors";
import {
  PI_MEMORY_STAGE1_BUILT_IN_MODEL,
  PI_MEMORY_STAGE1_BYOK_MODEL,
} from "./memory-background-config";
import type { PiMemoryStage1Model } from "./memory-background-config";
import { piMemoryPhase2SelectionDigest } from "./phase2-memory-selection";
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
  PI_MEMORY_STAGE1_BUILT_IN_MODEL,
  PI_MEMORY_STAGE1_BYOK_MODEL,
  PI_MEMORY_STAGE1_RESPONSE_SCHEMA,
  PiMemoryStage1ProviderError,
  PiMemoryStage1BudgetError,
  projectPiMemoryStage1Evidence,
  redactPiMemoryStage1Secrets,
  runPiMemoryStage1Extraction,
  UnsupportedPiSessionVersionError,
};
export {
  measurePiPreparation,
  measurePiPreparationSync,
  startPiPreparationObservation,
};
export type { PiPreparationObservation, PiPreparationObserver };
export type {
  PiMemoryRecallOutcome,
  PiMemoryRecallOutcomeStatus,
  PiMemoryRecallParity,
  PiMemoryRecallSelection,
  PiPreheatedAgentsFile,
  PiPreheatedResourceSnapshot,
  PiPreheatedSkill,
  PiSessionInspection,
  PiMemoryStage1Model,
  PiMemoryStage1ProviderResult,
  PiMemoryStage1Evidence,
  PiMemoryStage1ProviderUsage,
};

/** Create the canonical empty native Pi history for a new sandbox launch. */
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
