import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { usagePackOverdraftTransferSql } from "../src/operations/usage-pack-overdraft-transfer";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `pack_transfer_${randomUUID().replaceAll("-", "")}`;
try {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0432; new non-billing transactions are prohibited.
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE org_metadata (org_id text PRIMARY KEY, credits bigint NOT NULL, updated_at timestamp);
    CREATE TABLE credit_expires_record (id uuid PRIMARY KEY, org_id text NOT NULL, remaining bigint NOT NULL, expires_at timestamp NOT NULL);
    CREATE TABLE usage_pack_credit_grants (
      id uuid PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL,
      grant_type text NOT NULL, original_amount bigint NOT NULL,
      remaining_amount bigint NOT NULL, expires_at timestamp NOT NULL,
      idempotency_key text NOT NULL
    );
    INSERT INTO org_metadata (org_id, credits) VALUES ('positive', 20), ('negative', -5), ('unchanged', 50);
    INSERT INTO usage_pack_credit_grants VALUES
      ('00000000-0000-4000-a000-000000000001', 'positive', 'alice', 'purchased', 10, -3, '2099-01-01', 'paid-source'),
      ('00000000-0000-4000-a000-000000000002', 'positive', 'bob', 'bonus', 10, -4, '2020-01-01', 'expired-source'),
      ('00000000-0000-4000-a000-000000000003', 'negative', 'charlie', 'bonus', 10, -6, '2099-01-01', 'bonus-source'),
      ('00000000-0000-4000-a000-000000000004', 'unchanged', 'alice', 'purchased', 10, 8, '2099-01-01', 'positive-source');
  `);
  const migration = await readFile(
    new URL(
      "../src/migrations/1346_usage_pack_overdraft_transfers.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await client.query(migration);
  assert.deepEqual(
    (
      await client.query(
        "SELECT org_id, credits::text FROM org_metadata ORDER BY org_id",
      )
    ).rows,
    [
      { org_id: "negative", credits: "-11" },
      { org_id: "positive", credits: "13" },
      { org_id: "unchanged", credits: "50" },
    ],
  );
  const grants = (
    await client.query(
      "SELECT idempotency_key, grant_type, original_amount::text, remaining_amount::text FROM usage_pack_credit_grants ORDER BY id",
    )
  ).rows;
  assert.deepEqual(grants, [
    {
      idempotency_key: "paid-source",
      grant_type: "purchased",
      original_amount: "10",
      remaining_amount: "0",
    },
    {
      idempotency_key: "expired-source",
      grant_type: "bonus",
      original_amount: "10",
      remaining_amount: "0",
    },
    {
      idempotency_key: "bonus-source",
      grant_type: "bonus",
      original_amount: "10",
      remaining_amount: "0",
    },
    {
      idempotency_key: "positive-source",
      grant_type: "purchased",
      original_amount: "10",
      remaining_amount: "8",
    },
  ]);
  assert.equal(
    (
      await client.query(
        "SELECT sum(amount)::text AS amount FROM usage_pack_overdraft_transfers",
      )
    ).rows[0]?.amount,
    "13",
  );
  // The repair portion is restart-safe: after zeroing there is nothing to move.
  const repair = migration.slice(migration.indexOf("DO $$"));
  await client.query(repair);
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::text AS count FROM usage_pack_overdraft_transfers",
      )
    ).rows[0]?.count,
    "3",
  );
  assert.equal(
    (await client.query("SELECT sum(credits)::text AS total FROM org_metadata"))
      .rows[0]?.total,
    "52",
  );
  await client.query(`
    INSERT INTO org_metadata (org_id, credits) VALUES ('expired_wallet', 10);
    INSERT INTO credit_expires_record VALUES ('00000000-0000-4000-a000-000000000010', 'expired_wallet', 20, '2020-01-01');
    INSERT INTO usage_pack_credit_grants VALUES ('00000000-0000-4000-a000-000000000005', 'expired_wallet', 'dana', 'bonus', 10, -2, '2020-01-01', 'expired-wallet-source');
  `);
  await client.query(repair);
  assert.equal(
    (
      await client.query(
        "SELECT credits::text FROM org_metadata WHERE org_id = 'expired_wallet'",
      )
    ).rows[0]?.credits,
    "-2",
  );
  assert.equal(
    (
      await client.query(
        "SELECT remaining::text FROM credit_expires_record WHERE org_id = 'expired_wallet'",
      )
    ).rows[0]?.remaining,
    "0",
  );
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0433; new non-billing transactions are prohibited.
  await client.query("SAVEPOINT missing_wallet");
  await client.query(
    `INSERT INTO usage_pack_credit_grants VALUES ('00000000-0000-4000-a000-000000000006', 'missing_wallet', 'eve', 'bonus', 10, -3, '2099-01-01', 'missing-source')`,
  );
  await assert.rejects(client.query(repair), /no organization wallet/);
  await client.query("ROLLBACK TO SAVEPOINT missing_wallet");

  // Exercise the current repair statement against retained outgoing-writer data.
  const runtimeRepair = (orgId: string, userId?: string) => {
    const query = new PgDialect().sqlToQuery(
      usagePackOverdraftTransferSql(
        { orgId, userId },
        new Date("2026-10-08T00:00:00Z"),
      ),
    );
    return client.query(query.sql, query.params);
  };
  await client.query(`
    INSERT INTO org_metadata (org_id, credits) VALUES ('runtime_expired', 10);
    INSERT INTO credit_expires_record VALUES ('00000000-0000-4000-a000-000000000011', 'runtime_expired', 20, '2020-01-01');
    INSERT INTO usage_pack_credit_grants VALUES
      ('00000000-0000-4000-a000-000000000007', 'positive', 'alice', 'bonus', 10, -2, '2099-01-01', 'runtime-alice'),
      ('00000000-0000-4000-a000-000000000008', 'positive', 'bob', 'bonus', 10, -3, '2020-01-01', 'runtime-bob'),
      ('00000000-0000-4000-a000-000000000009', 'runtime_expired', 'dana', 'bonus', 10, -3, '2020-01-01', 'runtime-expired');
  `);
  assert.deepEqual((await runtimeRepair("positive", "alice")).rows, [
    { has_wallet: true, negative_grants: "1", amount: "2" },
  ]);
  assert.equal(
    (
      await client.query(
        "SELECT credits::text FROM org_metadata WHERE org_id = 'positive'",
      )
    ).rows[0]?.credits,
    "11",
  );
  assert.equal(
    (
      await client.query(
        "SELECT remaining_amount::text FROM usage_pack_credit_grants WHERE idempotency_key = 'runtime-bob'",
      )
    ).rows[0]?.remaining_amount,
    "-3",
  );
  assert.deepEqual((await runtimeRepair("positive", "alice")).rows, [
    { has_wallet: true, negative_grants: "0", amount: "0" },
  ]);
  assert.deepEqual((await runtimeRepair("positive")).rows, [
    { has_wallet: true, negative_grants: "1", amount: "3" },
  ]);
  assert.equal(
    (
      await client.query(
        "SELECT credits::text FROM org_metadata WHERE org_id = 'positive'",
      )
    ).rows[0]?.credits,
    "8",
  );
  assert.deepEqual((await runtimeRepair("runtime_expired")).rows, [
    { has_wallet: true, negative_grants: "1", amount: "3" },
  ]);
  assert.equal(
    (
      await client.query(
        "SELECT credits::text FROM org_metadata WHERE org_id = 'runtime_expired'",
      )
    ).rows[0]?.credits,
    "-3",
  );
  assert.equal(
    (
      await client.query(
        "SELECT remaining::text FROM credit_expires_record WHERE org_id = 'runtime_expired'",
      )
    ).rows[0]?.remaining,
    "0",
  );
  assert.deepEqual((await runtimeRepair("no_wallet")).rows, [
    { has_wallet: false, negative_grants: "0", amount: "0" },
  ]);
  await client.query(
    `INSERT INTO usage_pack_credit_grants VALUES ('00000000-0000-4000-a000-000000000012', 'no_wallet', 'eve', 'bonus', 10, -3, '2099-01-01', 'runtime-orphan')`,
  );
  assert.deepEqual((await runtimeRepair("no_wallet")).rows, [
    { has_wallet: false, negative_grants: "1", amount: "0" },
  ]);
  assert.equal(
    (
      await client.query(
        "SELECT remaining_amount::text FROM usage_pack_credit_grants WHERE idempotency_key = 'runtime-orphan'",
      )
    ).rows[0]?.remaining_amount,
    "-3",
  );
  await client.query("DELETE FROM usage_pack_credit_grants");
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::text AS count FROM usage_pack_overdraft_transfers",
      )
    ).rows[0]?.count,
    "7",
  );
  console.log(
    "Legacy and current package overdraft transfer: conservation, expired debt, member scope, missing wallet, replay and retained audit passed",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
