import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreadSshAccessOverrides } from "@okouai/db/schema/chat-thread-ssh-access-override";
import { chatThreadVncAccessOverrides } from "@okouai/db/schema/chat-thread-vnc-access-override";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { and, eq, exists, sql, type SQLWrapper } from "drizzle-orm";

import { QueryBuilder } from "drizzle-orm/pg-core";

/** A Run must still refer to its own current, Agent-bound chat thread. */
export function runThreadExists() {
  return exists(
    new QueryBuilder()
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
          eq(chatThreads.userId, agentRuns.userId),
          eq(chatThreads.agentId, agentSessions.agentId),
        ),
      ),
  );
}

/** Correlated to the outer Run, Session and exact SSH host. */
export function runThreadSshAccess(
  host: {
    readonly id: SQLWrapper;
    readonly defaultEnabledForChats: SQLWrapper;
  } = sshConnections,
) {
  return exists(
    new QueryBuilder()
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .leftJoin(
        chatThreadSshAccessOverrides,
        and(
          eq(chatThreadSshAccessOverrides.chatThreadId, chatThreads.id),
          eq(chatThreadSshAccessOverrides.connectionId, host.id),
        ),
      )
      .where(
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
          eq(chatThreads.userId, agentRuns.userId),
          eq(chatThreads.agentId, agentSessions.agentId),
          sql`coalesce(${chatThreadSshAccessOverrides.enabled}, ${host.defaultEnabledForChats}) = true`,
        ),
      ),
  );
}

/** Correlated to the outer Run, Session and exact VNC host. */
export function runThreadVncAccess() {
  return exists(
    new QueryBuilder()
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .leftJoin(
        chatThreadVncAccessOverrides,
        and(
          eq(chatThreadVncAccessOverrides.chatThreadId, chatThreads.id),
          eq(chatThreadVncAccessOverrides.connectionId, vncConnections.id),
        ),
      )
      .where(
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
          eq(chatThreads.userId, agentRuns.userId),
          eq(chatThreads.agentId, agentSessions.agentId),
          sql`coalesce(${chatThreadVncAccessOverrides.enabled}, ${vncConnections.defaultEnabledForChats}) = true`,
        ),
      ),
  );
}
