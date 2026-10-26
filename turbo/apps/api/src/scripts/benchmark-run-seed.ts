import { agentRuns } from "@okouai/db/runtime/agent-run";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { billingRunLifecycleConflictSet } from "@okouai/db/operations/billing-run-lifecycle";
import { command } from "ccstate";
import { count, isNotNull, min, ne, sql } from "drizzle-orm";
import { object, uuid } from "zod";
import {
  nullableDriverValueDecoder,
  pgIntegerDecoder,
  pgTextDecoder,
} from "../lib/db-structured-result";
import { safeSqlStateCode } from "../lib/pg-errors";
import { writeDb$ } from "../signals/external/db";
import { settle } from "../signals/utils";

const identitySchema = object({ runId: uuid() });

function throwBenchmarkIdentityError(error: unknown): never {
  if (
    safeSqlStateCode(error) === "22P02" &&
    error instanceof Error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "message" in error.cause
  ) {
    const message = error.cause.message;
    if (
      message ===
      'invalid input syntax for type integer: "__TX0004_CONFLICT_V1__"'
    ) {
      throw new Error("Benchmark Run billing identity conflicts");
    }
    if (typeof message === "string") {
      const invalid =
        /^invalid input syntax for type integer: "__TX0004_INVALID_UUID_V1__([0-9a-f-]{36})"$/u.exec(
          message,
        )?.[1];
      if (invalid !== undefined) {
        identitySchema.parse({ runId: invalid });
      }
    }
  }
  throw error;
}

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
    const identities = db.$with("benchmark_run_identities", {
      runId: sql`"runId"`.mapWith(pgTextDecoder).as("runId"),
    }).as(sql`
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
    const summary = db.$with("benchmark_identity_summary").as(
      db
        .select({
          count: count().as("identity_count"),
          invalid:
            sql`${min(sql`${identities.runId}::text COLLATE "C"`)} FILTER (
            WHERE ${identities.runId}::text !~* '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'
          )`
              .mapWith(nullableDriverValueDecoder(pgTextDecoder))
              .as("invalid_uuid"),
        })
        .from(identities),
    );
    // The aggregate has one row even when every identity conflicts. Validate
    // UUIDs before cardinality, raising inside SQL so both writes roll back.
    const result = await settle(
      db
        .with(inserted, identities, summary)
        .select({
          complete: sql`(CASE
            WHEN ${isNotNull(summary.invalid)} THEN '__TX0004_INVALID_UUID_V1__' || ${summary.invalid}
            WHEN ${ne(summary.count, rows.length)} THEN '__TX0004_CONFLICT_V1__'
            ELSE '0' END)::integer`.mapWith(pgIntegerDecoder),
        })
        .from(summary),
    );
    if (!result.ok) {
      throwBenchmarkIdentityError(result.error);
    }
  },
);
