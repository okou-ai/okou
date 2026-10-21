import type { NativeContinuation } from "@okouai/api-contracts/contracts/runners";
import type { ChatThreadRequestRow } from "./chat-thread-request-facts";

export const NATIVE_CONTEXT_RECOVERY_PROMPT =
  "This Run did not resume the earlier native conversation context. Before processing the current request, you must run `okou chat messages --output-dir threads`, read and understand this Thread's earlier messages, and then continue the current request using that context.";

export interface ChatThreadNativeBinding {
  readonly threadAgentId: string | null;
  readonly framework: string | null;
  readonly frameworkSessionId: string | null;
  readonly frameworkSessionRunId: string | null;
}

export interface ChatThreadExecutionSnapshot {
  readonly nativeContinuation: NativeContinuation;
}

export interface ChatThreadContinuation {
  readonly expected: ChatThreadNativeBinding;
  /** Revalidated at the actual Run insertion time before launch can commit. */
  readonly admission: {
    readonly runId: string;
    readonly finalizingSourceRunId: string | null;
  };
  readonly cloudBrowserEnabled: boolean;
  readonly nativeContinuation: NativeContinuation;
  readonly executionSnapshot: ChatThreadExecutionSnapshot;
}

/** A native binding must cover the same executed predecessor as resource affinity. */
export function resolveChatThreadContinuation(
  thread: ChatThreadRequestRow,
  args: {
    readonly cliAgentType: string | null;
    readonly officialWorkflow: boolean;
    readonly admission: ChatThreadContinuation["admission"];
  },
): ChatThreadContinuation {
  const reusable =
    !args.officialWorkflow &&
    thread.framework !== null &&
    thread.framework === args.cliAgentType &&
    thread.frameworkSessionId !== null &&
    args.admission.finalizingSourceRunId !== null &&
    thread.frameworkSessionRunId === args.admission.finalizingSourceRunId;
  const nativeContinuation: NativeContinuation = {
    sessionId: reusable ? thread.frameworkSessionId : null,
    generationRunId: reusable ? thread.frameworkSessionRunId : null,
    // An executed predecessor can lack native initialization while still
    // having durable Chat messages. The Guest also recovers if native-file
    // validation prevents resuming an otherwise current binding.
    recoveryPrompt:
      !args.officialWorkflow &&
      (args.admission.finalizingSourceRunId !== null ||
        thread.frameworkSessionId !== null)
        ? NATIVE_CONTEXT_RECOVERY_PROMPT
        : null,
  };
  return {
    admission: args.admission,
    expected: {
      threadAgentId: thread.agentId,
      framework: thread.framework,
      frameworkSessionId: thread.frameworkSessionId,
      frameworkSessionRunId: thread.frameworkSessionRunId,
    },
    cloudBrowserEnabled: thread.cloudBrowserEnabled,
    nativeContinuation,
    executionSnapshot: { nativeContinuation },
  };
}
