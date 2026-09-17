import type { PiAgentModelConfig } from "./types";
import type { KnownRunFailureReason } from "@okouai/api-contracts/contracts/run-failure-reasons";
import type { PiApiModelFailureDiagnostic } from "./api-failure";
import type { PiApiFirstTurnOwnership } from "./provider-ownership";
import type { PiPreparationObserver } from "./preparation-timing";
import type { PiMemoryCitation } from "@okouai/api-contracts/contracts/pi-memory-citations";
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
  | "frozen-match"
  | "frozen-no-content"
  | "mismatch"
  | "not-applicable";

export interface PiMemoryRecallOutcome {
  readonly mode: "api-first" | "sandbox";
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

export interface PiApiAssistantTextContent {
  readonly type: "text";
  readonly text: string;
  readonly runEventId?: string;
}

export interface PiApiTextStream {
  readonly eventIdPrefix: string;
  readonly onDelta: (chunk: {
    readonly runEventId: string;
    readonly chunkIndex: number;
    readonly delta: string;
  }) => void;
}

export interface PiApiAssistantToolCallContent {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type PiApiAssistantContent =
  | PiApiAssistantTextContent
  | PiApiAssistantToolCallContent;

export type PiApiAssistantStopReason =
  | "pending"
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "deferred";

interface PiApiAssistantMessageFields {
  readonly content: readonly PiApiAssistantContent[];
  /** Private, bounded provenance removed from every user-visible text field. */
  readonly memoryCitation?: PiMemoryCitation;
  readonly model: string;
  readonly responseId?: string;
  /** Content-free product classification; native provider diagnostics stay private. */
  readonly failureReason?: KnownRunFailureReason;
  readonly timestamp: number;
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    /** Subset of cacheWrite; retained as provider evidence, never added twice. */
    readonly cacheWrite1h?: number;
  };
}

export type PiApiAssistantMessage = PiApiAssistantMessageFields &
  (
    | {
        readonly stopReason: "error" | "aborted";
        readonly failureDiagnostic: PiApiModelFailureDiagnostic;
      }
    | {
        readonly stopReason: Exclude<
          PiApiAssistantStopReason,
          "error" | "aborted"
        >;
        readonly failureDiagnostic?: never;
      }
  );

/** Terminal Responses payload service tier, kept outside persisted Pi state. */
export type PiObservedServiceTier = string | null | undefined;

export interface PiApiFirstTurnArgs {
  readonly textStream?: PiApiTextStream;
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionId: string;
  readonly sessionJsonl?: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
  readonly model: PiAgentModelConfig;
  readonly resourceSnapshot: PiPreheatedResourceSnapshot;
  readonly ownership: PiApiFirstTurnOwnership;
  readonly onMemoryRecallOutcome?: (outcome: PiMemoryRecallOutcome) => void;
  readonly onPreparationTiming?: PiPreparationObserver;
  /**
   * Optional durable gate run immediately before the provider transport.
   * The gate must invoke the marker while it owns its commit boundary.
   */
  readonly providerRequestBoundary?: (
    markProviderRequestMayHaveStarted: () => void,
  ) => Promise<void>;
}

/** Preparation has no provider ownership or durable publication authority. */
export type PiApiTurnPreparationArgs = Omit<
  PiApiFirstTurnArgs,
  "ownership" | "providerRequestBoundary" | "textStream"
>;

export type PiApiTurnExecutionArgs = Pick<
  PiApiFirstTurnArgs,
  "ownership" | "providerRequestBoundary" | "textStream"
>;

/** A private, single-use session; never serialize or cache across attempts. */
export interface PreparedPiApiTurn {
  readonly execute: (
    args: PiApiTurnExecutionArgs,
    signal?: AbortSignal,
  ) => Promise<PiApiFirstTurnResult>;
  readonly dispose: () => void;
}

export interface PiApiFirstTurnResult {
  readonly assistantMessage: PiApiAssistantMessage;
  readonly handoffRequired: boolean;
  readonly observedServiceTier: PiObservedServiceTier;
  /** Missing on reconstructed historical results; never infer it from SDK zeros. */
  readonly usageObservation?: PiApiUsageObservation;
  readonly sessionJsonl: string;
}

/** Disjoint provider quantities; null means the provider did not establish a value. */
export interface PiApiUsageObservation {
  readonly tokens: {
    readonly input: number | null;
    readonly cacheRead: number | null;
    readonly cacheCreation: number | null;
    readonly output: number | null;
  };
  readonly coverage: "complete" | "partial" | "unavailable";
}

export interface PiSessionInspection {
  readonly sessionId: string;
  readonly messageCount: number;
  readonly hasPendingToolCalls: boolean;
  readonly pendingToolIds: readonly string[];
  readonly isSettledCheckpoint: boolean;
}

export type RunPiApiFirstTurn = (
  args: PiApiFirstTurnArgs,
  signal?: AbortSignal,
) => Promise<PiApiFirstTurnResult>;
