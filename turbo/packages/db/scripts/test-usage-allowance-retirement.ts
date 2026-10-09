import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";

import { applyPendingMigrations } from "./migration-runner";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const journal = z
  .object({
    entries: z.array(z.object({ tag: z.string(), when: z.number() })),
  })
  .parse(
    JSON.parse(
      await readFile(
        new URL("../src/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ),
  );
const targetEntry = journal.entries.find((entry) => {
  return entry.tag === "1356_drop_organization_usage_allowance";
});
assert.ok(targetEntry, "Allowance contraction must be present in the journal");
const target = targetEntry;
const admin = new Client({ connectionString: databaseUrl });
await admin.connect();
const databaseName = `allowance_retirement_${randomUUID().replaceAll("-", "")}`;
const ownedUrl = new URL(databaseUrl);
ownedUrl.pathname = `/${databaseName}`;
await admin.query(`CREATE DATABASE "${databaseName}"`);
const sql = postgres(ownedUrl.toString(), { max: 1 });
const client = new Client({ connectionString: ownedUrl.toString() });
const blocker = new Client({ connectionString: ownedUrl.toString() });
const retiredTables = [
  "org_usage_allowance_entitlements",
  "org_usage_allowance_windows",
  "usage_allowance_allocations",
];

async function retainedState() {
  return (
    await client.query(`
      SELECT * FROM (
        SELECT 'raw' AS kind, to_jsonb(u) AS fact FROM usage_event u
        UNION ALL
        SELECT 'hourly', to_jsonb(h) - ARRAY['allowance_units','short_window_id','weekly_window_id']
          FROM usage_event_hourly_rollup h
        UNION ALL
        SELECT 'wallet', to_jsonb(o) FROM org_metadata o
      ) facts ORDER BY kind, fact::text
    `)
  ).rows;
}

async function assertUncontracted() {
  for (const table of retiredTables) {
    const result = await client.query(
      `SELECT count(*)::int AS count FROM "${table}"`,
    );
    assert.ok(result.rows[0].count > 0, `${table} must survive rollback`);
  }
  assert.equal(
    (
      await client.query(
        "SELECT allowance_units FROM usage_event_hourly_rollup WHERE allowance_units > 0",
      )
    ).rowCount,
    1,
  );
  assert.equal(
    (
      await client.query(
        "SELECT id FROM drizzle.__drizzle_migrations WHERE created_at = $1",
        [target.when],
      )
    ).rowCount,
    0,
  );
}

try {
  await applyPendingMigrations(sql, { beforeMillis: target.when });
  await client.connect();
  await blocker.connect();
  await client.query(`
    INSERT INTO org_metadata(org_id,credits,tier) VALUES ('org_team',321,'custom'),('org_external',456,'limited-free-1');
    INSERT INTO org_usage_allowance_entitlements(id,org_id,short_window_seconds,short_window_units,weekly_window_units)
      VALUES ('00000000-0000-4000-8000-000000000001','org_team',3600,100,1000);
    INSERT INTO org_usage_allowance_windows(id,org_id,entitlement_id,kind,starts_at,expires_at,unit_limit,consumed_units)
      VALUES ('00000000-0000-4000-8000-000000000002','org_team','00000000-0000-4000-8000-000000000001','short','2026-08-01','2026-08-02',100,50),
        ('00000000-0000-4000-8000-000000000003','org_team','00000000-0000-4000-8000-000000000001','weekly','2026-08-01','2026-08-08',1000,50);
    INSERT INTO usage_event(id,idempotency_key,org_id,user_id,kind,provider,category,quantity,credits_charged,status,processed_at)
      VALUES ('00000000-0000-4000-8000-000000000004',gen_random_uuid(),'org_team','user_team','model','retained-model','tokens.input',123,7,'processed','2026-08-01'),
        ('00000000-0000-4000-8000-000000000005',gen_random_uuid(),'org_external','user_external','model','retained-model','tokens.input',456,19,'processed','2026-08-01');
    INSERT INTO usage_allowance_allocations(usage_event_id,org_id,short_window_id,weekly_window_id,units_applied)
      VALUES ('00000000-0000-4000-8000-000000000004','org_team','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003',50);
    INSERT INTO usage_event_hourly_rollup(processed_hour,org_id,user_id,kind,provider,category,quantity,credits_charged,allowance_units,short_window_id,weekly_window_id)
      VALUES ('2026-08-01','org_team','user_team','model','retained-model','tokens.input',100,3,50,'00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003'),
        ('2026-08-01','org_external','user_external','model','retained-model','tokens.input',200,11,0,NULL,NULL);
  `);
  const before = await retainedState();
  const apply = async () => {
    await applyPendingMigrations(sql, { beforeMillis: target.when + 1 });
  };

  await blocker.query(
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0433; new non-billing transactions are prohibited.
    "BEGIN; LOCK TABLE usage_event_hourly_rollup IN ACCESS SHARE MODE",
  );
  await assert.rejects(apply(), { code: "55P03" });
  await blocker.query("ROLLBACK");
  await assertUncontracted();
  assert.deepEqual(await retainedState(), before);

  // The production runner must roll back all DDL if its journal receipt fails.
  await client.query(`
    CREATE FUNCTION reject_allowance_journal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.created_at = ${target.when} THEN
        RAISE EXCEPTION 'owned test journal rejection';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER reject_allowance_journal BEFORE INSERT ON drizzle.__drizzle_migrations
      FOR EACH ROW EXECUTE FUNCTION reject_allowance_journal();
  `);
  await assert.rejects(apply(), { code: "P0001" });
  await assertUncontracted();
  assert.deepEqual(await retainedState(), before);
  await client.query(
    "DROP TRIGGER reject_allowance_journal ON drizzle.__drizzle_migrations; DROP FUNCTION reject_allowance_journal()",
  );

  await apply();
  assert.deepEqual(
    await retainedState(),
    before,
    "ordinary usage and wallets must not be repriced or deleted",
  );
  for (const table of retiredTables) {
    assert.deepEqual(
      (
        await client.query("SELECT to_regclass($1) AS retired", [
          `public.${table}`,
        ])
      ).rows,
      [{ retired: null }],
    );
  }
  assert.equal(
    (
      await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='usage_event_hourly_rollup'
        AND column_name IN ('allowance_units','short_window_id','weekly_window_id')`)
    ).rowCount,
    0,
  );
  await client.query(`INSERT INTO usage_event_hourly_rollup(processed_hour,org_id,user_id,kind,provider,category,quantity,credits_charged)
    VALUES ('2026-08-02','org_external','user_external','model','retained-model','tokens.input',1,2)`);
  await apply();
  assert.equal(
    (
      await client.query(
        "SELECT id FROM drizzle.__drizzle_migrations WHERE created_at=$1",
        [target.when],
      )
    ).rowCount,
    1,
    "a completed retry must not replay the destructive migration",
  );
  console.log(
    "Allowance history dropped; ordinary usage/wallets unchanged; lock and journal failures roll back; credit-only writes and retry pass",
  );
} finally {
  await blocker.end();
  await client.end();
  await sql.end();
  await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin.end();
}
