import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import postgres from "postgres";
import { orgPlanEntitlements } from "../src/runtime/org-plan-entitlement";
import { applyPendingMigrations } from "./migration-runner";

// Catalog drift and DDL/journal rollback cannot be constructed through an API.
// Each scenario owns a database at the actual pre-contraction journal frontier.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const migrations = fileURLToPath(new URL("../src/migrations", import.meta.url));
const journal = JSON.parse(
  await readFile(join(migrations, "meta/_journal.json"), "utf8"),
) as { entries: { idx: number; tag: string; when: number }[] };
const entry = journal.entries.find((candidate) => {
  return candidate.tag === "1136_retire_legacy_invitation_columns";
});
assert.ok(entry);
const retirement = entry;
const fixture = await mkdtemp(join(tmpdir(), "invitation-column-retirement-"));
const fixtureMigrations = join(fixture, "src/migrations");
const originalDirectory = process.cwd();
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
const template = `invitation_template_${randomUUID().replaceAll("-", "")}`;

function urlFor(database: string) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function writeFrontier(includeRetirement: boolean) {
  const entries = journal.entries.filter((candidate) => {
    return (
      candidate.idx < retirement.idx ||
      (includeRetirement && candidate.idx === retirement.idx)
    );
  });
  await mkdir(join(fixtureMigrations, "meta"), { recursive: true });
  for (const candidate of entries) {
    await copyFile(
      join(migrations, `${candidate.tag}.sql`),
      join(fixtureMigrations, `${candidate.tag}.sql`),
    );
  }
  await writeFile(
    join(fixtureMigrations, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
}

async function apply(url: string) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  process.chdir(fixture);
  try {
    await applyPendingMigrations(sql);
  } finally {
    process.chdir(originalDirectory);
    await sql.end();
  }
}

async function state(client: Client) {
  return (
    await client.query(`SELECT jsonb_build_object(
    'rows', (SELECT jsonb_agg(to_jsonb(e) ORDER BY org_id) FROM org_plan_entitlements e),
    'columns', (SELECT jsonb_agg(to_jsonb(a) ORDER BY attnum) FROM pg_attribute a
      WHERE attrelid = 'org_plan_entitlements'::regclass AND attnum > 0),
    'dependencies', (SELECT jsonb_agg(to_jsonb(d) ORDER BY classid, objid, objsubid) FROM pg_depend d
      WHERE refclassid = 'pg_class'::regclass AND refobjid = 'org_plan_entitlements'::regclass),
    'journal', (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM drizzle.__drizzle_migrations j)
  ) AS state`)
  ).rows;
}

async function canonicalState(client: Client) {
  return (
    await client.query(`SELECT jsonb_build_object(
    'rows', (SELECT jsonb_agg(to_jsonb(e) - 'member_invite_usage_pack_required'
      - 'member_invitation_allowed' ORDER BY org_id) FROM org_plan_entitlements e),
    'metadata', (SELECT jsonb_agg(to_jsonb(m) ORDER BY org_id) FROM org_metadata m),
    'constraints', (SELECT jsonb_agg(to_jsonb(c) ORDER BY oid) FROM pg_constraint c
      WHERE conrelid = 'org_plan_entitlements'::regclass AND contype <> 'n'),
    'indexes', (SELECT jsonb_agg(to_jsonb(i) ORDER BY indexrelid) FROM pg_index i
      WHERE indrelid = 'org_plan_entitlements'::regclass)
  ) AS state`)
  ).rows;
}

async function scenario(
  name: string,
  run: (client: Client, url: string) => Promise<void>,
) {
  const database = `invitation_case_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
  const url = urlFor(database);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await run(client, url);
    console.log(`PASS ${name}`);
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE "${database}"`);
  }
}

async function reject(name: string, setup: string, pattern: RegExp) {
  await scenario(name, async (client, url) => {
    await client.query(setup);
    const before = await state(client);
    await assert.rejects(apply(url), pattern);
    assert.deepEqual(await state(client), before);
  });
}

