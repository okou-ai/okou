import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { conversations } from "@okouai/db/schema/conversation";
import { and, eq, sql } from "drizzle-orm";

import { pgBooleanDecoder } from "../../lib/db-structured-result";
import type { Db, ReadonlyDb } from "../external/db";
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
  readonly agentSessionId: string | null;
  readonly agentSessionRunId: string | null;
  readonly sessionId: string | null;
  readonly conversationId: string | null;
}

export interface ChatThreadSessionResolution {
  readonly sessionId: string | undefined;
  readonly action: ChatThreadSessionResolutionAction;
  readonly expected: ChatThreadSessionSnapshot;
  readonly cloudBrowserEnabled: boolean;
}

function historylessConversationSql() {
  return sql`(
    ${conversations.id} IS NOT NULL
    AND ${conversations.cliAgentSessionHistory} IS NULL
    AND ${conversations.cliAgentSessionHistoryHash} IS NULL
  )`.mapWith(pgBooleanDecoder);
}

export async function resolveChatThreadSession(args: {
  readonly db: Db | ReadonlyDb;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  /** The stored agent when a producer atomically rebinds this thread. */
  readonly expectedThreadAgentId?: string;
  readonly route: ChatThreadSessionRoute;
}): Promise<ChatThreadSessionResolution> {
  const [thread] = await args.db
    .select({
      threadAgentId: chatThreads.agentId,
      agentSessionId: chatThreads.agentSessionId,
      agentSessionRunId: chatThreads.agentSessionRunId,
      sessionId: agentSessions.id,
      conversationId: agentSessions.conversationId,
      selectedModel: agentRuns.selectedModel,
      cliAgentType: conversations.cliAgentType,
      historylessConversation: historylessConversationSql(),
      cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
    })
    .from(chatThreads)
    .leftJoin(
      agentSessions,
      and(
        eq(agentSessions.id, chatThreads.agentSessionId),
        eq(agentSessions.userId, args.userId),
        eq(agentSessions.orgId, args.orgId),
        eq(agentSessions.agentId, args.agentId),
      ),
    )
    .leftJoin(conversations, eq(conversations.id, agentSessions.conversationId))
    .leftJoin(agentRuns, eq(agentRuns.id, chatThreads.agentSessionRunId))
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.userId),
        eq(chatThreads.agentId, args.expectedThreadAgentId ?? args.agentId),
      ),
    )
    .limit(1);
  if (!thread) {
    throw new Error("Chat thread not found while resolving session binding");
  }

  if (thread.agentSessionId !== null && thread.sessionId !== null) {
    const expected = {
      agentSessionId: thread.agentSessionId,
      agentSessionRunId: thread.agentSessionRunId,
      sessionId: thread.sessionId,
      conversationId: thread.conversationId,
    };
    const rotate =
      thread.threadAgentId !== args.agentId ||
      thread.historylessConversation ||
      !canReuseSession(thread, args.route);
    return {
      sessionId: rotate ? undefined : thread.sessionId,
      action: rotate ? "rotated" : "reused",
      expected,
      cloudBrowserEnabled: thread.cloudBrowserEnabled,
    };
  }

  return {
    sessionId: undefined,
    action: thread.threadAgentId === args.agentId ? "initialized" : "rotated",
    expected: {
      agentSessionId: thread.agentSessionId,
      agentSessionRunId: thread.agentSessionRunId,
      sessionId: null,
      conversationId: null,
    },
    cloudBrowserEnabled: thread.cloudBrowserEnabled,
  };
}
