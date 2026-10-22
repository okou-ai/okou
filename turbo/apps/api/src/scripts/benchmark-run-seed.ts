import { agentRuns } from "@okouai/db/runtime/agent-run";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { billingRunLifecycleConflictSet } from "@okouai/db/operations/billing-run-lifecycle";
import { command } from "ccstate";
import { count, eq, sql } from "drizzle-orm";
import { pgIntegerDecoder } from "../lib/db-structured-result";
import { safeSqlStateCode } from "../lib/pg-errors";
import { writeDb$ } from "../signals/external/db";
import { settle } from "../signals/utils";

// These synthetic Runs deliberately have canonical, provisional billing
// identities. Capture from the inserted rows, including their exact DB clock,
// so benchmark setup does not depend on the historical Run INSERT trigger.
export const insertBenchmarkRunBatch$ = command(
  async ({ set }, rows: readonly (typeof agentRuns.$inferInsert)[]) => {
    if (rows.length === 0 || rows.length > 500) {
      throw new Error("Benchmark Run batches must contain 1 to 500 rows");
    }
    const db = set(writeDb$);
    const inserted = db.$with("benchmark_inserted_runs").as(
      db
        .insert(agentRuns)
        .values([...rows])
        .returning({
          id: agentRuns.id,
          orgId: agentRuns.orgId,
          userId: agentRuns.userId,
          createdAt: agentRuns.createdAt,
          triggerSource: agentRuns.triggerSource,
          chatThreadId: agentRuns.chatThreadId,
          status: agentRuns.status,
          completedAt: agentRuns.completedAt,
        }),
    );
    const lifecycle = billingRunLifecycleConflictSet();
    const identities = db.$with("benchmark_run_identities").as(sql`
          INSERT INTO ${billingRunAttribution} (
            run_id, org_id, user_id, run_started_at, source, thread_id, thread_context,
            run_terminal_status, run_completed_at, run_lifecycle_context
          )
          SELECT ${inserted.id}, ${inserted.orgId}, ${inserted.userId}, ${inserted.createdAt},
            CASE
              WHEN ${inserted.triggerSource} = 'web' THEN 'chat'
              WHEN ${inserted.triggerSource} IN ('automation-schedule', 'automation-event') THEN 'automation'
              WHEN ${inserted.triggerSource} IN ('slack', 'discord', 'teams', 'telegram', 'email', 'agentphone', 'github', 'agent') THEN ${inserted.triggerSource}
              ELSE 'other'
            END,
            ${inserted.chatThreadId},
            CASE WHEN ${inserted.chatThreadId} IS NULL THEN 'threadless' ELSE 'thread' END,
            CASE WHEN ${inserted.status} IN ('completed', 'failed', 'cancelled', 'timeout') THEN ${inserted.status} END,
            CASE WHEN ${inserted.status} IN ('completed', 'failed', 'cancelled', 'timeout') THEN ${inserted.completedAt} END,
            'captured'
          FROM ${inserted}
          ORDER BY ${inserted.id}
          ON CONFLICT (run_id) DO UPDATE SET
            thread_id = CASE WHEN billing_run_attribution.thread_context = 'unknown'
              THEN EXCLUDED.thread_id ELSE billing_run_attribution.thread_id END,
            thread_context = CASE WHEN billing_run_attribution.thread_context = 'unknown'
              THEN EXCLUDED.thread_context ELSE billing_run_attribution.thread_context END,
            run_terminal_status = ${lifecycle.runTerminalStatus},
            run_completed_at = ${lifecycle.runCompletedAt},
            run_lifecycle_context = ${lifecycle.runLifecycleContext}
          WHERE billing_run_attribution.org_id = EXCLUDED.org_id
            AND billing_run_attribution.user_id = EXCLUDED.user_id
            AND billing_run_attribution.run_started_at = EXCLUDED.run_started_at
            AND billing_run_attribution.source = EXCLUDED.source
          RETURNING run_id AS "runId"
        `);
    // The nonempty carrier evaluates the guard even when every identity conflicts.
    // Raising inside SQL rolls back both inserts before exposing the old error.
    const result = await settle(
      db
        .with(inserted, identities)
        .select({
          complete: sql`1 / CASE WHEN ${eq(
            db.select({ count: count() }).from(identities),
            rows.length,
          )} THEN 1 ELSE 0 END`.mapWith(pgIntegerDecoder),
        })
        .from(sql`(VALUES (1)) AS benchmark_run_completion(value)`),
    );
    if (!result.ok) {
      if (safeSqlStateCode(result.error) === "22012") {
        throw new Error("Benchmark Run billing identity conflicts");
      }
      throw result.error;
    }
  },
);
