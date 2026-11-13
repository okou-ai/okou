import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { array, boolean, number, object, record, string } from "zod";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { applyPendingMigrations } from "./migration-runner";

// Exercise the real release migration on an owned disposable local database.
const connection = process.env.DATABASE_URL;
assert.ok(connection, "Disposable local DATABASE_URL required");
assert.ok(
  ["localhost", "127.0.0.1", "postgres"].includes(new URL(connection).hostname),
);
const database = `single_agent_default_${randomUUID().replaceAll("-", "")}`;
const address = new URL(connection);
address.pathname = `/${database}`;
const admin = postgres(connection, { max: 1, onnotice: () => {} });
const sql = postgres(address.toString(), { max: 1, onnotice: () => {} });
const writer = postgres(address.toString(), { max: 1, onnotice: () => {} });
const journal = object({
  entries: array(object({ tag: string(), when: number() })),
}).parse(
  JSON.parse(
    await readFile(
      new URL("../src/migrations/meta/_journal.json", import.meta.url),
      "utf8",
    ),
  ),
);
const migration = journal.entries.find((entry) => {
  return entry.tag === "1552_preserve_initialized_single_agent_members";
});
assert.ok(migration);
const staff = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const external = `org_${randomUUID()}`;
const flagsSchema = array(
  object({
    org_id: string(),
    user_id: string(),
    switches: record(string(), boolean()),
  }),
);

async function flags() {
  return flagsSchema.parse(
    await sql`SELECT org_id,user_id,switches FROM user_feature_switches ORDER BY org_id,user_id`,
  );
}

try {
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  await applyPendingMigrations(sql, { beforeMillis: migration.when });
  await sql`INSERT INTO org_members_metadata(org_id,user_id) VALUES
    (${external},'missing-row'),(${external},'missing-key'),
    (${external},'opted-in'),(${external},'opted-out'),
    (${external},'concurrent-setting'),(${external},'reject-this-row'),
    (${staff},'staff-default'),(${staff},'staff-opted-out')`;
  await sql`INSERT INTO user_feature_switches(org_id,user_id,switches) VALUES
    (${external},'missing-key','{"_dummy":false,"unrelated":true}'),
    (${external},'opted-in','{"singleAgent":true,"_dummy":false}'),
    (${external},'opted-out','{"singleAgent":false,"_dummy":true}'),
    (${staff},'staff-opted-out','{"singleAgent":false,"_dummy":true}'),
    (${external},'__org__','{"_larkIntegration":true}'),
    (${external},'not-initialized','{"singleAgent":false,"_dummy":false}')`;
  await sql`INSERT INTO user_cache(user_id,email) VALUES('cache-only','cache@example.test')`;
  const before = await flags();
  const membersBefore = Array.from(
    await sql`SELECT * FROM org_members_metadata ORDER BY org_id,user_id`,
  );
  const journalBefore = Array.from(
    await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
  );

  // A rejected target must leave neither partial overrides nor a journal entry.
  await sql`ALTER TABLE user_feature_switches ADD CONSTRAINT reject_rollout_fixture
    CHECK(user_id <> 'reject-this-row')`;
  await assert.rejects(applyPendingMigrations(sql), /reject_rollout_fixture/u);
  assert.deepEqual(await flags(), before);
  assert.deepEqual(
    Array.from(
      await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
    ),
    journalBefore,
  );
  await sql`ALTER TABLE user_feature_switches DROP CONSTRAINT reject_rollout_fixture`;

  // A real competing settings writer wins whether it commits before or after backfill.
  await Promise.all([
    applyPendingMigrations(sql),
    writer`INSERT INTO user_feature_switches(org_id,user_id,switches)
      VALUES(${external},'concurrent-setting','{"singleAgent":true,"_dummy":false}')
      ON CONFLICT(org_id,user_id) DO UPDATE
      SET switches=user_feature_switches.switches || EXCLUDED.switches`,
  ]);
  const migrated = await flags();
  const value = (orgId: string, userId: string) => {
    const row = migrated.find((entry) => {
      return entry.org_id === orgId && entry.user_id === userId;
    });
    assert.ok(row);
    return row.switches;
  };
  assert.deepEqual(value(external, "missing-row"), { singleAgent: false });
  assert.deepEqual(value(external, "missing-key"), {
    singleAgent: false,
    _dummy: false,
    unrelated: true,
  });
  assert.deepEqual(value(external, "opted-in"), {
    singleAgent: true,
    _dummy: false,
  });
  assert.deepEqual(value(external, "opted-out"), {
    singleAgent: false,
    _dummy: true,
  });
  assert.deepEqual(value(external, "concurrent-setting"), {
    singleAgent: true,
    _dummy: false,
  });
  assert.deepEqual(value(staff, "staff-default"), { singleAgent: true });
  assert.deepEqual(value(staff, "staff-opted-out"), {
    singleAgent: false,
    _dummy: true,
  });
  assert.deepEqual(value(external, "not-initialized"), { _dummy: false });
  assert.deepEqual(value(external, "__org__"), { _larkIntegration: true });
  assert.equal(
    migrated.some((entry) => {
      return entry.user_id === "cache-only";
    }),
    false,
  );
  assert.deepEqual(
    Array.from(
      await sql`SELECT * FROM org_members_metadata ORDER BY org_id,user_id`,
    ),
    membersBefore,
  );

  // The same account in a freshly initialized workspace is outside the retained cohort.
  const nextOrg = `org_${randomUUID()}`;
  await sql`INSERT INTO org_members_metadata(org_id,user_id) VALUES(${nextOrg},'missing-row')`;
  assert.equal(
    isFeatureEnabled(FeatureSwitchKey.SingleAgent, {
      orgId: external,
      userId: "missing-row",
      overrides: value(external, "missing-row"),
    }),
    false,
  );
  assert.equal(
    isFeatureEnabled(FeatureSwitchKey.SingleAgent, {
      orgId: nextOrg,
      userId: "missing-row",
    }),
    true,
  );

  // Release retry skips the committed cohort and preserves a later user selection.
  await sql`UPDATE user_feature_switches
    SET switches=switches || '{"singleAgent":true}'::jsonb
    WHERE org_id=${external} AND user_id='missing-row'`;
  const retryBefore = await flags();
  await applyPendingMigrations(sql);
  assert.deepEqual(await flags(), retryBefore);
  console.log(
    "Single Agent cohort, overrides, staff, concurrent settings, rollback and release retry passed",
  );
} finally {
  await writer.end();
  await sql.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
}
