import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  claimErasureWork,
  executeErasureWork,
  type ErasureHandler,
} from "../src/operations/account-erasure";
import { accountErasureJobs as jobs } from "../src/schema/account-erasure";

// B1 is dormant: no HTTP/worker entry point can construct these scale/MVCC
// states. Use the real persistence operations and driver, in an owned schema.
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    migration: { type: "string" },
    "assert-bounded": { type: "boolean", default: false },
  },
});
assert.ok(values.output, "--output is required");
const databaseUrl = process.env.DATABASE_URL;
assert.ok(
  databaseUrl,
  "DATABASE_URL is required (disposable local PostgreSQL)",
);
const schema = `erasure_scale_${randomUUID().replaceAll("-", "")}`;
const pool = new Pool({
  connectionString: databaseUrl,
  max: 8,
  options: `-c search_path=${schema} -c statement_timeout=10000`,
});
const client = await pool.connect();
const statements: { sql: string; params: unknown[] }[] = [];
const db = drizzle(pool, {
  logger: {
    logQuery(query: string, params: unknown[]) {
      statements.push({ sql: query, params });
    },
  },
});
const jobId = "10000000-0000-4000-8000-000000000001";
const sinkId = "10000000-0000-4000-8000-000000000002";
const ref = "10000000-0000-4000-8000-000000000003";
const rows: object[] = [];
const rollback = new Error("capture rollback");

function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  assert.equal(typeof value, "number");
  return value as number;
}
function nodes(value: unknown): Record<string, unknown>[] {
  const node = record(value);
  if (node.Plans === undefined) return [node];
  assert.ok(Array.isArray(node.Plans));
  return [node, ...node.Plans.flatMap(nodes)];
}

async function fixture(terminal: number, churn: boolean, pending = 16) {
  await client.query("TRUNCATE account_erasure_work CASCADE");
  await client.query(
    `INSERT INTO account_erasure_work
      (id, job_id, sink_id, item_key, generation, kind, selector_ciphertext,
       selector_digest, selector_capture_revision, available_at, state,
       evidence_ref, proof_capture_revision, proof_inventory_revision,
       proof_boundary_ref, proof_reader_ref, proof_observed_at, enumeration_ref)
     SELECT lpad(g::text, 32, '0')::uuid, $1, $2, lpad(g::text, 32, '0')::uuid,
       1, 'inventory', 'vm0secret:v1:synthetic', repeat('a', 64), 1,
       '2000-01-01'::timestamptz + g * interval '1 second',
       CASE WHEN $4 THEN 'pending' ELSE
         (ARRAY['verified_erased','verified_no_applicable_data','capability_unresolved'])[1 + g % 3] END,
       $5, 1, 1, $5, $5, '2000-01-01', $5
     FROM generate_series(1, $3::int) g`,
    [jobId, sinkId, terminal, churn, ref],
  );
  await client.query(
    `INSERT INTO account_erasure_work
      (id, job_id, sink_id, item_key, generation, kind, selector_ciphertext,
       selector_digest, selector_capture_revision, available_at, state)
     SELECT lpad(g::text, 32, '0')::uuid, $1, $2, lpad(g::text, 32, '0')::uuid,
       1, 'inventory', 'vm0secret:v1:synthetic', repeat('b', 64), 1,
       '2020-01-01'::timestamptz,
       CASE WHEN g % 2 = 0 THEN 'pending' ELSE 'retryable_failure' END
     FROM generate_series(1000001, 1000000 + $3::int) g`,
    [jobId, sinkId, pending],
  );
  await client.query("ANALYZE account_erasure_work");
}

async function capture(phase: "inventory" | "verification", deadline: boolean) {
  await db
    .update(jobs)
    .set({
      sealedCaptureRevision: phase === "verification" ? 1 : null,
      producerBoundaryRef: phase === "verification" ? ref : null,
      deadlineAt: new Date(deadline ? "2000-01-02" : "2099-01-01"),
      state: "pending",
    })
    .where(eq(jobs.id, jobId));
  statements.length = 0;
  await assert.rejects(
    db.transaction(async (tx) => {
      await claimErasureWork(tx, jobId, phase);
      throw rollback;
    }),
    (error: unknown) => {
      return error === rollback;
    },
  );
  const query = statements.find((entry) => {
    return deadline
      ? entry.sql.startsWith('update "account_erasure_work"')
      : entry.sql.startsWith("select") && entry.sql.includes("skip locked");
  });
  assert.ok(query, "actual claim statement must be captured");
  return query;
}

