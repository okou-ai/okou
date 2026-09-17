import { settleIncludingAbort } from "../../utils";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createStore } from "ccstate";
import { Pool } from "pg";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import {
  recordPiMemoryStage1Usage,
  piMemoryStage1UsageEntries,
  piMemoryStage1AccountingId,
} from "../pi-memory-stage1-usage.service";
import { compactUsageEvents$ } from "../cron-compact-usage-events.service";

// D infrastructure exception: immutable historical billing rows, physical
// compaction and repeatable-read snapshots have no public product read/write API.
// Worker route tests separately cover the real provider/admission lifecycle.
const context = testContext();
const ledgerSql = await readFile(
  new URL(
    "../../../../../../../ops/pi-memory-stage1/v1/ledger.sql",
    import.meta.url,
  ),
  "utf8",
);

function harness() {
  const orgId = randomUUID();
  const userId = randomUUID();
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 2 });
  const store = createStore();
  const db = store.set(writeDb$);
  const args = {
    memoryStorageId: randomUUID(),
    piSessionId: randomUUID(),
    sourceHistoryHash: "a".repeat(64),
    responseSourceId: randomUUID(),
    billing: { mode: "builtin" as const, orgId, userId },
    usage: { input: 10, output: 8, cacheRead: 2, cacheWrite: 3 },
  };
  onTestFinished(async () => {
    await pool.query("DELETE FROM usage_event WHERE org_id=$1", [orgId]);
    await pool.query("DELETE FROM usage_event_hourly_rollup WHERE org_id=$1", [
      orgId,
    ]);
    await pool.end();
  });
  return { pool, db, args, store, orgId, userId };
}

