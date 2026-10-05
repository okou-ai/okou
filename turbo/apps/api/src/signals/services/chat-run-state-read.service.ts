import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import {
  chatEvents,
  chatEventTerminalPredicate,
} from "@okouai/db/schema/chat-event";
import {
  and,
  eq,
  exists,
  notExists,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";

const terminalEvent = alias(chatEvents, "chat_run_state_terminal");

/** Active rows can outlive the terminal event while the Runner stops. */
export function unfinishedActiveChatRunExists(
  scope: { readonly runId: SQLWrapper } | { readonly chatThreadId: SQLWrapper },
): SQL {
  return exists(
    new QueryBuilder()
      .select({ runId: activeAgentRuns.runId })
      .from(activeAgentRuns)
      .where(
        and(
          "runId" in scope
            ? eq(activeAgentRuns.runId, scope.runId)
            : eq(activeAgentRuns.chatThreadId, scope.chatThreadId),
          notExists(
            new QueryBuilder()
              .select({ id: terminalEvent.id })
              .from(terminalEvent)
              .where(
                and(
                  eq(terminalEvent.runId, activeAgentRuns.runId),
                  chatEventTerminalPredicate(terminalEvent.eventType),
                ),
              ),
          ),
        ),
      ),
  );
}
