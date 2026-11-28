import type {
  NativeContinuation,
  SessionContinuation,
} from "@okouai/api-contracts/contracts/runners";
import type { PickedChatThread } from "./chat-run-preparation-facts";

export const NATIVE_CONTEXT_RECOVERY_PROMPT =
  "This Run did not resume the earlier native conversation context. Before processing the current request, you must run `okou chat messages --output-dir /tmp/okou-chat-history`, read and understand this Thread's earlier messages, and then continue the current request using that context. Chat history files are temporary caches. Store them under `/tmp`, outside personal memory. If removed, synchronize again.";

export interface ChatThreadNativeBinding {
  readonly framework: string | null;
  readonly frameworkSessionId: string | null;
  /** Latest executed predecessor; native readiness also requires the pair above. */
  readonly frameworkSessionRunId: string | null;
}

export interface ChatThreadExecutionSnapshot {
  readonly sessionContinuation: SessionContinuation;
  readonly nativeContinuation: NativeContinuation;
}

export interface ChatThreadContinuation {
  readonly expected: ChatThreadNativeBinding;
  /** Revalidated at the actual Run insertion time before launch can commit. */
  readonly admission: {
    readonly runId: string;
    /** Captured before this Run's first claim advances the Thread to itself. */
    readonly finalizingSourceRunId: string | null;
  };
  readonly cloudBrowserEnabled: boolean;
  readonly sessionContinuation: SessionContinuation;
  readonly nativeContinuation: NativeContinuation;
  readonly executionSnapshot: ChatThreadExecutionSnapshot;
}

/** Decide native continuation purely from framework match and predecessor Run ID. */
export function resolveChatThreadContinuation(
  thread: PickedChatThread,
  args: {
    readonly cliAgentType: string | null;
    readonly allowNativeResume: boolean;
    readonly admission: ChatThreadContinuation["admission"];
  },
): ChatThreadContinuation {
  const continueNative =
    args.allowNativeResume &&
    thread.framework !== null &&
    thread.framework === args.cliAgentType &&
    thread.frameworkSessionRunId !== null;
  const expectedSourceRunId = continueNative
    ? thread.frameworkSessionRunId
    : null;
  // An executed predecessor can lack native initialization while still having
  // durable Chat messages. Runner/Guest also enable recovery on any home miss.
  const recoveryPrompt =
    args.allowNativeResume &&
    (thread.frameworkSessionRunId !== null ||
      thread.frameworkSessionId !== null)
      ? NATIVE_CONTEXT_RECOVERY_PROMPT
      : null;
  const sessionContinuation: SessionContinuation = {
    continueNative,
    expectedSourceRunId,
    recoveryPrompt,
  };
  // Bounded rollout bridge for draining pre-cutover Runners whose
  // NativeContinuation uses deny_unknown_fields. Remove after pre-cutover
  // Runners finish draining and are excluded from rollback.
  const nativeContinuation: NativeContinuation = {
    sessionId: null,
    generationRunId: null,
    recoveryPrompt,
  };
  return {
    admission: args.admission,
    expected: {
      framework: thread.framework,
      frameworkSessionId: thread.frameworkSessionId,
      frameworkSessionRunId: thread.frameworkSessionRunId,
    },
    cloudBrowserEnabled: thread.cloudBrowserEnabled,
    sessionContinuation,
    nativeContinuation,
    executionSnapshot: { sessionContinuation, nativeContinuation },
  };
}
