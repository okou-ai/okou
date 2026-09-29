import type { QueuedPromptRejectionTarget } from "./internal-chat-run-callback.service";

/** Why a head is rejected, and who is told. */
export interface ChatQueueHeadRejection {
  readonly error: { readonly code: string; readonly message: string };
  /** The user the rejection text is formatted for. */
  readonly userId: string;
  /** Delivers the rejection to the integration the input came from, if any. */
  readonly delivery?: QueuedPromptRejectionTarget;
}

/** The queue head an assembler builds a run for. */
export interface ChatQueueHeadContext {
  readonly id: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly contextType: string | null;
  readonly contextId: string | null;
  /** The thread's owner and agent. */
  readonly userId: string;
  readonly agentId: string;
  readonly apiStartTime: number;
}