async function explain(
  scenario: string,
  terminal: number,
  phase: "inventory" | "verification" | "deadline",
  generic = false,
) {
  const query = await capture(
    phase === "inventory" ? "inventory" : "verification",
    phase === "deadline",
  );
  await client.query("BEGIN");
  try {
    let result;
    if (generic) {
      // Test planner-visible literals under a generic named plan too. This
      // changes only plan caching, never enable_* or index/scan costs.
      await client.query("SET LOCAL plan_cache_mode = force_generic_plan");
      await client.query(`PREPARE scale_claim AS ${query.sql}`);
      const args = query.params
        .map((value) => {
          assert.ok(
            typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean" ||
              value === null,
          );
          if (value === null) return "NULL";
          return typeof value === "string"
            ? `'${value.replaceAll("'", "''")}'`
            : String(value);
        })
        .join(", ");
      result = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE scale_claim(${args})`,
      );
      await client.query("DEALLOCATE scale_claim");
    } else {
      result = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
        query.params,
      );
    }
    const row: unknown = result.rows[0];
    const plans = record(row)["QUERY PLAN"];
    assert.ok(Array.isArray(plans) && plans.length === 1);
    const plan = record(plans[0]);
    const tree = nodes(plan.Plan);
    const filtered = tree.reduce((total, node) => {
      return (
        total +
        (node["Rows Removed by Filter"] === undefined
          ? 0
          : number(node["Rows Removed by Filter"])) *
          number(node["Actual Loops"])
      );
    }, 0);
    const root = record(plan.Plan);
    const summary = {
      scenario,
      terminal,
      phase,
      generic,
      filtered,
      buffers:
        number(root["Shared Hit Blocks"]) + number(root["Shared Read Blocks"]),
      executionMs: number(plan["Execution Time"]),
      scans: tree
        .filter((node) => {
          return String(node["Node Type"]).includes("Scan");
        })
        .map((node) => {
          return {
            type: node["Node Type"],
            index: node["Index Name"],
            rows: node["Actual Rows"],
            loops: node["Actual Loops"],
            filtered: node["Rows Removed by Filter"],
          };
        }),
      sorts: tree
        .filter((node) => {
          return node["Node Type"] === "Sort";
        })
        .map((node) => {
          return {
            rows: node["Actual Rows"],
            method: node["Sort Method"],
            memoryKB: node["Sort Space Used"],
          };
        }),
    };
    rows.push({ ...summary, query, plan });
    console.log(JSON.stringify(summary));
    if (
      values["assert-bounded"] &&
      terminal >= 1000 &&
      [
        "direct",
        "no-eligible",
        "batch-0",
        "batch-1",
        "large-pending-set",
      ].includes(scenario)
    ) {
      assert.ok(
        filtered < 64,
        "terminal prefix must not be repeatedly filtered",
      );
      const scanned = tree
        .filter((node) => {
          return [
            "Index Scan",
            "Index Only Scan",
            "Seq Scan",
            "Bitmap Heap Scan",
          ].includes(String(node["Node Type"]));
        })
        .reduce((total, node) => {
          return (
            total + number(node["Actual Rows"]) * number(node["Actual Loops"])
          );
        }, 0);
      assert.ok(
        scanned < 64,
        "a small claim must not scan the entire work table",
      );
    }
  } finally {
    await client.query("ROLLBACK");
  }
}

const handler: ErasureHandler = {
  version: ref,
  inventory: () => {
    throw new Error("verification fixture only");
  },
  erase: () => {
    return Promise.resolve({ requestRef: ref });
  },
  verify: (lease, boundary) => {
    return Promise.resolve({
      ...lease,
      sinkId: lease.item.sinkId,
      producerBoundaryRef: boundary,
      outcome: "verified_erased",
      evidenceRef: ref,
      authenticatedReaderRef: ref,
      enumerationRef: ref,
      observedAt: new Date("2026-01-01"),
    });
  },
};

try {
  await client.query(`CREATE SCHEMA "${schema}"`);
  const foundation = await readFile(
    new URL(
      "../src/migrations/1124_account_erasure_foundation.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await client.query(foundation.replaceAll('"public".', `"${schema}".`));
  if (values.migration) {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query(
        (await readFile(values.migration, "utf8")).replaceAll(
          '"public".',
          `"${schema}".`,
        ),
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  await client.query(
    "ALTER TABLE account_erasure_work SET (autovacuum_enabled = false)",
  );
  await db.insert(jobs).values({
    id: jobId,
    subjectKind: "user",
    subjectId: "synthetic_scale_fixture",
    generation: 1,
    authorityId: ref,
    decisionRef: ref,
    decisionSequence: 1n,
    confirmationRef: ref,
    dispositionVersion: 1,
    requestedAt: new Date("2000-01-01"),
    deadlineAt: new Date("2099-01-01"),
  });
  await client.query(
    "INSERT INTO account_erasure_sinks VALUES ($1,$2,'objects',1,$3)",
    [jobId, sinkId, ref],
  );
  const environment = (
    await client.query(
      "SELECT version(), current_setting('plan_cache_mode') AS plan_cache_mode, current_setting('random_page_cost') AS random_page_cost, current_setting('enable_seqscan') AS enable_seqscan",
    )
  ).rows;
  for (const terminal of [0, 1000, 10000, 100000]) {
    await fixture(terminal, false);
    for (const phase of ["verification", "inventory", "deadline"] as const) {
      await explain("direct", terminal, phase);
      await explain("direct", terminal, phase, true);
    }
    // Real claim/completion batches keep available_at untouched and generate
    // index churn through the actual terminal proof/CAS path.
    await capture("verification", false);
    await client.query(
      "UPDATE account_erasure_work SET capture_complete = true, enumeration_ref = $1",
      [ref],
    );
    for (let batch = 0; batch < 2; batch++) {
      await explain(`batch-${batch}`, terminal, "verification");
      const leases = await claimErasureWork(db, jobId, "verification");
      assert.equal(leases.length, 8);
      for (const lease of leases)
        await executeErasureWork(
          db,
          lease,
          handler,
          new AbortController().signal,
        );
    }
    for (const phase of ["verification", "inventory", "deadline"] as const) {
      await explain("no-eligible", terminal, phase);
    }
  }
  await fixture(100000, true);
  const snapshot = await pool.connect();
  try {
    await snapshot.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await snapshot.query("SELECT id FROM account_erasure_work LIMIT 1");
    await client.query(`UPDATE account_erasure_work SET state =
      (ARRAY['verified_erased','verified_no_applicable_data','capability_unresolved'])[1 + substring(id::text from 36)::int % 3]
      WHERE id < '00000000-0000-0000-0000-000001000001'`);
    await client.query("ANALYZE account_erasure_work");
    for (const phase of ["verification", "inventory", "deadline"] as const)
      await explain("churn-pinned-snapshot", 100000, phase);
  } finally {
    await snapshot.query("ROLLBACK");
    snapshot.release();
  }
  for (const phase of ["verification", "inventory", "deadline"] as const)
    await explain("churn-before-vacuum", 100000, phase);
  await client.query("VACUUM (ANALYZE) account_erasure_work");
  for (const phase of ["verification", "inventory", "deadline"] as const)
    await explain("churn-after-vacuum", 100000, phase);
  await fixture(10000, true);
  for (const [scenario, update] of [
    ["stale-generation", "generation = 2"],
    ["stale-revision", "generation = 1, selector_capture_revision = 2"],
    [
      "live-lease",
      `selector_capture_revision = 1, lease_id = '${ref}', lease_expires_at = '2099-01-01'`,
    ],
    [
      "future-retry",
      "lease_id = NULL, lease_expires_at = NULL, available_at = '2099-01-01'",
    ],
    ["inventory-mismatch", "available_at = '2000-01-01', kind = 'erase'"],
    ["inventory-complete", "kind = 'inventory', capture_complete = true"],
  ] as const) {
    await client.query(
      `UPDATE account_erasure_work SET ${update} WHERE id < '00000000-0000-0000-0000-000001000001'`,
    );
    await client.query("VACUUM (ANALYZE) account_erasure_work");
    await explain(scenario, 0, "inventory");
    if (scenario === "future-retry") {
      await client.query(
        "UPDATE account_erasure_work SET available_at = '2099-01-01'",
      );
      await client.query("VACUUM (ANALYZE) account_erasure_work");
      await explain("future-retry-no-eligible", 0, "inventory");
      await client.query(
        "UPDATE account_erasure_work SET available_at = '2020-01-01' WHERE id >= '00000000-0000-0000-0000-000001000001'",
      );
    }
  }
  // All-pending deadline inventory exposes the different id ordering; a claim
  // index ordered by available_at cannot by itself bound this sort.
  await fixture(100000, true);
  await explain("all-pending", 0, "deadline");
  await fixture(100000, false, 10000);
  await explain("large-pending-set", 100000, "deadline");
  await writeFile(
    values.output,
    JSON.stringify({ environment, rows }, null, 2) + "\n",
  );
} finally {
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  client.release();
  await pool.end();
}
