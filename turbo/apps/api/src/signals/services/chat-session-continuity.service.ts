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
  readonly cloudBrowserEnabled: boolean;
  readonly nativeContinuation: NativeContinuation;
  readonly executionSnapshot: ChatThreadExecutionSnapshot;
}

/** The captured Thread owns the native binding; a producer Run need not survive. */
export function resolveChatThreadContinuation(
  thread: ChatThreadRequestRow,
  args: {
    readonly cliAgentType: string | null;
    readonly officialWorkflow: boolean;
  },
): ChatThreadContinuation {
  const reusable =
    !args.officialWorkflow &&
    thread.framework !== null &&
    thread.framework === args.cliAgentType &&
    thread.frameworkSessionId !== null &&
    thread.frameworkSessionRunId !== null;
  const nativeContinuation: NativeContinuation = {
    sessionId: reusable ? thread.frameworkSessionId : null,
    generationRunId: reusable ? thread.frameworkSessionRunId : null,
    // A missing ID is the first native context, even if an earlier attempt
    // failed before initialization. The Guest applies recovery only if it
    // cannot actually resume the retained context.
    recoveryPrompt:
      !args.officialWorkflow && thread.frameworkSessionId !== null
        ? NATIVE_CONTEXT_RECOVERY_PROMPT
        : null,
  };
  return {
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
