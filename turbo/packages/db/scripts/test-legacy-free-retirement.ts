import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
const schema = `legacy_free_retirement_${randomUUID().replaceAll("-", "")}`;
const base = `
    CREATE TABLE org_metadata (
      org_id text PRIMARY KEY,
      tier text NOT NULL DEFAULT 'limited-free-1',
      credits bigint NOT NULL DEFAULT 0,
      stripe_subscription_id text,
      subscription_status text,
      pending_subscription_schedule_id text,
      pending_subscription_target_tier text,
      pending_subscription_change_at timestamp,
      onboarding_complete boolean NOT NULL DEFAULT true,
      updated_at timestamp NOT NULL DEFAULT '2026-01-01'
    );
    CREATE TABLE org_plan_entitlements (
      org_id text PRIMARY KEY,
      plan_key text NOT NULL,
      plan_rank integer NOT NULL DEFAULT 0,
      source text NOT NULL DEFAULT 'manual',
      status text NOT NULL DEFAULT 'active',
      base_concurrency_limit integer NOT NULL DEFAULT 1,
      can_buy_concurrency boolean NOT NULL DEFAULT false,
      can_buy_credits boolean NOT NULL DEFAULT true,
      show_usage_pack boolean NOT NULL DEFAULT false,
      auto_recharge_allowed boolean NOT NULL DEFAULT false,
      support_byok boolean NOT NULL DEFAULT false,
      restricted_built_in_models boolean NOT NULL DEFAULT false,
      workflow_webhook_trigger_allowed boolean NOT NULL DEFAULT false,
      audio_lifetime_limit integer DEFAULT 10,
      audio_daily_rate_limit integer NOT NULL DEFAULT 10,
      audio_daily_duration_seconds integer NOT NULL DEFAULT 600,
      stripe_subscription_id text,
      stripe_price_id text,
      expires_at timestamp,
      metadata_hash text,
      source_metadata jsonb NOT NULL DEFAULT '{"audit":"preserve"}',
      updated_at timestamp NOT NULL DEFAULT '2026-01-01'
    );
    INSERT INTO org_metadata (org_id, tier, credits) VALUES
      ('legacy', 'free', 12345),
      ('limited', 'limited-free-1', 75),
      ('paid', 'team', 20000);
    UPDATE org_metadata SET
      stripe_subscription_id = 'sub_paid', subscription_status = 'active',
      pending_subscription_schedule_id = 'schedule_paid',
      pending_subscription_target_tier = 'free',
      pending_subscription_change_at = '2026-12-01'
    WHERE org_id = 'paid';
    INSERT INTO org_plan_entitlements (org_id, plan_key, status) VALUES
      ('legacy', 'free', 'suspended'),
      ('entitlement_only', 'free', 'active'),
      ('limited', 'limited-free-1', 'active'),
      ('paid', 'team', 'active');
    UPDATE org_plan_entitlements SET
      stripe_price_id = 'historical_price', expires_at = '2027-01-01',
      metadata_hash = 'old-capability-hash'
    WHERE plan_key = 'free';
  `;
const catalogSql = `
  SELECT to_jsonb(c) AS value, pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c
  WHERE c.connamespace = $1::regnamespace
  ORDER BY c.oid
`;
const namespaceSql = "SELECT nspname FROM pg_namespace WHERE nspname = $1";

const migration = await readFile(
  new URL(
    "../src/migrations/1316_retire_legacy_free_tier.sql",
    import.meta.url,
  ),
  "utf8",
);

type ErrorOccurrence = { stage: string; error: unknown };

function observeNativeErrors(occurrences: ErrorOccurrence[]) {
  if (occurrences.length > 0) throw occurrences[0]?.error;
}

function throwFailures(occurrences: ErrorOccurrence[]) {
  const failures = [
    ...new Set(
      occurrences.map(({ error }) => {
        return error;
      }),
    ),
  ];
  if (failures.length === 0) return;
  // Keep repeat observations of the same object without counting new failures.
  console.dir(occurrences, { depth: null });
  if (failures.length === 1) throw failures[0];
  throw Object.assign(
    new AggregateError(failures, "Legacy Free validation or disposal failed", {
      cause: failures[0],
    }),
    { occurrences },
  );
}

const parentOccurrences: ErrorOccurrence[] = [];
let rejectParentError: (error: unknown) => void;
const parentNativeError = new Promise<never>((_resolve, reject) => {
  rejectParentError = reject;
});
void parentNativeError.catch(() => {});
client.on("error", (error: unknown) => {
  parentOccurrences.push({ stage: "native error event", error });
  rejectParentError(error);
});
let parentOwned = false;
let parentSearchPath: string | undefined;
let parentPathChangeAttempted = false;

