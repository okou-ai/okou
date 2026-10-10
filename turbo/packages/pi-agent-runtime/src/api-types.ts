import type { PiResourceSnapshot } from "@okouai/api-contracts/contracts/runners";

export type PiMemoryRecallSelection = Extract<
  PiResourceSnapshot,
  { readonly schemaVersion: 2 }
>["memoryRecall"];
export type PiPreheatedAgentsFile = PiResourceSnapshot["agentsFiles"][number];
export type PiPreheatedSkill = PiResourceSnapshot["skills"][number];
export type PiPreheatedResourceSnapshot = PiResourceSnapshot;

export type PiMemoryRecallOutcomeStatus = "hit" | "miss" | "invalid" | "stale";

export type PiMemoryRecallParity =
  "frozen-match" | "frozen-no-content" | "mismatch" | "not-applicable";

export interface PiMemoryRecallOutcome {
  readonly mode: "preheated" | "sandbox";
  readonly status: PiMemoryRecallOutcomeStatus;
  readonly parity: PiMemoryRecallParity;
  readonly reason:
    | "empty"
    | "filesystem"
    | "frozen-no-content"
    | "hash-mismatch"
    | "invalid-utf8"
    | "matched"
    | "missing"
    | "non-regular"
    | "oversized"
    | "path-escape"
    | "selection-invalid"
    | "size-mismatch"
    | "symlink"
    | "token-mismatch"
    | "v1";
  readonly memoryStorageId?: string;
  readonly storageVersionId?: string;
  readonly sourceHash?: string;
  readonly sourceSize?: number;
  readonly injectedTokenCount: number;
}

export type PiMemoryToolOperation = "list" | "search" | "read";

export type PiMemoryToolErrorClass =
  | "aborted"
  | "binary"
  | "invalid-input"
  | "invalid-utf8"
  | "io"
  | "missing"
  | "non-directory"
  | "non-regular"
  | "oversized"
  | "path-race"
  | "symlink"
  | "timeout";

/** Content-free execution-side evidence that one frozen memory source was used. */
export interface PiMemoryToolSourceUse {
  readonly operation: PiMemoryToolOperation;
  readonly outcome: "success" | "error";
  readonly errorClass?: PiMemoryToolErrorClass;
  readonly memoryStorageId: string;
  readonly storageVersionId: string;
  readonly pathHash: string;
  readonly visitedEntries: number;
  readonly scannedFiles: number;
  readonly scannedBytes: number;
  readonly returnedEntries: number;
  readonly returnedLines: number;
  readonly returnedMatches: number;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface PiSessionInspection {
  readonly sessionId: string;
  readonly messageCount: number;
  readonly hasPendingToolCalls: boolean;
  readonly pendingToolIds: readonly string[];
  readonly isSettledHistory: boolean;
}
