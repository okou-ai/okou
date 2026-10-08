import { agentRuns } from "@okouai/db/runtime/agent-run";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { command } from "ccstate";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { parseRawRows } from "../lib/db-raw-rows";
import { writeDb$ } from "../signals/external/db";

const identitySchema = z.object({ runId: z.uuid() });

// These synthetic Runs deliberately have canonical, provisional billing
// identities. Capture from the inserted rows, including their exact DB clock,
// so benchmark setup does not depend on the historical Run INSERT trigger.
export const insertBenchmarkRunBatch$ = command(
  async ({ set }, rows: readonly (typeof agentRuns.$inferInsert)[]) => {
    if (rows.length === 0 || rows.length > 500) {
      throw new Error("Benchmark Run batches must contain 1 to 500 rows");
    }
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(agentRuns)
        .values([...rows])
        .returning({ id: agentRuns.id });
      const identities = parseRawRows(
        identitySchema,
        await tx.execute(sql`
          INSERT INTO ${billingRunAttribution} (
            run_id, org_id, user_id, run_started_at, source, thread_id, thread_context
          )
          SELECT id, org_id, user_id, created_at,
            CASE
              WHEN trigger_source = 'web' THEN 'chat'
              WHEN trigger_source IN ('automation-schedule', 'automation-event') THEN 'automation'
              WHEN trigger_source IN ('slack', 'discord', 'teams', 'telegram', 'email', 'agentphone', 'github', 'agent') THEN trigger_source
              ELSE 'other'
            END,
            chat_thread_id,
            CASE WHEN chat_thread_id IS NULL THEN 'threadless' ELSE 'thread' END
          FROM ${agentRuns}
          WHERE ${inArray(
            agentRuns.id,
            inserted.map((run) => {
              return run.id;
            }),
          )}
          ORDER BY id
          ON CONFLICT (run_id) DO UPDATE SET
            thread_id = CASE WHEN billing_run_attribution.thread_context = 'unknown'
              THEN EXCLUDED.thread_id ELSE billing_run_attribution.thread_id END,
            thread_context = CASE WHEN billing_run_attribution.thread_context = 'unknown'
              THEN EXCLUDED.thread_context ELSE billing_run_attribution.thread_context END
          WHERE billing_run_attribution.org_id = EXCLUDED.org_id
            AND billing_run_attribution.user_id = EXCLUDED.user_id
            AND billing_run_attribution.run_started_at = EXCLUDED.run_started_at
            AND billing_run_attribution.source = EXCLUDED.source
          RETURNING run_id AS "runId"
        `),
      );
      if (identities.length !== inserted.length) {
        throw new Error("Benchmark Run billing identity conflicts");
      }
    });
  },
);
