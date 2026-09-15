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

// DDL, catalog corruption and journal failures are infrastructure boundaries.
// Each case owns a database at the actual pre-1132 migration frontier.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const migrations = fileURLToPath(new URL("../src/migrations", import.meta.url));
const originalDirectory = process.cwd();
const fixture = await mkdtemp(join(tmpdir(), "prepared-domain-retirement-"));
const fixtureMigrations = join(fixture, "src/migrations");
const tag = "1132_retire_prepared_domain_triggers";
const journal = JSON.parse(
  await readFile(join(migrations, "meta/_journal.json"), "utf8"),
) as {
  entries: { idx: number; tag: string; when: number }[];
};
const retirement = journal.entries.find((entry) => {
  return entry.tag === tag;
});
assert.ok(retirement);
const frontier = retirement;
const template = `domain_template_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();

function urlFor(database: string) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}
async function writeFrontier(includeRetirement: boolean) {
  const entries = journal.entries.filter((entry) => {
    return (
      entry.idx < frontier.idx ||
      (includeRetirement && entry.idx === frontier.idx)
    );
  });
  await mkdir(join(fixtureMigrations, "meta"), { recursive: true });
  for (const entry of entries) {
    await copyFile(
      join(migrations, `${entry.tag}.sql`),
      join(fixtureMigrations, `${entry.tag}.sql`),
    );
  }
  await writeFile(
    join(fixtureMigrations, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
}
async function apply(
  url: string,
  options: postgres.Options<Record<string, never>> = {},
) {
  const sql = postgres(url, { max: 1, onnotice: () => {}, ...options });
  process.chdir(fixture);
  try {
    await applyPendingMigrations(sql);
  } finally {
    process.chdir(originalDirectory);
    await sql.end();
  }
}
const tables = [
  "org_metadata",
  "org_plan_entitlements",
  "org_custom_connectors",
  "org_custom_connector_oauth_configs",
  "hosted_sites",
  "hosted_deployments",
  "usage_pack_subscriptions",
  "usage_pack_pending_snapshot_guards",
] as const;
async function data(client: Client) {
  const result = [];
  for (const table of tables) {
    result.push(
      (
        await client.query(
          `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
        )
      ).rows,
    );
  }
  return result;
}
async function catalog(client: Client) {
  return (
    await client.query(`SELECT jsonb_build_object(
    'triggers', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t
      WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)),
    'functions', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p
      WHERE pronamespace = 'public'::regnamespace),
    'journal', (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM drizzle.__drizzle_migrations j)
  ) AS state`)
  ).rows;
}
async function constraints(client: Client) {
  return (
    await client.query(`SELECT jsonb_build_object(
    'constraints', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) FROM pg_constraint c
      WHERE connamespace = 'public'::regnamespace AND contype <> 't'),
    'indexes', (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.indexrelid) FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid WHERE t.relnamespace = 'public'::regnamespace),
    'privacy', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t
      WHERE tgrelid = 'public.privacy_choices'::regclass)
  ) AS state`)
  ).rows;
}
async function scenario(
  name: string,
  run: (client: Client, url: string) => Promise<void>,
) {
  const database = `domain_case_${randomUUID().replaceAll("-", "")}`;
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
async function reject(
  name: string,
  setup: string,
  pattern = /Prepared domain retirement/,
) {
  await scenario(name, async (client, url) => {
    await client.query(setup);
    const before = { data: await data(client), catalog: await catalog(client) };
    await assert.rejects(apply(url), pattern);
    assert.deepEqual(
      { data: await data(client), catalog: await catalog(client) },
      before,
    );
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
      INSERT INTO org_metadata (org_id, tier) VALUES ('domain-org', 'free'), ('domain-manual', 'pro');
      UPDATE org_plan_entitlements SET source = 'manual', can_buy_credits = false WHERE org_id = 'domain-manual';
      INSERT INTO org_custom_connectors (org_id, slug, display_name, auth_mode, created_by, mcp_endpoint, mcp_transport)
      VALUES ('domain-org', '_retirement', 'Retirement fixture', 'none', 'domain-user', 'https://mcp.example.test', 'streamable-http');
      INSERT INTO hosted_sites (org_id, user_id, slug, public_slug, public_brand)
      VALUES ('domain-org', 'domain-user', 'retirement', 'retirement', 'okou');
      INSERT INTO hosted_deployments (site_id, org_id, user_id, status, r2_prefix,
        manifest, manifest_hash, content_hash, file_count, size_bytes, url, public_brand)
      SELECT id, org_id, user_id, 'uploading', 'fixture', '{}'::jsonb,
        repeat('0',64), repeat('0',64), 0, 0, 'https://retirement.invalid', public_brand FROM hosted_sites;
      INSERT INTO usage_pack_subscriptions
        (org_id, tier, stripe_plan_price_id, stripe_customer_id, subscription_status)
      VALUES ('domain-org', 'pro', 'price_fixture', 'cus_fixture', 'checkout_pending');
    `);
  } finally {
    await seed.end();
  }
  await writeFrontier(true);
  await scenario(
    "all eight retired atomically, data/constraints/privacy unchanged, retry idempotent",
    async (client, url) => {
      const before = await data(client);
      const preserved = await constraints(client);
      const notices: string[] = [];
      await apply(url, {
        onnotice: (notice) => {
          if (notice.message !== undefined) {
            notices.push(notice.message);
          }
        },
      });
      assert.deepEqual(await data(client), before);
      assert.deepEqual(await constraints(client), preserved);
      const counts = await client.query(
        `SELECT
      (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN
        (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)) AS triggers,
      (SELECT count(*)::int FROM drizzle.__drizzle_migrations WHERE created_at = $1) AS journal`,
        [frontier.when],
      );
      assert.deepEqual(counts.rows, [{ triggers: 19, journal: 1 }]);
      assert.match(notices.join("\n"), /prepared_domain_trigger_retirement_v1/);
      assert.match(notices.join("\n"), /"pending_guard_mismatches": 0/);
      assert.ok(!notices.join("\n").includes("domain-user"));
      const after = await catalog(client);
      await apply(url);
      assert.deepEqual(await catalog(client), after);
    },
  );
  await scenario(
    "grandfathered pending roots preserve exact count",
    async (client, url) => {
      await client.query(`DELETE FROM usage_pack_pending_snapshot_guards;
      INSERT INTO usage_pack_subscriptions
        (org_id, tier, stripe_plan_price_id, stripe_customer_id, subscription_status)
      VALUES ('domain-org', 'pro', 'price_second', 'cus_second', 'purchase_pending');
      UPDATE usage_pack_pending_snapshot_guards SET pending_snapshot_count = 2`);
      const before = await data(client);
      await apply(url);
      assert.deepEqual(await data(client), before);
    },
  );
  for (const [name, setup] of [
    [
      "missing entitlement",
      "DELETE FROM org_plan_entitlements WHERE org_id = 'domain-org'",
    ],
    [
      "managed credit drift",
      "UPDATE org_plan_entitlements SET can_buy_credits = false WHERE org_id = 'domain-org'",
    ],
    [
      "OAuth pair drift",
      "SET session_replication_role = replica; UPDATE org_custom_connectors SET auth_mode = 'oauth', header_injections = jsonb_build_array(jsonb_build_object('name', 'Authorization', 'valueTemplate', 'Bearer fixture')); SET session_replication_role = origin",
    ],
    [
      "missing requested slug",
      "SET session_replication_role = replica; UPDATE hosted_sites SET requested_slug = NULL; SET session_replication_role = origin",
    ],
    [
      "deployment organization drift",
      "UPDATE hosted_deployments SET org_id = 'wrong-org'",
    ],
    ["missing guard", "DELETE FROM usage_pack_pending_snapshot_guards"],
    [
      "wrong guard count",
      "UPDATE usage_pack_pending_snapshot_guards SET pending_snapshot_count = 2",
    ],
    [
      "disabled trigger",
      "ALTER TABLE hosted_sites DISABLE TRIGGER canonicalize_hosted_site_scope_0753",
    ],
    [
      "missing trigger",
      "DROP TRIGGER sync_usage_pack_pending_snapshot_guard_0954 ON usage_pack_subscriptions",
    ],
    [
      "changed function",
      "CREATE OR REPLACE FUNCTION enforce_hosted_deployment_scope_0753() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$",
    ],
    [
      "function search path drift",
      "ALTER FUNCTION enforce_hosted_deployment_scope_0753() SET search_path = pg_catalog",
    ],
  ]) {
    assert.ok(name && setup);
    await reject(name, setup);
  }
  await reject(
    "dependent trigger prevents partial retirement",
    `CREATE TRIGGER dependent_host_scope
    BEFORE INSERT ON hosted_deployments FOR EACH ROW EXECUTE FUNCTION enforce_hosted_deployment_scope_0753()`,
    /depend/,
  );
  await reject(
    "journal failure restores dropped triggers and all rows",
    `CREATE FUNCTION reject_domain_journal() RETURNS trigger
    LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'domain journal failure'; END$$;
    CREATE TRIGGER reject_domain_journal BEFORE INSERT ON drizzle.__drizzle_migrations
    FOR EACH ROW EXECUTE FUNCTION reject_domain_journal()`,
    /domain journal failure/,
  );
  await scenario(
    "default lock timeout leaves data/catalog/journal untouched",
    async (client, url) => {
      const blocker = new Client({ connectionString: url });
      await blocker.connect();
      try {
        await blocker.query(
          "BEGIN; SELECT * FROM usage_pack_subscriptions FOR UPDATE",
        );
        const before = await catalog(client);
        await assert.rejects(apply(url), /lock timeout/);
        assert.deepEqual(await catalog(client), before);
      } finally {
        await blocker.query("ROLLBACK");
        await blocker.end();
      }
    },
  );
  await scenario(
    "audit sees a writer committed while table locks were waiting",
    async (client, url) => {
      const blocker = new Client({ connectionString: url });
      await blocker.connect();
      const applicationName = `domain_migration_${randomUUID()}`;
      await blocker.query(
        "BEGIN; UPDATE usage_pack_pending_snapshot_guards SET pending_snapshot_count = 2",
      );
      const outcome = apply(url, {
        connection: { application_name: applicationName },
      }).then(
        () => {
          return { ok: true as const };
        },
        (error: unknown) => {
          return { ok: false as const, error };
        },
      );
      try {
        const deadline = performance.now() + 1000;
        let blocked = false;
        while (!blocked && performance.now() < deadline) {
          const state = await client.query<{ blocked: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked`,
            [applicationName],
          );
          blocked = state.rows[0]?.blocked === true;
          if (!blocked)
            await new Promise((resolve) => {
              return setTimeout(resolve, 5);
            });
        }
        assert.ok(
          blocked,
          "Observe the actual migration waiting on the writer",
        );
        const before = await catalog(client);
        await blocker.query("COMMIT");
        const result = await outcome;
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.ok(result.error instanceof Error);
          assert.match(result.error.message, /invariant audit failed/);
        }
        assert.deepEqual(await catalog(client), before);
      } finally {
        await blocker.query("ROLLBACK");
        await blocker.end();
        await outcome;
      }
    },
  );
  await scenario("stale isolation snapshot rejected", async (client, url) => {
    const before = await catalog(client);
    await assert.rejects(
      apply(url, {
        connection: { default_transaction_isolation: "repeatable read" },
      }),
      /requires read committed/,
    );
    assert.deepEqual(await catalog(client), before);
  });
  await scenario(
    "bounded synthetic load retains the default migration timeouts",
    async (client, url) => {
      await client.query(`
      INSERT INTO org_metadata (org_id, tier)
        SELECT 'scale-' || n, 'free' FROM generate_series(1, 10000) n;
      INSERT INTO usage_pack_subscriptions
        (org_id, tier, stripe_plan_price_id, stripe_customer_id, subscription_status)
        SELECT 'scale-' || n, 'pro', 'scale-price', 'scale-customer-' || n, 'checkout_pending'
        FROM generate_series(1, 10000) n;
      INSERT INTO org_custom_connectors (org_id, slug, display_name, auth_mode, created_by, mcp_endpoint, mcp_transport)
        SELECT 'scale-' || n, '_scale', 'Scale fixture', 'none', 'scale-user', 'https://mcp.example.test', 'streamable-http'
        FROM generate_series(1, 10000) n;
      INSERT INTO hosted_sites (org_id, user_id, slug, public_slug, public_brand)
        SELECT 'scale-' || n, 'scale-user', 'scale', 'scale-' || n, 'okou'
        FROM generate_series(1, 10000) n;
      INSERT INTO hosted_deployments (site_id, org_id, user_id, status, r2_prefix,
        manifest, manifest_hash, content_hash, file_count, size_bytes, url, public_brand)
        SELECT id, org_id, user_id, 'uploading', 'scale', '{}'::jsonb,
          repeat('0',64), repeat('0',64), 0, 0, 'https://scale.invalid', public_brand
        FROM hosted_sites CROSS JOIN generate_series(1, 2) n WHERE org_id LIKE 'scale-%';
      ANALYZE org_metadata; ANALYZE org_plan_entitlements;
      ANALYZE usage_pack_subscriptions; ANALYZE usage_pack_pending_snapshot_guards;
      ANALYZE org_custom_connectors; ANALYZE org_custom_connector_oauth_configs;
      ANALYZE hosted_sites; ANALYZE hosted_deployments;
    `);
      const notices: string[] = [];
      const start = performance.now();
      await apply(url, {
        onnotice: (notice) => {
          if (notice.message !== undefined) {
            notices.push(notice.message);
          }
        },
      });
      const receipt = notices.join("\n");
      assert.match(receipt, /"metadata_rows": 10002/);
      assert.match(receipt, /"subscription_rows": 10001/);
      assert.match(receipt, /"deployment_rows": 20001/);
      assert.match(receipt, /"pending_guard_mismatches": 0/);
      console.log(
        `Synthetic 10000 organizations / pending roots / connectors / sites, 20000 deployments: ${Math.round(performance.now() - start)} ms, default 1s lock / 10s statement limits.`,
      );
    },
  );
} finally {
  process.chdir(originalDirectory);
  await admin.query(`DROP DATABASE IF EXISTS "${template}"`);
  await admin.end();
  await rm(fixture, { recursive: true, force: true });
}
console.log("Prepared domain trigger retirement transition validated");
