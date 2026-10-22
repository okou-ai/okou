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
  PiPreheatedAgentsFile,
  PiPreheatedResourceSnapshot,
  PiPreheatedSkill,
  PiSessionInspection,
} from "./api-types";
import { UnsupportedPiSessionVersionError } from "./errors";
import {
  PI_MEMORY_STAGE1_BUILT_IN_MODEL,
  PI_MEMORY_PRESET,
} from "./memory-background-config";
import { piMemoryPhase2SelectionDigest } from "./phase2-memory-selection";
export {
  piMemoryPhase2SelectionDigest,
  PI_MEMORY_PRESET,
  PI_MEMORY_STAGE1_BUILT_IN_MODEL,
  UnsupportedPiSessionVersionError,
};
export {
  measurePiPreparation,
  measurePiPreparationSync,
  startPiPreparationObservation,
};
export type {
  PiPreparationObservation,
  PiPreparationObserver,
  PiPreheatedAgentsFile,
  PiPreheatedResourceSnapshot,
  PiPreheatedSkill,
  PiSessionInspection,
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
    isSettledHistory: session.isSettledHistory(),
  };
}
