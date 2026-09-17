#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { Client } from "pg";

// An operator-only, dry-run-by-default boundary. It never calls billing consumers.
const { values } = parseArgs({
  options: {
    "org-id": { type: "string" },
    "user-id": { type: "string" },
    "run-from": { type: "string" },
    "run-through": { type: "string" },
    "job-id": { type: "string" },
    "writer-since": { type: "string" },
    "max-rows": { type: "string", default: "1000" },
    "batch-size": { type: "string", default: "200" },
    "max-ms": { type: "string", default: "5000" },
    migrate: { type: "boolean", default: false },
    "ack-writer-drain": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "billing-attribution --org-id ORG [--user-id USER] [--run-from UUID --run-through UUID] [--writer-since ISO] [--max-rows 1000 --max-ms 5000] [--migrate --ack-writer-drain --job-id UUID --batch-size 200]",
  );
  process.exit(0);
}
assert.ok(
  values["org-id"],
  "--org-id is required; global mutation is not supported",
);
assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
function budget(value: string, max: number): number {
  const parsed = Number(value);
  assert.ok(
    Number.isSafeInteger(parsed) && parsed > 0 && parsed <= max,
    `budget must be in [1, ${max}]`,
  );
  return parsed;
}
function uuid(value: string | undefined): string | null {
  if (value === undefined) return null;
  assert.match(
    value,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  return value.toLowerCase();
}
const maxRows = budget(values["max-rows"], 1_000_000);
const batchSize = budget(values["batch-size"], 500);
const maxMs = budget(values["max-ms"], 60_000);
const scope = [
  values["org-id"],
  values["user-id"] ?? null,
  uuid(values["run-from"]),
  uuid(values["run-through"]),
] as const;
const jobId = uuid(values["job-id"]);
const writerSinceInput = values["writer-since"] ?? null;
if (writerSinceInput !== null)
  assert.ok(
    Number.isFinite(Date.parse(writerSinceInput)),
    "--writer-since must be a timestamp",
  );
const writerSince =
  writerSinceInput === null ? null : new Date(writerSinceInput).toISOString();
assert.ok(
  scope[2] === null || scope[3] === null || scope[2] <= scope[3],
  "run range is inverted",
);
if (values.migrate) {
  assert.ok(jobId, "--migrate requires a stable --job-id for restart");
  assert.ok(
    values["ack-writer-drain"],
    "verify all old compactors/writers have drained before --ack-writer-drain",
  );
}
const phases = ["runs", "jobs", "raw", "hourly", "done"] as const;
type Phase = (typeof phases)[number];
function phase(value: unknown): Phase {
  assert.ok(
    phases.some((candidate) => {
      return candidate === value;
    }),
    "invalid checkpoint phase",
  );
  if (
    value === "runs" ||
    value === "jobs" ||
    value === "raw" ||
    value === "hourly" ||
    value === "done"
  )
    return value;
  throw new Error("unreachable checkpoint phase");
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return Object.fromEntries(Object.entries(value));
}
function integer(value: unknown): number {
  assert.ok(
    typeof value === "number" ||
      (typeof value === "string" && /^\d+$/.test(value)),
  );
  const parsed = Number(value);
  assert.ok(Number.isSafeInteger(parsed) && parsed >= 0);
  return parsed;
}
function nullableText(value: unknown): string | null {
  assert.ok(value === null || typeof value === "string");
  return value;
}
const tables = {
  runs: "agent_runs",
  jobs: "built_in_generation_jobs",
  raw: "usage_event",
  hourly: "usage_event_hourly_rollup",
} as const;
function runIdentity(current: Exclude<Phase, "done">) {
  return current === "runs" ? "t.id" : "COALESCE(t.billing_run_id, t.run_id)";
}
function predicate(current: Exclude<Phase, "done">) {
  const identity = runIdentity(current);
  return `t.org_id = $1 AND ($2::text IS NULL OR t.user_id = $2)
    AND ($3::uuid IS NULL OR ${identity} >= $3::uuid)
    AND ($4::uuid IS NULL OR ${identity} <= $4::uuid)`;
}
function facts(current: Exclude<Phase, "done">, filter: string) {
  const identity = runIdentity(current);
  const isRun = current === "runs";
  const hasAnchor = current === "raw" || current === "hourly";
  const context = isRun
    ? "CASE WHEN a.run_id IS NULL THEN 'legacy_unknown' ELSE 'run' END"
    : "t.billing_context";
  const anchorConflict = hasAnchor
    ? "OR (t.billing_anchor_at IS NOT NULL AND a.run_started_at IS DISTINCT FROM t.billing_anchor_at)"
    : "";
  return `SELECT t.id, ${identity} AS billing_run_id, '${current}' AS phase,
    (${context} IN ('run', 'runless', 'pi_memory_stage1') AND (${context} IN ('runless', 'pi_memory_stage1') OR a.run_id IS NOT NULL)) AS populated,
    (${context} NOT IN ('run', 'runless', 'pi_memory_stage1') AND (a.run_id IS NOT NULL OR r.id IS NOT NULL)) AS eligible,
    (${context} NOT IN ('run', 'runless', 'pi_memory_stage1') AND a.run_id IS NULL AND r.id IS NULL) AS missing_source,
    ((a.run_id IS NOT NULL AND (a.org_id <> t.org_id OR a.user_id <> t.user_id ${anchorConflict}
      OR (r.id IS NOT NULL AND (a.run_started_at <> r.created_at OR a.source <> billing_usage_source(r.trigger_source)))))
      OR (r.id IS NOT NULL AND (r.org_id <> t.org_id OR r.user_id <> t.user_id))) AS conflict,
    ${current === "raw" ? "(t.status <> 'processed' AND (t.billing_anchor_at IS NULL OR t.billing_context NOT IN ('run', 'runless', 'pi_memory_stage1')))" : "false"} AS pending_anchor_gap,
    ${current === "raw" ? "($7::timestamp IS NOT NULL AND t.created_at >= $7::timestamp AND t.billing_context IN ('legacy_unknown', 'missing_run'))" : "false"} AS new_writer_gap,
    ${current === "jobs" ? "(t.status IN ('queued', 'running') AND t.billing_context = 'legacy_unknown' AND t.run_id IS NULL)" : "false"} AS pending_generation_gap
    FROM ${tables[current]} t
    LEFT JOIN billing_run_attribution a ON a.run_id = ${identity}
    LEFT JOIN agent_runs r ON r.id = ${identity}
    WHERE ${filter}`;
}
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: Math.min(maxMs, 5000),
});
const startedAt = performance.now();
function remainingMs() {
  return Math.max(1, Math.floor(maxMs - (performance.now() - startedAt)));
}
async function timeout() {
  assert.ok(
    performance.now() - startedAt < maxMs,
    "billing attribution time budget exhausted; resume the same checkpoint",
  );
  await client.query(
    "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)",
    [`${remainingMs()}ms`, `${Math.min(1000, remainingMs())}ms`],
  );
}
await client.connect();
try {
  if (!values.migrate) {
    await client.query("BEGIN READ ONLY");
    await timeout();
    const union = phases
      .filter((p) => {
        return p !== "done";
      })
      .map((p) => {
        return facts(p, predicate(p));
      })
      .join(" UNION ALL ");
    // LIMIT bounds the work set; a partial inventory can never certify readiness.
    const result = await client.query(
      `WITH parameters AS (SELECT $1::text, $2::text, $3::uuid, $4::uuid, $5::uuid[], $6::integer, $7::timestamp), inventory AS MATERIALIZED (
      ${union}
    ), bounded AS (SELECT * FROM inventory LIMIT $6)
    SELECT count(*)::int AS scanned,
      count(*) FILTER (WHERE eligible AND NOT conflict)::int AS eligible,
      count(*) FILTER (WHERE populated AND NOT conflict)::int AS populated,
      count(*) FILTER (WHERE missing_source)::int AS missing_source,
      count(*) FILTER (WHERE conflict)::int AS conflicts,
      count(*) FILTER (WHERE pending_anchor_gap)::int AS pending_anchor_gaps,
      count(*) FILTER (WHERE new_writer_gap)::int AS new_writer_gaps,
      count(*) FILTER (WHERE pending_generation_gap)::int AS pending_generation_gaps,
      ARRAY(SELECT DISTINCT billing_run_id FROM bounded WHERE conflict LIMIT 10) AS conflicting_run_ids
    FROM bounded`,
      [...scope, null, maxRows + 1, writerSince],
    );
    const row = record(result.rows[0]);
    const conflictingRunIds: unknown = row.conflicting_run_ids;
    assert.ok(
      Array.isArray(conflictingRunIds) &&
        conflictingRunIds.every((id: unknown) => {
          return typeof id === "string";
        }),
      "invalid conflict identifiers",
    );
    const counts = Object.fromEntries(
      Object.entries(row)
        .filter(([key]) => {
          return key !== "conflicting_run_ids";
        })
        .map(([key, value]) => {
          return [key, integer(value)];
        }),
    );
    await client.query("COMMIT");
    console.log(
      JSON.stringify({
        mode: "dry-run",
        scope,
        counts,
        conflictingRunIds,
        truncated: integer(row.scanned) > maxRows,
        writerCoverageSince: writerSince,
        activationReady: false,
        note: "A1 inventory only. A2 also requires closure/fencing, verified writer drain, no conflicts or pending anchor gaps, and a complete scoped inventory.",
      }),
    );
  } else {
    let scannedThisInvocation = 0;
    let lastCheckpoint: Record<string, unknown> | undefined;
    while (
      scannedThisInvocation < maxRows &&
      performance.now() - startedAt < maxMs
    ) {
      await client.query("BEGIN");
      try {
        await timeout();
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('vm0'), hashtext('usage_event_compaction'))",
        );
        await client.query(
          `INSERT INTO billing_attribution_backfill (id, org_id, user_id, run_from, run_through)
          VALUES ($5, $1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
          [...scope, jobId],
        );
        const checkpointResult = await client.query(
          "SELECT * FROM billing_attribution_backfill WHERE id = $1 FOR UPDATE",
          [jobId],
        );
        const checkpoint = record(checkpointResult.rows[0]);
        assert.deepEqual(
          [
            checkpoint.org_id,
            checkpoint.user_id,
            checkpoint.run_from,
            checkpoint.run_through,
          ],
          scope,
          "checkpoint scope cannot change",
        );
        const current = phase(checkpoint.phase);
        if (current === "done") {
          await client.query("COMMIT");
          lastCheckpoint = checkpoint;
          break;
        }
        const limit = Math.min(batchSize, maxRows - scannedThisInvocation);
        await timeout();
        // FK checks by concurrent usage writers take KEY SHARE on the run.
        // NO KEY UPDATE protects its source fields without blocking that check.
        const sourceLock = current === "runs" ? "NO KEY UPDATE" : "UPDATE";
        const idsResult = await client.query(
          `SELECT t.id FROM ${tables[current]} t WHERE ${predicate(current)}
          AND ($5::uuid IS NULL OR t.id > $5::uuid) ORDER BY t.id LIMIT $6 FOR ${sourceLock} OF t`,
          [...scope, nullableText(checkpoint.cursor), limit],
        );
        const ids = idsResult.rows.map((value: unknown) => {
          const id = record(value).id;
          assert.equal(typeof id, "string");
          assert.ok(typeof id === "string");
          return id;
        });
        let populated = 0;
        if (ids.length > 0) {
          await timeout();
          const result =
            current === "runs"
              ? await client.query(
                  `INSERT INTO billing_run_attribution (run_id, org_id, user_id, run_started_at, source)
                SELECT id, org_id, user_id, created_at, billing_usage_source(trigger_source) FROM agent_runs WHERE id = ANY($1::uuid[])
                ON CONFLICT (run_id) DO NOTHING`,
                  [ids],
                )
              : await client.query(
                  `UPDATE ${tables[current]} t SET billing_run_id = COALESCE(t.billing_run_id, t.run_id), billing_context = 'run'
                WHERE t.id = ANY($1::uuid[]) AND t.billing_context NOT IN ('run', 'runless', 'pi_memory_stage1')
                  AND EXISTS (SELECT 1 FROM billing_run_attribution a WHERE a.run_id = COALESCE(t.billing_run_id, t.run_id)
                    AND a.org_id = t.org_id AND a.user_id = t.user_id)
                  AND NOT EXISTS (SELECT 1 FROM agent_runs r JOIN billing_run_attribution a ON a.run_id = r.id
                    WHERE r.id = COALESCE(t.billing_run_id, t.run_id)
                      AND (r.org_id <> t.org_id OR r.user_id <> t.user_id OR r.created_at <> a.run_started_at OR billing_usage_source(r.trigger_source) <> a.source))`,
                  [ids],
                );
          populated = integer(result.rowCount);
        }
        await timeout();
        const countResult = await client.query(
          `WITH parameters AS (SELECT $1::text, $2::text, $3::uuid, $4::uuid, $5::uuid[], $6::integer, $7::timestamp), facts AS (${facts(current, "t.id = ANY($5::uuid[])")})
          SELECT count(*) FILTER (WHERE missing_source)::int AS missing_source, count(*) FILTER (WHERE conflict)::int AS conflicts FROM facts`,
          [...scope, ids, null, writerSince],
        );
        const counts = record(countResult.rows[0]);
        const nextPhase =
          ids.length < limit ? phases[phases.indexOf(current) + 1] : current;
        await timeout();
        const update = await client.query(
          `UPDATE billing_attribution_backfill SET phase=$2, cursor=$3,
          scanned=scanned+$4, populated=populated+$5, missing_source=missing_source+$6, conflicts=conflicts+$7,
          updated_at=timezone('UTC', clock_timestamp()) WHERE id=$1 RETURNING *`,
          [
            jobId,
            nextPhase,
            nextPhase === current ? ids.at(-1) : null,
            ids.length,
            populated,
            integer(counts.missing_source),
            integer(counts.conflicts),
          ],
        );
        lastCheckpoint = record(update.rows[0]);
        await client.query("COMMIT");
        scannedThisInvocation += ids.length;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    console.log(
      JSON.stringify({
        mode: "migrate",
        jobId,
        scannedThisInvocation,
        checkpoint: lastCheckpoint,
        activationReady: false,
        note: "Checkpoint counters describe committed batch work, not a consistent census. Run a complete dry-run inventory after convergence.",
      }),
    );
  }
} finally {
  await client.end();
}