async function snapshot(table: "org_metadata" | "org_plan_entitlements") {
  const result = await client.query<{ value: Record<string, unknown> }>(
    `SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY org_id`,
  );
  observeNativeErrors(parentOccurrences);
  return result.rows.map((row) => {
    return row.value;
  });
}

try {
  // Some native auth-helper errors emit without settling connect. Race only
  // this original wait; its losing rejection remains observed after disposal.
  await Promise.race([
    client.connect().catch((error: unknown) => {
      parentOccurrences.push({ stage: "connect rejection", error });
      throw error;
    }),
    parentNativeError,
  ]);
  observeNativeErrors(parentOccurrences);
  const path = await client.query<{ search_path: string }>("SHOW search_path");
  observeNativeErrors(parentOccurrences);
  parentSearchPath = path.rows[0]?.search_path;
  assert.equal(typeof parentSearchPath, "string");
  const namespaces = await client.query(namespaceSql, [schema]);
  observeNativeErrors(parentOccurrences);
  assert.equal(namespaces.rowCount, 0);
  await client.query(`CREATE SCHEMA "${schema}"`);
  // Only the successful CREATE ACK grants ownership; never adopt a collision.
  parentOwned = true;
  observeNativeErrors(parentOccurrences);
  parentPathChangeAttempted = true;
  await client.query("SELECT set_config('search_path', $1, false)", [schema]);
  observeNativeErrors(parentOccurrences);
  await client.query(base);
  observeNativeErrors(parentOccurrences);

  const metadataBefore = await snapshot("org_metadata");
  const entitlementsBefore = await snapshot("org_plan_entitlements");

  const parentCatalogBefore = await client.query(catalogSql, [schema]);
  observeNativeErrors(parentOccurrences);

  // A failed migration must roll back both the DDL and all original data.
  for (const setup of [
    `INSERT INTO org_metadata (org_id, tier) VALUES ('unsafe', 'free')`,
    `INSERT INTO org_metadata (org_id, tier) VALUES ('unsafe', 'free');
     INSERT INTO org_plan_entitlements (org_id, plan_key) VALUES ('unsafe', 'pro')`,
    `INSERT INTO org_metadata (org_id, tier) VALUES ('unsafe', 'pro');
     INSERT INTO org_plan_entitlements (org_id, plan_key) VALUES ('unsafe', 'free')`,
    `INSERT INTO org_plan_entitlements (org_id, plan_key, stripe_subscription_id)
     VALUES ('unsafe', 'free', 'sub_linked')`,
    `INSERT INTO org_metadata (org_id, tier, subscription_status)
     VALUES ('unsafe', 'free', 'active');
     INSERT INTO org_plan_entitlements (org_id, plan_key) VALUES ('unsafe', 'free')`,
    `INSERT INTO org_metadata (org_id, tier, pending_subscription_schedule_id)
     VALUES ('unsafe', 'free', 'schedule_linked');
     INSERT INTO org_plan_entitlements (org_id, plan_key) VALUES ('unsafe', 'free')`,
  ]) {
    const child = new Client({ connectionString: databaseUrl });
    const childSchema = `legacy_free_unsafe_${randomUUID().replaceAll("-", "")}`;
    // Share only plain observations so both actors retain actual failure order.
    const childOccurrences = parentOccurrences;
    let rejectChildError: (error: unknown) => void;
    const childNativeError = new Promise<never>((_resolve, reject) => {
      rejectChildError = reject;
    });
    void childNativeError.catch(() => {});
    child.on("error", (error: unknown) => {
      childOccurrences.push({ stage: "native error event", error });
      rejectChildError(error);
    });
    let owned = false;
    let searchPath: string | undefined;
    let pathChangeAttempted = false;
    try {
      await Promise.race([
        child.connect().catch((error: unknown) => {
          childOccurrences.push({ stage: "connect rejection", error });
          throw error;
        }),
        childNativeError,
      ]);
      observeNativeErrors(childOccurrences);
      const path = await child.query<{ search_path: string }>(
        "SHOW search_path",
      );
      observeNativeErrors(childOccurrences);
      searchPath = path.rows[0]?.search_path;
      assert.equal(typeof searchPath, "string");
      const namespaces = await child.query(namespaceSql, [childSchema]);
      observeNativeErrors(childOccurrences);
      assert.equal(namespaces.rowCount, 0);
      await child.query(`CREATE SCHEMA "${childSchema}"`);
      // Only the successful CREATE ACK grants ownership, even if an async
      // error is observed immediately afterward. Never adopt a collision.
      owned = true;
      observeNativeErrors(childOccurrences);
      pathChangeAttempted = true;
      await child.query("SELECT set_config('search_path', $1, false)", [
        childSchema,
      ]);
      observeNativeErrors(childOccurrences);
      await child.query(base);
      observeNativeErrors(childOccurrences);
      const metadataBase = await child.query<{
        value: Record<string, unknown>;
      }>("SELECT to_jsonb(t) AS value FROM org_metadata t ORDER BY org_id");
      observeNativeErrors(childOccurrences);
      assert.deepEqual(
        metadataBase.rows.map(({ value }) => {
          return value;
        }),
        metadataBefore,
      );
      const entitlementsBase = await child.query<{
        value: Record<string, unknown>;
      }>(
        "SELECT to_jsonb(t) AS value FROM org_plan_entitlements t ORDER BY org_id",
      );
      observeNativeErrors(childOccurrences);
      assert.deepEqual(
        entitlementsBase.rows.map(({ value }) => {
          return value;
        }),
        entitlementsBefore,
      );
      await child.query(setup);
      observeNativeErrors(childOccurrences);
      const metadataUnsafe = await child.query(
        "SELECT to_jsonb(t) AS value FROM org_metadata t ORDER BY org_id",
      );
      observeNativeErrors(childOccurrences);
      const entitlementsUnsafe = await child.query(
        "SELECT to_jsonb(t) AS value FROM org_plan_entitlements t ORDER BY org_id",
      );
      observeNativeErrors(childOccurrences);
      const catalogBefore = await child.query(catalogSql, [childSchema]);
      observeNativeErrors(childOccurrences);
      let migrationRejection: unknown;
      try {
        // One unchanged simple-query message: the three ADD CONSTRAINTs and
        // rejecting DO roll back together in PostgreSQL's implicit transaction.
        await assert.rejects(
          child.query(migration).catch((error: unknown) => {
            migrationRejection = error;
            throw error;
          }),
          (error: unknown) => {
            return (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "P0001" &&
              "message" in error &&
              error.message ===
                "Legacy Free has mismatched/missing entitlements or subscription state; inspect before migrating"
            );
          },
        );
      } catch (error) {
        // Keep the same failed assertion and its wrong native rejection. An
        // unexpected success still runs assert.rejects and has no fake code.
        if (
          error instanceof assert.AssertionError &&
          migrationRejection !== undefined
        ) {
          Object.defineProperty(error, "cause", {
            value: migrationRejection,
            configurable: true,
          });
        }
        throw error;
      }
      observeNativeErrors(childOccurrences);
      const metadataAfter = await child.query(
        "SELECT to_jsonb(t) AS value FROM org_metadata t ORDER BY org_id",
      );
      observeNativeErrors(childOccurrences);
      assert.deepEqual(metadataAfter.rows, metadataUnsafe.rows);
      const entitlementsAfter = await child.query(
        "SELECT to_jsonb(t) AS value FROM org_plan_entitlements t ORDER BY org_id",
      );
      observeNativeErrors(childOccurrences);
      assert.deepEqual(entitlementsAfter.rows, entitlementsUnsafe.rows);
      const catalogAfter = await child.query(catalogSql, [childSchema]);
      observeNativeErrors(childOccurrences);
      assert.deepEqual(catalogAfter.rows, catalogBefore.rows);
      const constraints = await child.query(
        `
        SELECT conname FROM pg_constraint
        WHERE connamespace = $1::regnamespace AND conname LIKE '%not_free'
      `,
        [childSchema],
      );
      observeNativeErrors(childOccurrences);
      assert.equal(constraints.rowCount, 0);
    } catch (error) {
      childOccurrences.push({ stage: "validation", error });
    } finally {
      // Cleanup is independent of the reject-only signal. Every owned attempt
      // runs even after another cleanup fails; no timeout, retry or adoption.
      if (owned) {
        try {
          await child.query(`DROP SCHEMA "${childSchema}" CASCADE`);
        } catch (error) {
          childOccurrences.push({ stage: "drop", error });
        }
        try {
          assert.equal(
            (await child.query(namespaceSql, [childSchema])).rowCount,
            0,
          );
        } catch (error) {
          childOccurrences.push({ stage: "absence", error });
        }
      }
      if (pathChangeAttempted && searchPath !== undefined) {
        try {
          await child.query("SELECT set_config('search_path', $1, false)", [
            searchPath,
          ]);
        } catch (error) {
          childOccurrences.push({ stage: "restore search_path", error });
        }
        try {
          assert.deepEqual((await child.query("SHOW search_path")).rows, [
            { search_path: searchPath },
          ]);
        } catch (error) {
          childOccurrences.push({ stage: "verify search_path", error });
        }
      }
      try {
        await child.end();
      } catch (error) {
        childOccurrences.push({ stage: "end", error });
      }
    }
    // Propagate the first original object; aggregate only after parent disposal.
    observeNativeErrors(childOccurrences);
    observeNativeErrors(parentOccurrences);
    assert.deepEqual(await snapshot("org_metadata"), metadataBefore);
    assert.deepEqual(
      await snapshot("org_plan_entitlements"),
      entitlementsBefore,
    );
    const constraints = await client.query(`
      SELECT conname FROM pg_constraint
      WHERE connamespace = '${schema}'::regnamespace
        AND conname LIKE '%not_free'
    `);
    observeNativeErrors(parentOccurrences);
    assert.equal(constraints.rowCount, 0);
    const catalogAfter = await client.query(catalogSql, [schema]);
    observeNativeErrors(parentOccurrences);
    assert.deepEqual(catalogAfter.rows, parentCatalogBefore.rows);
  }

  await client.query(migration);
  observeNativeErrors(parentOccurrences);
  const metadataAfter = await snapshot("org_metadata");
  assert.equal(metadataAfter.length, metadataBefore.length);
  for (const before of metadataBefore) {
    const after = metadataAfter.find((row) => {
      return row.org_id === before.org_id;
    });
    assert.ok(after);
    assert.deepEqual(after, {
      ...before,
      tier: before.tier === "free" ? "limited-free-1" : before.tier,
      pending_subscription_target_tier:
        before.pending_subscription_target_tier === "free"
          ? "limited-free-1"
          : before.pending_subscription_target_tier,
      updated_at:
        before.org_id === "limited" ? before.updated_at : after.updated_at,
    });
  }
  const entitlementsAfter = await snapshot("org_plan_entitlements");
  assert.equal(entitlementsAfter.length, entitlementsBefore.length);
  for (const before of entitlementsBefore) {
    const after = entitlementsAfter.find((row) => {
      return row.org_id === before.org_id;
    });
    assert.ok(after);
    assert.deepEqual(
      after,
      before.plan_key === "free"
        ? {
            ...before,
            plan_key: "limited-free-1",
            plan_rank: 0,
            base_concurrency_limit: 2,
            can_buy_concurrency: false,
            can_buy_credits: false,
            show_usage_pack: false,
            auto_recharge_allowed: false,
            support_byok: true,
            restricted_built_in_models: true,
            workflow_webhook_trigger_allowed: false,
            audio_lifetime_limit: 10,
            audio_daily_rate_limit: 10,
            audio_daily_duration_seconds: 600,
            metadata_hash: null,
            updated_at: after.updated_at,
          }
        : before,
    );
  }
  const constraints = await client.query<{ convalidated: boolean }>(`
    SELECT convalidated FROM pg_constraint
    WHERE connamespace = '${schema}'::regnamespace
      AND conname LIKE '%not_free'
  `);
  observeNativeErrors(parentOccurrences);
  assert.equal(constraints.rowCount, 3);
  assert.ok(
    constraints.rows.every((row) => {
      return row.convalidated;
    }),
  );

  console.log(
    "Legacy Free retirement: preservation, entitlement-only rows, paid pending targets, rollback and constraint validation passed",
  );
} catch (error) {
  parentOccurrences.push({ stage: "validation", error });
} finally {
  if (parentOwned) {
    try {
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    } catch (error) {
      parentOccurrences.push({ stage: "drop", error });
    }
    try {
      assert.equal((await client.query(namespaceSql, [schema])).rowCount, 0);
    } catch (error) {
      parentOccurrences.push({ stage: "absence", error });
    }
  }
  if (parentPathChangeAttempted && parentSearchPath !== undefined) {
    try {
      await client.query("SELECT set_config('search_path', $1, false)", [
        parentSearchPath,
      ]);
    } catch (error) {
      parentOccurrences.push({ stage: "restore search_path", error });
    }
    try {
      assert.deepEqual((await client.query("SHOW search_path")).rows, [
        { search_path: parentSearchPath },
      ]);
    } catch (error) {
      parentOccurrences.push({
        stage: "verify search_path",
        error,
      });
    }
  }
  try {
    await client.end();
  } catch (error) {
    parentOccurrences.push({ stage: "end", error });
  }
}
throwFailures(parentOccurrences);
