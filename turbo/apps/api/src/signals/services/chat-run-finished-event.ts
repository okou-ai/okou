import type { ChatRunFinishedRunStatus } from "@okouai/api-contracts/contracts/workflows";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";

export interface ChatRunFinishedEvent {
  readonly chatThreadId: string;
  readonly runId: string;
  /** Persisted source chat callback that owns this event's admission receipts. */
  readonly sourceCallbackId: string;
  readonly runStatus: ChatRunFinishedRunStatus;
  readonly failureReason: RunFailureReasonToken | null;
  readonly lastResultText: string | null;
  readonly sourceAgentId: string;
  readonly sourceThreadTitle: string | null;
}
