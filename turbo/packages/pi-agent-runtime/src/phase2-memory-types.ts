import {
  sanitizePiMemoryPhase2Diagnostic,
  type PiMemoryPhase2Diagnostic,
} from "./phase2-memory-diagnostics";
import type { PiAgentModelConfig } from "./types";

export const PI_MEMORY_PHASE2_WORKSPACE_DIFF_MAX_BYTES = 4 * 1024 * 1024;
export const PI_MEMORY_PHASE2_MEMORY_MAX_BYTES = 8 * 1024 * 1024;
export const PI_MEMORY_PHASE2_PREPARED_MAX_BYTES = 128 * 1024 * 1024;
export const PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILES = 256;
export const PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_FILE_BYTES = 1024 * 1024;
export const PI_MEMORY_PHASE2_MAX_CHANGED_SKILL_BYTES = 16 * 1024 * 1024;

export interface PiMemoryPhase2BaseFile {
  readonly type: "file";
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

export interface PiMemoryPhase2SelectedSnapshot {
  readonly piSessionId: string;
  readonly sourceRunId: string;
  readonly sourceHistoryHash: string;
  readonly sourceCompletedAt: Date;
  readonly rawMemory: string;
  readonly rolloutSummary: string;
  readonly rolloutSlug: string | null;
}

export interface PiMemoryPhase2ProviderUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning: number;
}

export interface PiMemoryPhase2LocalConsolidationArgs {
  readonly memoryStorageId: string;
  readonly baseFiles: readonly PiMemoryPhase2BaseFile[];
  readonly selected: readonly PiMemoryPhase2SelectedSnapshot[];
  readonly model: PiAgentModelConfig;
}

export interface PiMemoryPhase2PreparedFile {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  /** Owned snapshot; application copies and authenticates bytes before any await. */
  readonly bytes: Uint8Array;
}

export interface PiMemoryPhase2PreparedManifest {
  readonly version: 1;
  readonly files: readonly Readonly<{
    path: string;
    hash: string;
    size: number;
  }>[];
  readonly fileCount: number;
  readonly pathBytes: number;
  readonly totalBytes: number;
  readonly digest: string;
}

export interface PiMemoryPhase2DiffSummary {
  readonly added: number;
  readonly changed: number;
  readonly deleted: number;
  readonly renderedBytes: number;
  readonly truncated: boolean;
  readonly digest: string;
}

interface PiMemoryPhase2ResultBase {
  readonly files: readonly PiMemoryPhase2PreparedFile[];
  readonly manifest: PiMemoryPhase2PreparedManifest;
  readonly contentIdentity: string;
  readonly diff: PiMemoryPhase2DiffSummary;
  readonly selectionDigest: string;
}

export interface PiMemoryPhase2NoDiffResult extends PiMemoryPhase2ResultBase {
  readonly status: "no_diff";
  readonly responseId: null;
  readonly usage: PiMemoryPhase2ProviderUsage;
}

export interface PiMemoryPhase2PreparedResult extends PiMemoryPhase2ResultBase {
  readonly status: "prepared";
  /**
   * Provider evidence only. Phase 2 correctness comes from the validated
   * memory tree, so a provider that omits a response id is not a failure.
   */
  readonly responseId: string | null;
  readonly usage: PiMemoryPhase2ProviderUsage;
}

export type PiMemoryPhase2ConsolidationResult =
  | PiMemoryPhase2NoDiffResult
  | PiMemoryPhase2PreparedResult;

export type PiMemoryPhase2FailureClass =
  | "aborted"
  | "agent_output_invalid"
  | "cleanup_failed"
  | "input_invalid"
  | "model_failed"
  | "prompt_invariant"
  | "session_failed";

export interface PiMemoryPhase2FailureCounts {
  readonly candidateCount: number;
  readonly fileCount: number;
  readonly totalBytes: number;
}

const FAILURE_MESSAGES: Readonly<Record<PiMemoryPhase2FailureClass, string>> = {
  aborted: "Pi memory Phase 2 consolidation was cancelled.",
  agent_output_invalid: "Pi memory Phase 2 agent output was invalid.",
  cleanup_failed: "Pi memory Phase 2 private workspace cleanup failed.",
  input_invalid: "Pi memory Phase 2 input was invalid.",
  model_failed: "Pi memory Phase 2 model request failed.",
  prompt_invariant: "Pi memory Phase 2 prompt invariant failed.",
  session_failed: "Pi memory Phase 2 maintenance session failed.",
};

export class PiMemoryPhase2EngineError extends Error {
  readonly errorClass: PiMemoryPhase2FailureClass;
  readonly counts: PiMemoryPhase2FailureCounts;
  readonly diagnostic?: PiMemoryPhase2Diagnostic;

  constructor(
    errorClass: PiMemoryPhase2FailureClass,
    counts: PiMemoryPhase2FailureCounts,
    diagnostic?: PiMemoryPhase2Diagnostic,
  ) {
    super(FAILURE_MESSAGES[errorClass]);
    this.name = "PiMemoryPhase2EngineError";
    this.errorClass = errorClass;
    this.counts = Object.freeze({ ...counts });
    if (diagnostic)
      this.diagnostic = sanitizePiMemoryPhase2Diagnostic(diagnostic);
  }

  /** The existing Guest stderr consumer forwards this bounded line to terminal logs. */
  terminalMessage(): string {
    const message = FAILURE_MESSAGES[this.errorClass];
    return this.diagnostic
      ? `${message} pi_memory_phase2=${JSON.stringify(sanitizePiMemoryPhase2Diagnostic(this.diagnostic))}`
      : message;
  }
}