try {
  await writeFrontier(false);
  await admin.query(`CREATE DATABASE "${template}" TEMPLATE template0`);
  await apply(urlFor(template));
  const seed = new Client({ connectionString: urlFor(template) });
  await seed.connect();
  try {
    await seed.query(`
      INSERT INTO org_plan_entitlements
        (org_id, plan_key, plan_rank, source, status, restricted_built_in_models,
         show_usage_pack, member_invite_usage_pack_required, member_invitation_allowed,
         source_metadata)
      SELECT 'invitation-' || n, 'free', 0, 'manual',
        CASE WHEN n % 2 = 0 THEN 'active' ELSE 'suspended' END, false,
        n % 3 = 0, n % 3 <> 0, n % 2 <> 0, jsonb_build_object('fixture', n)
      FROM generate_series(1, 12) n;
    `);
    const references = await seed.query(`SELECT count(*)::int AS count
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND p.prokind IN ('f', 'p')
        AND p.prosrc ~* '\\m(member_invite_usage_pack_required|member_invitation_allowed)\\M'`);
    assert.deepEqual(references.rows, [{ count: 0 }]);
  } finally {
    await seed.end();
  }
  await writeFrontier(true);
  await scenario(
    "preserves canonical values, constraints, current writes and journal retry",
    async (client, url) => {
      const before = await canonicalState(client);
      await apply(url);
      assert.deepEqual(await canonicalState(client), before);
      const committed = await client.query(
        "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE created_at = $1",
        [retirement.when],
      );
      assert.deepEqual(committed.rows, [{ count: 1 }]);
      const db = drizzle(client);
      for (const active of [true, false, true]) {
        const [written] = await db
          .insert(orgPlanEntitlements)
          .values({
            orgId: "current-api",
            planKey: "free",
            planRank: 0,
            source: "manual",
            status: active ? "active" : "suspended",
            restrictedBuiltInModels: false,
            showUsagePack: active,
          })
          .onConflictDoUpdate({
            target: orgPlanEntitlements.orgId,
            set: {
              status: active ? "active" : "suspended",
              showUsagePack: active,
            },
          })
          .returning();
        const [read] = await db
          .select()
          .from(orgPlanEntitlements)
          .where(eq(orgPlanEntitlements.orgId, "current-api"));
        assert.equal(read?.status, active ? "active" : "suspended");
        assert.equal(read?.showUsagePack, active);
        assert.deepEqual(read, written);
      }
      const after = await state(client);
      await apply(url);
      assert.deepEqual(await state(client), after);
    },
  );
  await reject(
    "rejects a persisted PL/pgSQL column reference",
    `
    CREATE FUNCTION public.stale_invitation_reader() RETURNS boolean LANGUAGE plpgsql AS $$
    BEGIN RETURN (SELECT member_invitation_allowed FROM org_plan_entitlements LIMIT 1); END;
    $$`,
    /persisted SQL reference/,
  );
  await reject(
    "rejects a persisted reference outside public",
    `
    CREATE SCHEMA historical_api;
    CREATE FUNCTION historical_api.stale_pack_reader() RETURNS boolean LANGUAGE plpgsql AS $$
    BEGIN RETURN (SELECT member_invite_usage_pack_required FROM public.org_plan_entitlements LIMIT 1); END;
    $$`,
    /persisted SQL reference/,
  );
  await reject(
    "preserves an unexpected dependent check",
    `
    ALTER TABLE org_plan_entitlements ADD CONSTRAINT invitation_shape
      CHECK (member_invitation_allowed IS NOT NULL)`,
    /unexpected column dependency/,
  );
  await reject(
    "preserves an unexpected dependent index",
    `
    CREATE INDEX invitation_shape ON org_plan_entitlements (member_invite_usage_pack_required)`,
    /unexpected column dependency/,
  );
  await reject(
    "preserves an unexpected dependent view",
    `
    CREATE VIEW invitation_shape AS SELECT member_invitation_allowed FROM org_plan_entitlements`,
    /unexpected column dependency/,
  );
  await reject(
    "rejects a changed legacy default",
    `
    ALTER TABLE org_plan_entitlements ALTER COLUMN member_invitation_allowed SET DEFAULT true`,
    /unexpected column definitions/,
  );
  await scenario(
    "rejects direct contraction without the predecessor journal",
    async (client) => {
      await client.query(
        "DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= 1789448024786",
      );
      const before = await state(client);
      const migration = await readFile(
        join(migrations, `${retirement.tag}.sql`),
        "utf8",
      );
      await client.query("BEGIN");
      try {
        await assert.rejects(
          client.query(migration),
          /requires migration 1132/,
        );
      } finally {
        await client.query("ROLLBACK");
      }
      assert.deepEqual(await state(client), before);
    },
  );
  await reject(
    "rolls back both drops when the journal insert fails",
    `
    CREATE FUNCTION public.reject_invitation_journal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected journal failure'; END; $$;
    CREATE TRIGGER reject_invitation_journal BEFORE INSERT ON drizzle.__drizzle_migrations
      FOR EACH ROW WHEN (NEW.created_at = ${retirement.when})
      EXECUTE FUNCTION public.reject_invitation_journal()`,
    /injected journal failure/,
  );
  await scenario(
    "honors the default lock timeout and succeeds after lock release",
    async (client, url) => {
      const before = await state(client);
      await client.query("BEGIN");
      try {
        await client.query(
          "LOCK TABLE org_plan_entitlements IN ACCESS EXCLUSIVE MODE",
        );
        await assert.rejects(apply(url), /lock timeout/);
      } finally {
        await client.query("ROLLBACK");
      }
      assert.deepEqual(await state(client), before);
      await apply(url);
    },
  );
} finally {
  process.chdir(originalDirectory);
  await admin.query(`DROP DATABASE IF EXISTS "${template}"`);
  await admin.end();
  await rm(fixture, { recursive: true, force: true });
}
