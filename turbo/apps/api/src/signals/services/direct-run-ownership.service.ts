import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { command } from "ccstate";
import { and, eq, exists, isNull, sql } from "drizzle-orm";
import { pgIntegerDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import type { UnacceptedRunOwner } from "./agent-run-terminal-transition.service";

export interface DirectRunTarget extends UnacceptedRunOwner {
  readonly hostname: string;
}

/** Run -> active owner -> Thread follows the existing terminal lock order. */
export const selectDirectRunOwner$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly target: DirectRunTarget;
      readonly previous: UnacceptedRunOwner | null;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const at = nowDate();
    const changed = db.$with("direct_selected_run").as(
      db
        .update(agentRuns)
        .set({
          status: "running",
          startedAt: args.previous ? sql`${agentRuns.startedAt}` : at,
          runnerId: args.target.runnerId,
          runnerHeartbeatGeneration: args.target.heartbeatGeneration,
          runnerHostname: args.target.hostname,
          cancellationRecoveryCompleted: false,
        })
        .where(
          and(
            eq(agentRuns.id, args.runId),
            eq(agentRuns.userId, args.userId),
            eq(agentRuns.orgId, args.orgId),
            eq(agentRuns.status, args.previous ? "running" : "pending"),
            args.previous
              ? and(
                  eq(agentRuns.runnerId, args.previous.runnerId),
                  eq(
                    agentRuns.runnerHeartbeatGeneration,
                    args.previous.heartbeatGeneration,
                  ),
                )
              : and(
                  isNull(agentRuns.runnerId),
                  isNull(agentRuns.runnerHeartbeatGeneration),
                ),
            exists(
              db
                .select({ runId: activeAgentRuns.runId })
                .from(activeAgentRuns)
                .where(
                  and(
                    eq(activeAgentRuns.runId, agentRuns.id),
                    eq(activeAgentRuns.userId, args.userId),
                    eq(activeAgentRuns.orgId, args.orgId),
                  ),
                ),
            ),
          ),
        )
        .returning({
          id: agentRuns.id,
          userId: agentRuns.userId,
          orgId: agentRuns.orgId,
          agentId: agentRuns.agentId,
          chatThreadId: agentRuns.chatThreadId,
        }),
    );
    const slot = db.$with("direct_selected_owner").as(
      db
        .update(activeAgentRuns)
        .set({ lastHeartbeatAt: at })
        .from(changed)
        .where(
          and(
            eq(activeAgentRuns.runId, changed.id),
            eq(activeAgentRuns.userId, changed.userId),
            eq(activeAgentRuns.orgId, changed.orgId),
          ),
        )
        .returning({ runId: activeAgentRuns.runId }),
    );
    const thread = db.$with("direct_started_thread").as(
      db
        .update(chatThreads)
        .set({
          framework: null,
          frameworkSessionId: null,
          frameworkSessionRunId: args.runId,
        })
        .from(changed)
        .where(
          and(
            sql`${args.previous === null}`,
            eq(chatThreads.id, changed.chatThreadId),
            eq(chatThreads.userId, changed.userId),
            eq(chatThreads.agentId, changed.agentId),
            exists(db.select({ runId: slot.runId }).from(slot)),
          ),
        )
        .returning({ id: chatThreads.id }),
    );
    const [row] = await db
      .with(changed, slot, thread)
      .select({
        id: changed.id,
        // An invariant failure rolls back the whole statement, not just its result.
        guard:
          sql`(CASE WHEN ${slot.runId} IS NULL OR (${args.previous === null} AND ${changed.chatThreadId} IS NOT NULL AND ${thread.id} IS NULL) THEN '__DIRECT_RUN_OWNER__' ELSE '0' END)::integer`.mapWith(
            pgIntegerDecoder,
          ),
      })
      .from(changed)
      .leftJoin(slot, eq(slot.runId, changed.id))
      .leftJoin(thread, eq(thread.id, changed.chatThreadId));
    signal.throwIfAborted();
    return row !== undefined;
  },
);

/** A fresh ordinary lifecycle read, never a payload or dispatch-ledger lookup. */
export const readDirectRunState$ = command(
  async ({ get }, runId: string, signal: AbortSignal) => {
    const [run] = await get(db$)
      .select({
        status: agentRuns.status,
        runnerId: agentRuns.runnerId,
        heartbeatGeneration: agentRuns.runnerHeartbeatGeneration,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    signal.throwIfAborted();
    return run;
  },
);
