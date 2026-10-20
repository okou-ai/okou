import { and, eq, exists, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { agentRuns } from "../runtime/agent-run";
import { chatThreads } from "../runtime/chat-thread";
import { activeAgentRuns } from "../schema/active-agent-run";

/** Publish only while this Run still owns the Thread's active slot. */
export function nativeThreadBindingSql(args: {
  readonly run: Pick<
    typeof agentRuns.$inferSelect,
    "id" | "agentId" | "chatThreadId"
  >;
  readonly owner: { readonly userId: string; readonly orgId: string };
  readonly framework: string;
  readonly sessionId: string;
}) {
  const { run, owner, framework, sessionId } = args;
  if (!run.chatThreadId || !run.agentId) {
    return;
  }
  const dialect = new PgDialect();
  // This identity write leaves liveness/activity untouched. Its RETURNING row
  // gates publication and holds the existing active row until the statement
  // ends. A concurrent slot DELETE either waits for publication or wins first,
  // leaving no owner row and therefore no Thread update. A snapshot-only EXISTS
  // would still admit a publisher that waited while its slot was deleted.
  const ownership = dialect.buildUpdateQuery({
    table: activeAgentRuns,
    set: { runId: sql`${activeAgentRuns.runId}` },
    joins: [],
    where: and(
      eq(activeAgentRuns.runId, run.id),
      eq(activeAgentRuns.chatThreadId, run.chatThreadId),
      eq(activeAgentRuns.userId, owner.userId),
      eq(activeAgentRuns.orgId, owner.orgId),
    ),
    returning: [{ path: ["runId"], field: activeAgentRuns.runId }],
  });
  const publication = dialect.buildUpdateQuery({
    table: chatThreads,
    set: {
      framework: sql.param(framework, chatThreads.framework),
      frameworkSessionId: sql.param(sessionId, chatThreads.frameworkSessionId),
      frameworkSessionRunId: sql.param(
        run.id,
        chatThreads.frameworkSessionRunId,
      ),
    },
    from: agentRuns,
    joins: [],
    where: and(
      exists(sql`(SELECT 1 FROM native_session_owner)`),
      eq(chatThreads.id, run.chatThreadId),
      eq(chatThreads.userId, owner.userId),
      eq(chatThreads.agentId, run.agentId),
      eq(agentRuns.id, run.id),
      eq(agentRuns.chatThreadId, chatThreads.id),
      eq(agentRuns.agentId, chatThreads.agentId),
      eq(agentRuns.userId, owner.userId),
      eq(agentRuns.orgId, owner.orgId),
      eq(agentRuns.framework, framework),
      eq(agentRuns.frameworkSessionId, sessionId),
    ),
  });
  return sql`WITH native_session_owner AS (${ownership}) ${publication}`;
}
