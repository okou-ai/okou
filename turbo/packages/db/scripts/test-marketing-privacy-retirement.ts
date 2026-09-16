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
import { Client } from "pg";
import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

// Historical rows, DDL dependencies and migration-journal failures cannot be
// constructed through current APIs. Every scenario owns a PostgreSQL database.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const source = fileURLToPath(new URL("../src/migrations", import.meta.url));
const journal = JSON.parse(
  await readFile(join(source, "meta/_journal.json"), "utf8"),
) as {
  entries: { idx: number; tag: string; when: number }[];
};
const targets = journal.entries.filter((entry) => {
  return entry.tag.endsWith("_retire_marketing_privacy_storage");
});
assert.equal(targets.length, 1);
const target = targets[0];
assert.ok(target);
const retirement = target;
const fixture = await mkdtemp(join(tmpdir(), "privacy-retirement-"));
const migrations = join(fixture, "src/migrations");
const originalDirectory = process.cwd();
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
const template = `privacy_template_${randomUUID().replaceAll("-", "")}`;
const tables = [
  "privacy_choices",
  "privacy_choice_revisions",
  "marketing_privacy_receipts",
];
let passed = 0;

function urlFor(name: string) {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function frontier(includeRetirement: boolean) {
  const entries = journal.entries.filter((entry) => {
    return (
      entry.idx < retirement.idx ||
      (includeRetirement && entry.idx === retirement.idx)
    );
  });
  await mkdir(join(migrations, "meta"), { recursive: true });
  for (const entry of entries) {
    await copyFile(
      join(source, `${entry.tag}.sql`),
      join(migrations, `${entry.tag}.sql`),
    );
  }
  await writeFile(
    join(migrations, "meta/_journal.json"),
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

async function retainedState(client: Client) {
  const rows = [];
  for (const table of tables) {
    rows.push(
      (
        await client.query(
          `SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows,
    );
  }
  return {
    rows,
    catalog: (
      await client.query(`SELECT jsonb_build_object(
      'relations', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) FROM pg_class c WHERE relnamespace = 'public'::regnamespace),
      'triggers', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace),
      'functions', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p WHERE pronamespace = 'public'::regnamespace),
      'journal', (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM drizzle.__drizzle_migrations j)
    ) AS state`)
    ).rows,
  };
}

async function unrelatedState(client: Client) {
  return (
    await client.query(`SELECT jsonb_build_object(
    'tables', (SELECT jsonb_agg(c.relname ORDER BY c.relname) FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
        AND c.relname NOT IN ('privacy_choices', 'privacy_choice_revisions', 'marketing_privacy_receipts')),
    'constraints', (SELECT jsonb_agg(to_jsonb(k) ORDER BY k.oid) FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = 'public'::regnamespace
        AND c.relname NOT IN ('privacy_choices', 'privacy_choice_revisions', 'marketing_privacy_receipts')),
    'indexes', (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.indexrelid) FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'public'::regnamespace
        AND c.relname NOT IN ('privacy_choices', 'privacy_choice_revisions', 'marketing_privacy_receipts')),
    'triggers', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace
        AND c.relname NOT IN ('privacy_choices', 'privacy_choice_revisions', 'marketing_privacy_receipts')),
    'functions', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'invalidate_marketing_privacy_epochs'),
    'data', (SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM privacy_retirement_unrelated u)
  ) AS state`)
  ).rows;
}

async function assertRetired(client: Client) {
  assert.deepEqual(
    (
      await client.query(`SELECT
    to_regclass('public.privacy_choices') IS NULL AS choices,
    to_regclass('public.privacy_choice_revisions') IS NULL AS revisions,
    to_regclass('public.marketing_privacy_receipts') IS NULL AS receipts,
    NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'marketing_privacy_withdrawal') AS trigger,
    to_regprocedure('public.invalidate_marketing_privacy_epochs()') IS NULL AS function`)
    ).rows,
    [
      {
        choices: true,
        revisions: true,
        receipts: true,
        trigger: true,
        function: true,
      },
    ],
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE created_at = $1",
        [retirement.when],
      )
    ).rows[0]?.n,
    1,
  );
}

async function scenario(
  name: string,
  run: (client: Client, url: string) => Promise<void>,
) {
  const nameInDb = `privacy_case_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${nameInDb}" TEMPLATE "${template}"`);
  const url = urlFor(nameInDb);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await run(client, url);
    passed += 1;
    console.log(`PASS ${name}`);
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE "${nameInDb}"`);
  }
}

async function rejectDependency(name: string, setup: string, cleanup: string) {
  await scenario(name, async (client, url) => {
    await client.query(setup);
    const before = await retainedState(client);
    await assert.rejects(apply(url), { code: "2BP01" });
    assert.deepEqual(await retainedState(client), before);
    await client.query(cleanup);
    await apply(url);
    await assertRetired(client);
  });
}

try {
  await frontier(false);
  await admin.query(`CREATE DATABASE "${template}" TEMPLATE template0`);
  await apply(urlFor(template));
  const seed = new Client({ connectionString: urlFor(template) });
  await seed.connect();
  try {
    await seed.query(`
      CREATE TABLE privacy_retirement_unrelated (id integer PRIMARY KEY, payload jsonb NOT NULL);
      INSERT INTO privacy_retirement_unrelated VALUES (1, '{"preserved":true}');
      INSERT INTO privacy_choices (user_id, token_hash, linked_user_id, policy_version,
        source, sale_sharing, advertising, marketing_analytics)
      VALUES ('retired-person', NULL, NULL, 'retired-policy', 'explicit', 'granted', 'granted', 'granted'),
        (NULL, 'retired-linked-browser-hash', 'retired-person', 'retired-policy', 'gpc', 'denied', 'denied', 'denied'),
        (NULL, 'retired-anonymous-browser-hash', NULL, 'older-policy', 'explicit', 'unknown', 'unknown', 'unknown');
      INSERT INTO privacy_choice_revisions (revision, subject_id, sale_sharing,
        advertising, marketing_analytics, source, policy_version, recorded_at)
      SELECT revision, id, sale_sharing, advertising, marketing_analytics, source,
        policy_version, created_at FROM privacy_choices;
      INSERT INTO marketing_privacy_receipts (subject_id, privacy_revision,
        advertising_epoch, marketing_analytics_epoch, policy_version, captured_at)
      SELECT id, revision, advertising_epoch, marketing_analytics_epoch, policy_version, created_at FROM privacy_choices;
    `);
  } finally {
    await seed.end();
  }
  await frontier(true);

  await scenario(
    "retire populated personal, linked and anonymous evidence; preserve unrelated state; retry",
    async (client, url) => {
      const before = await unrelatedState(client);
      await apply(url);
      await assertRetired(client);
      assert.deepEqual(await unrelatedState(client), before);
      await apply(url);
      await assertRetired(client);
      // The preparation gate is real: the outgoing unconditional statement is
      // invalid after contraction, even when it would delete zero rows.
      await assert.rejects(
        client.query(
          "DELETE FROM privacy_choices WHERE user_id = $1 OR linked_user_id = $1",
          ["already-deleted"],
        ),
        { code: "42P01" },
      );
    },
  );

  await scenario("retire empty storage", async (client, url) => {
    await client.query("DELETE FROM privacy_choices");
    await apply(url);
    await assertRetired(client);
  });

  await rejectDependency(
    "reject an external foreign key atomically",
    "CREATE TABLE external_privacy_reference (id uuid REFERENCES privacy_choices(id))",
    "DROP TABLE external_privacy_reference",
  );
  await rejectDependency(
    "reject an external view atomically",
    "CREATE VIEW external_privacy_view AS SELECT * FROM marketing_privacy_receipts",
    "DROP VIEW external_privacy_view",
  );
  await rejectDependency(
    "restore all dropped tables when another trigger needs the function",
    `CREATE TRIGGER external_privacy_trigger BEFORE UPDATE ON privacy_retirement_unrelated
      FOR EACH ROW EXECUTE FUNCTION invalidate_marketing_privacy_epochs()`,
    "DROP TRIGGER external_privacy_trigger ON privacy_retirement_unrelated",
  );

  for (const lock of [
    "SELECT pg_advisory_xact_lock_shared(hashtext('marketing_privacy_storage_retirement'))",
    "LOCK TABLE privacy_choices IN ROW EXCLUSIVE MODE",
  ]) {
    await scenario(
      `default lock timeout preserves data and allows retry: ${lock}`,
      async (client, url) => {
        const before = await retainedState(client);
        const blocker = new Client({ connectionString: url });
        await blocker.connect();
        try {
          await blocker.query("BEGIN");
          await blocker.query(lock);
          await assert.rejects(apply(url), { code: "55P03" });
          assert.deepEqual(await retainedState(client), before);
        } finally {
          await blocker.query("ROLLBACK");
          await blocker.end();
        }
        await apply(url);
        await assertRetired(client);
      },
    );
  }

  await scenario(
    "journal failure restores all rows, tables and trigger/function",
    async (client, url) => {
      await client.query(`CREATE FUNCTION fail_privacy_journal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.created_at = ${retirement.when} THEN RAISE EXCEPTION 'privacy journal failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_privacy_journal BEFORE INSERT ON drizzle.__drizzle_migrations
      FOR EACH ROW EXECUTE FUNCTION fail_privacy_journal()`);
      const before = await retainedState(client);
      await assert.rejects(apply(url), /privacy journal failure/);
      assert.deepEqual(await retainedState(client), before);
      await client.query(
        "DROP TRIGGER fail_privacy_journal ON drizzle.__drizzle_migrations; DROP FUNCTION fail_privacy_journal()",
      );
      await apply(url);
      await assertRetired(client);
    },
  );
  console.log(`Marketing privacy retirement: ${passed} scenarios passed`);
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${template}"`);
  await admin.end();
  await rm(fixture, { recursive: true, force: true });
}
