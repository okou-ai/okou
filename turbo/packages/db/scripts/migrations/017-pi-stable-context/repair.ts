#!/usr/bin/env tsx
import { parseArgs } from "node:util";

import { Client } from "pg";

type HeadStatus =
  | "missing"
  | "pending"
  | "running"
  | "ready"
  | "unindexable"
  | "failed";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error("missing_configuration");
  }
  return value;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      migrate: { type: "boolean", default: false },
      "max-heads": { type: "string", default: "1000" },
      "after-head": { type: "string" },
    },
    strict: true,
  });
  const limit = Number(values["max-heads"]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error("invalid_limit");
  }
  let cursor = values["after-head"] ?? null;
  if (cursor !== null && !/^[0-9a-f-]{36}$/u.test(cursor)) {
    throw new Error("invalid_cursor");
  }
  const counts: Record<HeadStatus | "retryable" | "requeued", number> = {
    missing: 0,
    pending: 0,
    running: 0,
    ready: 0,
    unindexable: 0,
    failed: 0,
    retryable: 0,
    requeued: 0,
  };
  let processed = 0;
  let complete = false;
  const client = new Client({ connectionString: requiredEnv("DATABASE_URL") });
  try {
    await client.connect();
    if (!values.migrate) {
      await client.query("SET default_transaction_read_only = on");
    }
    await client.query("SET statement_timeout = '10s'");
    await client.query("SET lock_timeout = '1s'");
    while (processed < limit) {
      const page = await client.query<{
        id: string;
        status: HeadStatus;
        retryable: boolean;
      }>(
        `SELECT id, status,
          ((status = 'failed' OR
            (status = 'running' AND lease_expires_at <= now())) AND
           input IS NOT NULL AND input_digest IS NOT NULL AND attempt_count < 5)
          AS retryable
        FROM pi_stable_context_heads
        WHERE ($1::uuid IS NULL OR id > $1)
        ORDER BY id
        LIMIT $2`,
        [cursor, Math.min(100, limit - processed)],
      );
      if (page.rows.length === 0) {
        complete = true;
        break;
      }
      for (const row of page.rows) {
        counts[row.status] += 1;
        if (row.retryable) {
          counts.retryable += 1;
          if (values.migrate) {
            const repaired = await client.query(
              `UPDATE pi_stable_context_heads
               SET status = 'pending', lease_id = NULL,
                   lease_expires_at = NULL, available_at = now(),
                   last_error_class = NULL, updated_at = now()
               WHERE id = $1 AND
                 (status = 'failed' OR
                  (status = 'running' AND lease_expires_at <= now())) AND
                 input IS NOT NULL AND input_digest IS NOT NULL AND
                 attempt_count < 5`,
              [row.id],
            );
            counts.requeued += repaired.rowCount ?? 0;
          }
        }
        processed += 1;
        cursor = row.id;
      }
      console.log(
        JSON.stringify({
          mode: values.migrate ? "migrate" : "dry-run",
          processed,
          counts,
          cursor,
          complete: false,
        }),
      );
    }
    if (!complete) {
      const remaining = await client.query(
        "SELECT 1 FROM pi_stable_context_heads WHERE id > $1 LIMIT 1",
        [cursor],
      );
      complete = remaining.rows.length === 0;
    }
    console.log(
      JSON.stringify({
        mode: values.migrate ? "migrate" : "dry-run",
        processed,
        counts,
        cursor,
        complete,
      }),
    );
  } finally {
    await client.end();
  }
}

// SQL/provider errors can include private identifiers. Keep the public failure
// stable and investigate detailed logs only in the authorized environment.
main().catch(() => {
  console.error(
    "Pi stable-context repair failed; retain the last completed cursor and investigate privately.",
  );
  process.exitCode = 1;
});
