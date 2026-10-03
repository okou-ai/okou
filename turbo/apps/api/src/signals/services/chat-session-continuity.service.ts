import { agentRuns } from "@okouai/db/runtime/agent-run";
import type { ChatThreadRequestRow } from "./chat-thread-request-facts";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { blobs } from "@okouai/db/schema/blob";
import { conversations } from "@okouai/db/schema/conversation";
import { alias } from "drizzle-orm/pg-core";
import {
  canReuseSession,
  type SessionExecutionIdentity,
} from "./session-compatibility";

export type ChatThreadSessionRoute = SessionExecutionIdentity;

export type ChatThreadSessionResolutionAction =
  | "initialized"
  | "reused"
  | "rotated";

export interface ChatThreadSessionSnapshot {
  readonly threadAgentId: string | null;
  readonly agentSessionId: string | null;
  readonly agentSessionRunId: string | null;
  readonly sessionId: string | null;
  readonly conversationId: string | null;
}

export interface ChatThreadSessionResolution {
  readonly sessionId: string | undefined;
  /** Native history may reset while the thread keeps its application session. */
  readonly action: ChatThreadSessionResolutionAction;
  readonly resetNativeSession: boolean;
  readonly expected: ChatThreadSessionSnapshot;
  readonly cloudBrowserEnabled: boolean;
  readonly executionSnapshot?: ChatThreadExecutionSnapshot;
}

export interface ChatThreadExecutionSnapshot {
  readonly session: Pick<
    typeof agentSessions.$inferSelect,
    "id" | "agentId" | "storageMounts" | "conversationId"
  >;
  readonly agent: Pick<
    typeof agents.$inferSelect,
    "id" | "orgId" | "owner"
  > | null;
  readonly conversation: Pick<
    typeof conversations.$inferSelect,
    | "id"
    | "runId"
    | "cliAgentType"
    | "cliAgentSessionId"
    | "cliAgentSessionHistory"
    | "cliAgentSessionHistoryHash"
  > | null;
  readonly historyBlob: Pick<
    typeof blobs.$inferSelect,
    "hash" | "encoding"
  > | null;
  readonly previousRun: Pick<
    typeof agentRuns.$inferSelect,
    "id" | "vars" | "storageMounts" | "selectedModel"
  > | null;
}

export interface ChatThreadSessionQuerySnapshot extends Omit<
  ChatThreadExecutionSnapshot,
  "session"
> {
  readonly threadAgentId: string | null;
  readonly agentSessionId: string | null;
  readonly agentSessionRunId: string | null;
  readonly selectedModel: string | null;
  readonly cloudBrowserEnabled: boolean;
  readonly session: ChatThreadExecutionSnapshot["session"] | null;
}

export const chatThreadConversationRun = alias(
  agentRuns,
  "chat_thread_conversation_run",
);

export function chatThreadSessionSelection() {
  return {
    selectedModel: agentRuns.selectedModel,
    session: {
      id: agentSessions.id,
      agentId: agentSessions.agentId,
      storageMounts: agentSessions.storageMounts,
      conversationId: agentSessions.conversationId,
    },
    conversation: {
      id: conversations.id,
      runId: conversations.runId,
      cliAgentType: conversations.cliAgentType,
      cliAgentSessionId: conversations.cliAgentSessionId,
      cliAgentSessionHistory: conversations.cliAgentSessionHistory,
      cliAgentSessionHistoryHash: conversations.cliAgentSessionHistoryHash,
    },
    historyBlob: { hash: blobs.hash, encoding: blobs.encoding },
    previousRun: {
      id: chatThreadConversationRun.id,
      vars: chatThreadConversationRun.vars,
      storageMounts: chatThreadConversationRun.storageMounts,
      selectedModel: chatThreadConversationRun.selectedModel,
    },
  };
}

export function capturedChatThreadSessionSnapshot(
  thread: ChatThreadRequestRow,
  read:
    | Omit<
        ChatThreadSessionQuerySnapshot,
        | "threadAgentId"
        | "agentSessionId"
        | "agentSessionRunId"
        | "cloudBrowserEnabled"
        | "agent"
      >
    | undefined,
  agent: ChatThreadExecutionSnapshot["agent"],
): ChatThreadSessionQuerySnapshot {
  // Preserve the original LEFT JOIN's nullable session result when no session exists.
  return {
    threadAgentId: thread.agentId,
    agentSessionId: thread.agentSessionId,
    agentSessionRunId: thread.agentSessionRunId,
    cloudBrowserEnabled: thread.cloudBrowserEnabled,
    agent,
    selectedModel: read?.selectedModel ?? null,
    session: read?.session ?? null,
    conversation: read?.conversation ?? null,
    historyBlob: read?.historyBlob ?? null,
    previousRun: read?.previousRun ?? null,
  };
}

export function resolveChatThreadSessionSnapshot(
  thread: ChatThreadSessionQuerySnapshot,
  args: { readonly agentId: string; readonly route: ChatThreadSessionRoute },
): ChatThreadSessionResolution {
  const session = thread.session;
  if (thread.agentSessionId !== null && session !== null) {
    const expected = {
      threadAgentId: thread.threadAgentId,
      agentSessionId: thread.agentSessionId,
      agentSessionRunId: thread.agentSessionRunId,
      sessionId: session.id,
      conversationId: session.conversationId,
    };
    const historylessConversation =
      thread.conversation !== null &&
      thread.conversation.cliAgentSessionHistory === null &&
      thread.conversation.cliAgentSessionHistoryHash === null;
    const rotate =
      thread.threadAgentId !== args.agentId ||
      session.agentId !== args.agentId ||
      historylessConversation ||
      !canReuseSession(
        {
          selectedModel: thread.selectedModel,
          cliAgentType: thread.conversation?.cliAgentType ?? null,
        },
        args.route,
      );
    return {
      sessionId: session.id,
      action: rotate ? "rotated" : "reused",
      resetNativeSession: rotate,
      expected,
      cloudBrowserEnabled: thread.cloudBrowserEnabled,
      executionSnapshot: {
        session,
        agent: thread.agent,
        conversation: thread.conversation,
        historyBlob: thread.historyBlob,
        previousRun: thread.previousRun,
      },
    };
  }

  return {
    sessionId: undefined,
    action: thread.threadAgentId === args.agentId ? "initialized" : "rotated",
    resetNativeSession: thread.threadAgentId !== args.agentId,
    expected: {
      threadAgentId: thread.threadAgentId,
      agentSessionId: thread.agentSessionId,
      agentSessionRunId: thread.agentSessionRunId,
      sessionId: null,
      conversationId: null,
    },
    cloudBrowserEnabled: thread.cloudBrowserEnabled,
  };
}