describe("Stage 1 durable usage boundary", () => {
  it("preserves original owner/time and stable response identity on repeated and cross-day replay", async () => {
    const h = harness();
    const first = await recordPiMemoryStage1Usage(h.db, h.args);
    expect(first.disposition).toBe("new");
    const before = await h.pool.query(
      "SELECT * FROM usage_event WHERE org_id=$1 ORDER BY category",
      [h.orgId],
    );
    const replay = await recordPiMemoryStage1Usage(h.db, h.args);
    expect(replay).toStrictEqual({
      disposition: "replay",
      accountingAt: first.accountingAt,
    });
    expect(
      (
        await h.pool.query(
          "SELECT * FROM usage_event WHERE org_id=$1 ORDER BY category",
          [h.orgId],
        )
      ).rows,
    ).toStrictEqual(before.rows);
    for (const row of before.rows) {
      expect(row).toMatchObject({
        billing_context: "pi_memory_stage1",
        run_id: null,
        billing_run_id: null,
        org_id: h.orgId,
        user_id: h.userId,
      });
      expect(row.billing_anchor_at).toStrictEqual(row.created_at);
    }
    expect(piMemoryStage1AccountingId(h.args)).toBe(
      piMemoryStage1AccountingId({
        ...h.args,
        usage: { ...h.args.usage, input: 11 },
      }),
    );
    await expect(
      recordPiMemoryStage1Usage(h.db, {
        ...h.args,
        usage: { ...h.args.usage, input: 11 },
      }),
    ).rejects.toThrow("identity collision");
    // Retained historical timestamp is not an HTTP input. Move only this owned
    // fixture with capture disabled, then replay through the unchanged writer.
    const client = await h.pool.connect();
    const outcome = await settleIncludingAbort(
      (async () => {
        await client.query(
          "BEGIN; SET LOCAL session_replication_role = replica",
        );
        await client.query(
          "UPDATE usage_event SET created_at='2026-09-01 23:59:59', billing_anchor_at='2026-09-01 23:59:59', billing_context='runless' WHERE org_id=$1",
          [h.orgId],
        );
        await client.query("COMMIT");
      })(),
    );
    await client.query("ROLLBACK");
    client.release();
    if (!outcome.ok) {
      throw outcome.error;
    }
    await expect(
      recordPiMemoryStage1Usage(h.db, h.args),
    ).resolves.toStrictEqual({
      disposition: "legacy_replay",
      accountingAt: "2026-09-01T23:59:59.000Z",
    });
    expect(
      (
        await h.pool.query(
          "SELECT DISTINCT billing_context FROM usage_event WHERE org_id=$1",
          [h.orgId],
        )
      ).rows,
    ).toStrictEqual([{ billing_context: "runless" }]);
  });

  it("rejects actual DB subtype and immutable identity mutations", async () => {
    const h = harness();
    await recordPiMemoryStage1Usage(h.db, h.args);
    for (const mutation of [
      "billing_context='runless'",
      "org_id='different'",
      "user_id='different'",
      "billing_anchor_at=now() + interval '1 day'",
      "run_id=gen_random_uuid()",
      "billing_run_id=gen_random_uuid()",
      "kind='image'",
      "created_at=now()+interval '1 day'",
    ]) {
      await expect(
        h.pool.query(`UPDATE usage_event SET ${mutation} WHERE org_id=$1`, [
          h.orgId,
        ]),
      ).rejects.toHaveProperty("code", "23514");
    }
    await expect(
      h.pool.query(
        "INSERT INTO usage_event(idempotency_key, org_id,user_id,kind,provider,category,quantity,billing_context,billing_run_id) VALUES(gen_random_uuid(),$1,$2,'model','gpt-5.6-luna','tokens.input',1,'pi_memory_stage1',gen_random_uuid())",
        [h.orgId, h.userId],
      ),
    ).rejects.toHaveProperty("code", "23514");
    await expect(
      h.pool.query(
        "INSERT INTO usage_event(idempotency_key, org_id,user_id,kind,provider,category,quantity,billing_context) VALUES(gen_random_uuid(),$1,$2,'image','gpt-5.6-luna','tokens.input',1,'pi_memory_stage1')",
        [h.orgId, h.userId],
      ),
    ).rejects.toHaveProperty("code", "23514");
  });

  it("keeps untrusted legacy context collisions closed and BYOK entirely outside the model ledger", async () => {
    const h = harness();
    await expect(
      recordPiMemoryStage1Usage(h.db, {
        ...h.args,
        billing: { ...h.args.billing, mode: "byok" },
        usage: { input: Number.NaN, output: -1, cacheRead: 0, cacheWrite: 0 },
      }),
    ).resolves.toStrictEqual({ disposition: "byok", accountingAt: null });
    expect(
      (
        await h.pool.query(
          "SELECT count(*)::text AS n FROM usage_event WHERE org_id=$1",
          [h.orgId],
        )
      ).rows[0].n,
    ).toBe("0");
    await recordPiMemoryStage1Usage(h.db, h.args);
    const client = await h.pool.connect();
    const outcome = await settleIncludingAbort(
      (async () => {
        await client.query("BEGIN; SET LOCAL session_replication_role=replica");
        await client.query(
          "UPDATE usage_event SET billing_context='legacy_unknown',billing_anchor_at=NULL WHERE org_id=$1",
          [h.orgId],
        );
        await client.query("COMMIT");
      })(),
    );
    await client.query("ROLLBACK");
    client.release();
    if (!outcome.ok) {
      throw outcome.error;
    }
    await expect(recordPiMemoryStage1Usage(h.db, h.args)).rejects.toThrow(
      "identity collision",
    );
  });

  it("uses all cache-inclusive tier quantities at the inclusive long-context boundary", () => {
    expect(
      piMemoryStage1UsageEntries({
        input: 270_000,
        output: 1,
        cacheRead: 2000,
        cacheWrite: 0,
      }).map((x) => {
        return x.category;
      }),
    ).toStrictEqual([
      "tokens.input",
      "tokens.output",
      "tokens.cache_read",
      "tokens.cache_creation",
    ]);
    expect(
      piMemoryStage1UsageEntries({
        input: 270_000,
        output: 1,
        cacheRead: 2000,
        cacheWrite: 1,
      }).map((x) => {
        return x.category;
      }),
    ).toStrictEqual([
      "tokens.input.long_context",
      "tokens.output.long_context",
      "tokens.cache_read.long_context",
      "tokens.cache_creation.long_context",
    ]);
  });

  it("reconciles one snapshot through repeat compaction, mixed sources and genuine late raw usage", async () => {
    const h = harness();
    const first = await recordPiMemoryStage1Usage(h.db, h.args);
    const day = first.accountingAt!.slice(0, 10);
    await h.pool.query(
      "UPDATE usage_event SET status='processed',credits_charged=0,processed_at='2020-01-01' WHERE org_id=$1",
      [h.orgId],
    );
    const original = (
      await h.pool.query(
        "SELECT billing_anchor_at::text AS anchor FROM usage_event WHERE org_id=$1 LIMIT 1",
        [h.orgId],
      )
    ).rows[0].anchor;
    await h.pool.query(
      "INSERT INTO usage_event(idempotency_key,org_id,user_id,kind,provider,category,quantity,status,credits_charged,processed_at,created_at,billing_context) VALUES(gen_random_uuid(),$1,$2,'model','gpt-5.6-luna','tokens.input',5,'processed',0,'2020-01-01',$3,'runless')",
      [h.orgId, h.userId, original],
    );
    const reader = await h.pool.connect();
    const outcome = await settleIncludingAbort(
      (async () => {
        await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const before = (
          await reader.query(ledgerSql, [day, h.orgId, h.userId, {}])
        ).rows[0].report;
        await h.store.set(compactUsageEvents$, h.orgId, context.signal);
        expect(
          (await reader.query(ledgerSql, [day, h.orgId, h.userId, {}])).rows[0]
            .report,
        ).toStrictEqual(before);
        await reader.query("COMMIT");
      })(),
    );
    await reader.query("ROLLBACK");
    reader.release();
    if (!outcome.ok) {
      throw outcome.error;
    }
    expect(
      (
        await h.pool.query(
          "SELECT billing_context, sum(quantity)::text AS q FROM usage_event_hourly_rollup WHERE org_id=$1 GROUP BY billing_context ORDER BY billing_context",
          [h.orgId],
        )
      ).rows,
    ).toStrictEqual([
      { billing_context: "pi_memory_stage1", q: "23" },
      { billing_context: "runless", q: "5" },
    ]);
    await h.store.set(compactUsageEvents$, h.orgId, context.signal);
    await h.pool.query(
      "INSERT INTO usage_event(idempotency_key,org_id,user_id,kind,provider,category,quantity,status,credits_charged,processed_at,created_at,billing_context) VALUES(gen_random_uuid(),$1,$2,'model','gpt-5.6-luna','tokens.input',7,'processed',0,'2020-01-01',$3,'pi_memory_stage1')",
      [h.orgId, h.userId, original],
    );
    const late = (await h.pool.query(ledgerSql, [day, h.orgId, h.userId, {}]))
      .rows[0].report;
    expect(late.stage1_finalized_rows).toBe("5");
    expect(late.untagged_runless_rows_in_day).toBe("1");
    await h.store.set(compactUsageEvents$, h.orgId, context.signal);
    expect(
      (
        await h.pool.query(
          "SELECT sum(quantity)::text AS q FROM usage_event_hourly_rollup WHERE org_id=$1 AND billing_context='pi_memory_stage1'",
          [h.orgId],
        )
      ).rows[0].q,
    ).toBe("30");
    const after = (await h.pool.query(ledgerSql, [day, h.orgId, h.userId, {}]))
      .rows[0].report;
    expect(after.known_stage1_gross_usd).toBe(late.known_stage1_gross_usd);
    expect(after.stage1_finalized_rows).toBe("4");
  });
});
