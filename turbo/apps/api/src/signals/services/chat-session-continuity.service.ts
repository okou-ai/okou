import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { blobs } from "@okouai/db/schema/blob";
import { conversations } from "@okouai/db/schema/conversation";
import { computed, type Computed } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import type { ChatThreadRequestRow } from "./chat-thread-request-facts";
import {
  canReuseSession,
  type SessionExecutionIdentity,
} from "./session-compatibility";

export type ChatThreadSessionRoute = SessionExecutionIdentity;

export type ChatThreadSessionResolutionAction =
  "initialized" | "reused" | "rotated";

export interface ChatThreadSessionSnapshot {
  readonly threadAgentId: string | null;
  readonly agentSessionId: string | null;
  readonly agentSessionRunId: string | null;
  readonly sessionId: string | null;
  readonly conversationId: string | null;
}

export interface ChatThreadSessionResolution {
  readonly sessionId: string | undefined;
  readonly previousAgentId: string | null;
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
  readonly cliAgentType: string | null;
  readonly cloudBrowserEnabled: boolean;
  readonly session: ChatThreadExecutionSnapshot["session"] | null;
}

export type ChatThreadSessionRead = Omit<
  ChatThreadSessionQuerySnapshot,
  | "threadAgentId"
  | "agentSessionId"
  | "agentSessionRunId"
  | "cloudBrowserEnabled"
  | "agent"
>;

export function createChatThreadSessionRead(
  thread$: Computed<Promise<ChatThreadRequestRow | null>>,
  orgId: string,
  userId: string,
): Computed<Promise<ChatThreadSessionRead | undefined>> {
  return computed(async (get) => {
    const thread = await get(thread$);
    if (!thread?.agentSessionId) {
      return undefined;
    }
    const conversationRun = alias(agentRuns, "chat_thread_conversation_run");
    const [row] = await get(db$)
      .select({
        selectedModel: agentRuns.selectedModel,
        cliAgentType: sql`${agentRuns.launchSnapshot}->>'framework'`.mapWith(
          nullableDriverValueDecoder(conversations.cliAgentType),
        ),
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
          id: conversationRun.id,
          vars: conversationRun.vars,
          storageMounts: conversationRun.storageMounts,
          selectedModel: conversationRun.selectedModel,
        },
      })
      .from(agentSessions)
      .leftJoin(
        conversations,
        eq(conversations.id, agentSessions.conversationId),
      )
      .leftJoin(blobs, eq(blobs.hash, conversations.cliAgentSessionHistoryHash))
      .leftJoin(conversationRun, eq(conversationRun.id, conversations.runId))
      .leftJoin(
        agentRuns,
        thread.agentSessionRunId
          ? eq(agentRuns.id, thread.agentSessionRunId)
          : sql`FALSE`,
      )
      .where(
        and(
          eq(agentSessions.id, thread.agentSessionId),
          eq(agentSessions.userId, userId),
          eq(agentSessions.orgId, orgId),
        ),
      )
      .limit(1);
    return row;
  });
}

/** Compare the model and runtime belonging to the same native generation. */
export function chatThreadSessionIdentity(
  read: ChatThreadSessionRead | undefined,
): SessionExecutionIdentity | null {
  if (!read?.session) {
    return null;
  }
  if (read.conversation) {
    return {
      selectedModel: read.previousRun?.selectedModel ?? null,
      cliAgentType: read.conversation.cliAgentType,
    };
  }
  return {
    selectedModel: read.selectedModel,
    cliAgentType: read.cliAgentType,
  };
}

export function capturedChatThreadSessionSnapshot(
  thread: ChatThreadRequestRow,
  read: ChatThreadSessionRead | undefined,
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
    cliAgentType: read?.cliAgentType ?? null,
    session: read?.session ?? null,
    conversation: read?.conversation ?? null,
    historyBlob: read?.historyBlob ?? null,
    previousRun: read?.previousRun ?? null,
  };
}

export function resolveChatThreadSessionSnapshot(
  thread: ChatThreadSessionQuerySnapshot,
  args: { readonly route: ChatThreadSessionRoute },
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
    const identity = chatThreadSessionIdentity(thread);
    const rotate = identity !== null && !canReuseSession(identity, args.route);
    return {
      sessionId: session.id,
      action: rotate ? "rotated" : "reused",
      previousAgentId: session.agentId,
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
    previousAgentId: null,
    action: "initialized",
    resetNativeSession: false,
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
