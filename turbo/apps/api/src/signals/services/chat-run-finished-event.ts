import type { ChatRunFinishedRunStatus } from "@okouai/api-contracts/contracts/workflows";

export interface ChatRunFinishedEvent {
  readonly chatThreadId: string;
  readonly runId: string;
  /** Active-mode persisted owner; absent on the preactivation deferred path. */
  readonly sourceCallbackId?: string;
  readonly runStatus: ChatRunFinishedRunStatus;
  readonly lastResultText: string | null;
  readonly sourceAgentId: string;
  readonly sourceThreadTitle: string | null;
}
