import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { array, number, object, string } from "zod";
import { applyPendingMigrations } from "./migration-runner";

const journalSchema = object({
  entries: array(object({ tag: string(), when: number() })),
});

/** Exercise the real migrator against the complete preceding schema. */
export async function validateStripeInvoicePaidRetirement(databaseUrl: string) {
  const journal = journalSchema.parse(
    JSON.parse(
      await readFile(
        new URL("../src/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const retirement = journal.entries.find((entry) => {
    return entry.tag === "1457_retire_stripe_invoice_paid_storage";
  });
  assert.ok(retirement);
  const admin = postgres(databaseUrl, { max: 1 });
  const baselineName = `stripe_retirement_base_${randomUUID().replaceAll("-", "")}`;
  const baselineUrl = new URL(databaseUrl);
  baselineUrl.pathname = `/${baselineName}`;
  let baselineCreated = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${baselineName}"`);
    baselineCreated = true;
    const baseline = postgres(baselineUrl.toString(), { max: 1 });
    try {
      await applyPendingMigrations(baseline, { beforeMillis: retirement.when });
      await baseline`
        INSERT INTO agents (id, org_id, owner, name)
        VALUES ('11111111-1111-4111-8111-111111111111', 'retirement-org', 'owner', 'retirement')
      `;
      await baseline`
        INSERT INTO workflows (id, org_id, agent_id, owner_user_id, name, created_by, updated_by)
        VALUES ('22222222-2222-4222-8222-222222222222', 'retirement-org',
          '11111111-1111-4111-8111-111111111111', 'owner', 'retirement', 'owner', 'owner')
      `;
      await baseline`
        INSERT INTO workflow_automations (id, org_id, workflow_id, owner_user_id, kind, event_type, event_config)
        VALUES ('33333333-3333-4333-8333-333333333333', 'retirement-org',
          '22222222-2222-4222-8222-222222222222', 'owner', 'event', 'gmail-new-message', '{}')
      `;
      await baseline`
        INSERT INTO connectors (id, connector_slug, auth_method, storage_version, user_id, org_id, external_id)
        VALUES ('44444444-4444-4444-8444-444444444444', 'stripe', 'oauth', 1, 'owner', 'retirement-org', 'acct_retained')
      `;
    } finally {
      await baseline.end();
    }

    for (const scenario of [
      "empty",
      "automation",
      "health",
      "delivery",
      "dependent-view",
      "dependent-foreign-key",
      "string-bodied-function",
    ]) {
      const name = `stripe_retirement_${randomUUID().replaceAll("-", "")}`;
      const url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      await admin.unsafe(
        `CREATE DATABASE "${name}" TEMPLATE "${baselineName}"`,
      );
      const sql = postgres(url.toString(), { max: 1 });
      try {
        const preserved = async () => {
          return JSON.stringify([
            Array.from(await sql`SELECT * FROM agents ORDER BY id`),
            Array.from(await sql`SELECT * FROM workflows ORDER BY id`),
            Array.from(
              await sql`SELECT * FROM workflow_automations ORDER BY id`,
            ),
            Array.from(await sql`SELECT * FROM connectors ORDER BY id`),
            Array.from(
              await sql`SELECT pg_get_indexdef('idx_connectors_stripe_oauth_external_id'::regclass)`,
            ),
          ]);
        };
        const original = await preserved();
        const originalJournal = Array.from(
          await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
        );
        if (scenario === "empty") {
          await applyPendingMigrations(sql, {
            beforeMillis: retirement.when + 1,
          });
          assert.equal(await preserved(), original);
          const applied = Array.from(
            await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
          );
          assert.equal(applied.length, originalJournal.length + 1);
          assert.equal(applied.at(-1)?.created_at, String(retirement.when));
          await applyPendingMigrations(sql, {
            beforeMillis: retirement.when + 1,
          });
          assert.deepEqual(
            Array.from(
              await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
            ),
            applied,
          );
          await sql`
            INSERT INTO workflow_automations (org_id, workflow_id, owner_user_id, kind, event_type, event_config)
            VALUES ('retirement-org', '22222222-2222-4222-8222-222222222222', 'owner', 'event', 'webhook-received', '{}')
          `;
          await sql`
            INSERT INTO workflow_automations (org_id, workflow_id, owner_user_id, kind, schedule_type, interval_seconds)
            VALUES ('retirement-org', '22222222-2222-4222-8222-222222222222', 'owner', 'schedule', 'loop', 60)
          `;
          assert.deepEqual(
            Array.from(
              await sql`UPDATE connectors SET needs_reconnect = true
                WHERE connector_slug = 'stripe' AND auth_method = 'oauth' AND external_id = 'acct_retained'
                RETURNING id`,
            ),
            [{ id: "44444444-4444-4444-8444-444444444444" }],
          );
          continue;
        }
        if (scenario === "automation")
          await sql`UPDATE workflow_automations SET event_type = 'stripe-invoice-paid'`;
        if (scenario === "health")
          await sql`INSERT INTO stripe_workflow_automation_health (automation_id)
            VALUES ('33333333-3333-4333-8333-333333333333')`;
        if (scenario === "delivery")
          await sql`INSERT INTO stripe_workflow_deliveries
            (automation_id, connector_id, stripe_account_id, livemode, stripe_event_id, stripe_event_created_at, snapshot, next_attempt_at)
            VALUES ('33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444',
              'acct_retained', true, 'evt_retained', now(), '{}', now())`;
        if (scenario === "dependent-view")
          await sql`CREATE VIEW delivery_consumer AS SELECT id FROM stripe_workflow_deliveries`;
        if (scenario === "dependent-foreign-key")
          await sql`CREATE TABLE delivery_consumer (id uuid REFERENCES stripe_workflow_deliveries(id))`;
        if (scenario === "string-bodied-function")
          await sql`CREATE FUNCTION delivery_count() RETURNS bigint LANGUAGE sql
            AS 'SELECT count(*) FROM public.stripe_workflow_deliveries'`;
        const state = async () => {
          return JSON.stringify([
            await preserved(),
            Array.from(await sql`SELECT * FROM stripe_workflow_deliveries`),
            Array.from(
              await sql`SELECT * FROM stripe_workflow_automation_health`,
            ),
            Array.from(
              await sql`SELECT pg_get_constraintdef(oid) FROM pg_constraint
                WHERE conrelid = 'workflow_automations'::regclass
                AND conname = 'workflow_automations_schedule_config_check'`,
            ),
            Array.from(
              await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
            ),
          ]);
        };
        const before = await state();
        const code = ["automation", "health", "delivery"].includes(scenario)
          ? "55000"
          : "2BP01";
        await assert.rejects(
          applyPendingMigrations(sql, { beforeMillis: retirement.when + 1 }),
          { code },
        );
        assert.equal(await state(), before, scenario);
      } finally {
        await sql.end();
        await admin.unsafe(`DROP DATABASE "${name}"`);
      }
    }
  } finally {
    try {
      if (baselineCreated)
        await admin.unsafe(`DROP DATABASE "${baselineName}"`);
    } finally {
      await admin.end();
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await validateStripeInvoicePaidRetirement(process.env.DATABASE_URL);
  console.log(
    "Stripe invoice-paid retirement data, dependency and atomicity checks passed",
  );
}
