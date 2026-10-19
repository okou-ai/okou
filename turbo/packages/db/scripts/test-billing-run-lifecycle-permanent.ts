import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { agentRuns } from "../src/runtime/agent-run";
import {
  billingRunAttribution,
  type BillingRunTerminalStatus,
} from "../src/schema/billing-run-attribution";
import {
  billingRunLifecycleConflictSet,
  billingRunLifecycleValues,
  captureBillingRunTerminalSql,
} from "../src/operations/billing-run-lifecycle";

/** Persistence contract, exercised against replayed and generated schemas. */
export async function validateBillingRunLifecycle(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const db = drizzle(client);
  const orgId = `lifecycle-org-${randomUUID()}`;
  const userId = `lifecycle-user-${randomUUID()}`;
  const ids: string[] = [];
  const startedAt = "2026-10-19 00:00:00.123456";
  const completedAt = new Date("2026-10-19T00:01:00.456Z");
  const statuses = ["completed", "failed", "cancelled", "timeout"] as const;
  const createRun = async () => {
    const id = randomUUID();
    ids.push(id);
    await db.insert(agentRuns).values({
      id,
      orgId,
      userId,
      status: "running",
      prompt: "Billing lifecycle",
      createdAt: sql`${startedAt}::timestamp`,
    });
    return id;
  };
  const insertCapture = (runId: string, status: string, at: string | null) => {
    return db
      .insert(billingRunAttribution)
      .values({
        runId,
        orgId,
        userId,
        source: "other",
        runStartedAt: sql`${startedAt}::timestamp`,
        ...billingRunLifecycleValues(status, at),
      })
      .onConflictDoUpdate({
        target: billingRunAttribution.runId,
        set: billingRunLifecycleConflictSet(),
      });
  };
  const read = (runId: string) => {
    return db
      .select()
      .from(billingRunAttribution)
      .where(eq(billingRunAttribution.runId, runId));
  };
  const finish = (
    runId: string,
    status: BillingRunTerminalStatus,
    at: Date,
  ) => {
    const transitioned = db.$with("lifecycle_terminal").as(
      db
        .update(agentRuns)
        .set({ status, completedAt: at })
        .where(
          and(
            eq(agentRuns.id, runId),
            inArray(agentRuns.status, ["pending", "running"]),
          ),
        )
        .returning({ id: agentRuns.id }),
    );
    const captured = db.$with("lifecycle_captured", {}).as(
      captureBillingRunTerminalSql({
        condition: inArray(
          agentRuns.id,
          db.select({ id: transitioned.id }).from(transitioned),
        ),
        status,
        completedAt: at,
      }),
    );
    return db.with(transitioned, captured).select().from(transitioned);
  };
  try {
    for (const status of statuses) {
      const id = await createRun();
      // Admission creates the provisional identity before any terminal writer.
      await insertCapture(id, "running", null);
      assert.equal((await finish(id, status, completedAt)).length, 1);
      const [fact] = await read(id);
      assert.ok(fact);
      assert.equal(fact.runLifecycleContext, "captured");
      assert.equal(fact.runTerminalStatus, status);
      assert.equal(
        fact.runCompletedAt?.toISOString(),
        completedAt.toISOString(),
      );
      assert.equal(fact.usageObserved, false);
      const anchor = await client.query(
        "SELECT run_started_at::text AS anchor FROM billing_run_attribution WHERE run_id = $1",
        [id],
      );
      assert.equal(anchor.rows[0]?.anchor, startedAt);

      // A usage request can finish with the snapshot it took before termination.
      await insertCapture(id, "running", null);
      assert.deepEqual(await read(id), [fact]);
      assert.equal(
        (await finish(id, "failed", new Date(completedAt.getTime() + 1000)))
          .length,
        0,
      );
      assert.deepEqual(await read(id), [fact]);
      await db.delete(agentRuns).where(eq(agentRuns.id, id));
      assert.deepEqual(await read(id), [fact]);
    }

    // Terminal publication never creates a missing historical identity. A late
    // identity writer captures the retained Run, before the future backfill gate.
    const legacyId = await createRun();
    await finish(legacyId, "failed", completedAt);
    assert.deepEqual(await read(legacyId), []);
    await insertCapture(legacyId, "failed", completedAt.toISOString());
    assert.equal((await read(legacyId))[0]?.runTerminalStatus, "failed");

    // A first usage capture after termination preserves the DB timestamp text.
    const lateId = await createRun();
    const exactTime = "2026-10-19 00:01:00.654321";
    await insertCapture(lateId, "completed", exactTime);
    const exact = await client.query(
      "SELECT run_completed_at::text AS at FROM billing_run_attribution WHERE run_id = $1",
      [lateId],
    );
    assert.equal(exact.rows[0]?.at, exactTime);

    // Owner mismatches cannot publish terminal facts into another owner's ledger.
    const outsideId = await createRun();
    await db.insert(billingRunAttribution).values({
      runId: outsideId,
      orgId,
      userId: `${userId}-outside`,
      source: "other",
      runStartedAt: sql`${startedAt}::timestamp`,
    });
    const outsideBefore = await read(outsideId);
    await finish(outsideId, "completed", completedAt);
    assert.deepEqual(await read(outsideId), outsideBefore);

    const unavailableId = await createRun();
    await db.insert(billingRunAttribution).values({
      runId: unavailableId,
      orgId,
      userId,
      source: "other",
      runStartedAt: sql`${startedAt}::timestamp`,
      runLifecycleContext: "legacy_unavailable",
    });
    const unavailable = await read(unavailableId);
    await insertCapture(unavailableId, "completed", exactTime);
    assert.deepEqual(await read(unavailableId), unavailable);

    const invalidId = await createRun();
    await db.insert(billingRunAttribution).values({
      runId: invalidId,
      orgId,
      userId,
      source: "other",
      runStartedAt: sql`${startedAt}::timestamp`,
    });
    for (const change of [
      { run_lifecycle_context: "invented" },
      { run_lifecycle_context: "unknown", run_terminal_status: "completed" },
      { run_lifecycle_context: "captured", run_terminal_status: "running" },
      {
        run_lifecycle_context: "captured",
        run_completed_at: completedAt.toISOString(),
      },
      {
        run_lifecycle_context: "legacy_unavailable",
        run_completed_at: completedAt.toISOString(),
      },
    ]) {
      const keys = Object.keys(change);
      const values = Object.values(change);
      await assert.rejects(
        client.query(
          `UPDATE billing_run_attribution SET ${keys
            .map((key, i) => {
              return `${key} = $${i + 2}`;
            })
            .join(", ")} WHERE run_id = $1`,
          [invalidId, ...values],
        ),
        /billing_run_attribution_lifecycle_check/,
      );
    }
    // Historical terminal rows can genuinely have no completion timestamp.
    await insertCapture(invalidId, "completed", null);
    const [withoutTime] = await read(invalidId);
    assert.equal(withoutTime?.runCompletedAt, null);
    assert.equal(withoutTime?.runTerminalStatus, "completed");
  } finally {
    await db.delete(agentRuns).where(inArray(agentRuns.id, ids));
    await db
      .delete(billingRunAttribution)
      .where(inArray(billingRunAttribution.runId, ids));
    await client.end();
  }
}
