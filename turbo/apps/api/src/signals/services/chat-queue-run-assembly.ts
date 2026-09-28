import type { DispatchFailedRunCallbacks } from "./agent-run-create.service";
import type { CreateQueueFirstAgentRunCommandArgs } from "./agent-runs-create.service";

/** Why a head is rejected, and who is told. */
export interface ChatQueueHeadRejection {
  readonly error: { readonly code: string; readonly message: string };
  /** The user the rejection text is formatted for. */
  readonly userId: string;
  /** Delivers the rejection to the integration the input came from, if any. */
  readonly deliver?: (
    assistantEventId: string,
    signal: AbortSignal,
  ) => Promise<void>;
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
  readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
}

/**
 * What an assembler made of a head:
 * - `assembled`: run parameters, how a create failure is told, and what the
 *   producer records once the run exists;
 * - `rejected`: the head can never launch;
 * - `not-ready`: the input could not be assembled. The picker rechecks the
 *   head and rejects it if it is unchanged and the thread is still idle.
 */
export type ChatQueueRunAssembly =
  | {
      readonly kind: "assembled";
      readonly run: CreateQueueFirstAgentRunCommandArgs;
      readonly rejection: (error: {
        readonly code: string;
        readonly message: string;
      }) => ChatQueueHeadRejection;
      readonly launched: (runId: string, signal: AbortSignal) => Promise<void>;
    }
  | { readonly kind: "rejected"; readonly rejection: ChatQueueHeadRejection }
  | { readonly kind: "not-ready" };
