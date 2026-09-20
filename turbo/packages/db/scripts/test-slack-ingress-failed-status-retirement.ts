import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");

const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `slack_ingress_failed_retirement_${randomUUID().replaceAll("-", "")}`;
const before = "2026-01-01 00:00:00";
const retryAt = "2026-01-01 00:05:00";

async function expectCheckViolation(statement: string): Promise<void> {
  await client.query("SAVEPOINT expected_check_violation");
  try {
    await assert.rejects(client.query(statement), (error: unknown) => {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23514"
      );
    });
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_check_violation");
    await client.query("RELEASE SAVEPOINT expected_check_violation");
  }
}

function insertIngress(
  id: string,
  status: string,
  options: {
    readonly lastErrorClass?: string;
    readonly retryAt?: string;
  } = {},
): string {
  return `
    INSERT INTO slack_chat_ingress (
      id, route_id, event_id, payload, public_brand, status,
      retry_count, processing_attempt_count, retry_at, last_error_class,
      last_error, created_at, updated_at
    ) VALUES (
      '${id}', '${randomUUID()}', 'Ev_${id}', '{"type":"event_callback"}', 'okou',
      '${status}', 1, 3,
      ${options.retryAt === undefined ? "NULL" : `'${options.retryAt}'`},
      ${options.lastErrorClass === undefined ? "NULL" : `'${options.lastErrorClass}'`},
      'boom', '${before}', '${before}'
    )
  `;
}

try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  // The shape shipped by 1162_slack_ingress_retry_policy, where `failed` is
  // still an accepted status.
  await client.query(`
    CREATE TABLE slack_chat_ingress (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      route_id uuid NOT NULL,
      event_id varchar(255) NOT NULL,
      payload text NOT NULL,
      public_brand text NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'pending',
      retry_count integer NOT NULL DEFAULT 0,
      processing_attempt_count integer NOT NULL DEFAULT 0,
      retry_at timestamp,
      last_error_class varchar(128),
      last_error text,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT chk_slack_chat_ingress_retry_count CHECK (retry_count >= 0),
      CONSTRAINT chk_slack_chat_ingress_processing_attempt_count CHECK (processing_attempt_count >= 0),
      CONSTRAINT chk_slack_chat_ingress_status CHECK (status IN ('pending', 'processing', 'retryable', 'processed', 'failed', 'terminal'))
    );

    CREATE UNIQUE INDEX idx_slack_chat_ingress_event_id ON slack_chat_ingress USING btree (event_id);
    CREATE INDEX idx_slack_chat_ingress_retry_sweep ON slack_chat_ingress USING btree (status, retry_at, updated_at);
  `);

  await client.query(
    insertIngress("00000000-0000-4000-8000-000000000001", "failed", {
      retryAt,
    }),
  );
  await client.query(
    insertIngress("00000000-0000-4000-8000-000000000002", "failed", {
      lastErrorClass: "slack:invalid_auth",
    }),
  );
  await client.query(
    insertIngress("00000000-0000-4000-8000-000000000003", "pending"),
  );
  await client.query(
    insertIngress("00000000-0000-4000-8000-000000000004", "retryable", {
      lastErrorClass: "slack:ratelimited",
      retryAt,
    }),
  );
  await client.query(
    insertIngress("00000000-0000-4000-8000-000000000005", "processing"),
  );
  await client.query(
    insertIngress("00000000-0000-4000-8000-000000000006", "processed"),
  );
  await client.query(
    insertIngress("00000000-0000-4000-8000-000000000007", "terminal", {
      lastErrorClass: "attempts_exhausted",
    }),
  );

  const survivorsBefore = (
    await client.query(
      `
        SELECT to_jsonb(record) AS value
        FROM slack_chat_ingress AS record
        WHERE status <> 'failed'
        ORDER BY id
      `,
    )
  ).rows;
  const sweepIndexBefore = (
    await client.query(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_slack_chat_ingress_retry_sweep'",
    )
  ).rows[0]?.indexdef;
  assert.ok(sweepIndexBefore);

  const migration = await readFile(
    new URL(
      "../src/migrations/1179_retire_slack_ingress_failed_status.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await client.query(migration);

  assert.deepEqual(
    (
      await client.query<{
        createdAt: string;
        id: string;
        lastError: string | null;
        lastErrorClass: string | null;
        processingAttemptCount: number;
        retryAt: string | null;
        retryCount: number;
        status: string;
        updatedAt: string;
      }>(`
        SELECT
          id::text,
          status,
          retry_count AS "retryCount",
          processing_attempt_count AS "processingAttemptCount",
          retry_at::text AS "retryAt",
          last_error_class AS "lastErrorClass",
          last_error AS "lastError",
          created_at::text AS "createdAt",
          updated_at::text AS "updatedAt"
        FROM slack_chat_ingress
        WHERE id IN (
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000002'
        )
        ORDER BY id
      `)
    ).rows,
    [
      {
        id: "00000000-0000-4000-8000-000000000001",
        status: "terminal",
        retryCount: 1,
        processingAttemptCount: 3,
        retryAt: null,
        lastErrorClass: "legacy_terminal_failure",
        lastError: "boom",
        createdAt: before,
        updatedAt: before,
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        status: "terminal",
        retryCount: 1,
        processingAttemptCount: 3,
        retryAt: null,
        lastErrorClass: "legacy_terminal_failure",
        lastError: "boom",
        createdAt: before,
        updatedAt: before,
      },
    ],
  );

  assert.deepEqual(
    (
      await client.query(
        `
          SELECT to_jsonb(record) AS value
          FROM slack_chat_ingress AS record
          WHERE id NOT IN (
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000002'
          )
          ORDER BY id
        `,
      )
    ).rows,
    survivorsBefore,
  );

  const statusConstraint = (
    await client.query<{
      definition: string;
      name: string;
      validated: boolean;
    }>(`
      SELECT conname AS name, convalidated AS validated, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'chk_slack_chat_ingress_status'
        AND connamespace = '${schema}'::regnamespace
    `)
  ).rows;
  assert.equal(statusConstraint.length, 1);
  assert.equal(statusConstraint[0]?.validated, true);
  assert.ok(statusConstraint[0]?.definition.includes("'terminal'"));
  assert.ok(!statusConstraint[0]?.definition.includes("'failed'"));
  assert.equal(
    (
      await client.query(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_slack_chat_ingress_retry_sweep'",
      )
    ).rows[0]?.indexdef,
    sweepIndexBefore,
  );

  await expectCheckViolation(
    insertIngress("00000000-0000-4000-8000-000000000008", "failed"),
  );
  await expectCheckViolation(
    "UPDATE slack_chat_ingress SET status = 'failed' WHERE id = '00000000-0000-4000-8000-000000000003'",
  );
  const canonicalStatuses = [
    "pending",
    "processing",
    "retryable",
    "processed",
    "terminal",
  ] as const;
  for (const [offset, status] of canonicalStatuses.entries()) {
    await client.query(
      insertIngress(`00000000-0000-4000-8000-00000000010${offset}`, status),
    );
  }

  console.log(
    "✅ stranded failed Slack ingress rows become terminal with legacy_terminal_failure and no retry_at",
  );
  console.log(
    "✅ the re-added validated status constraint rejects failed and keeps the five canonical statuses",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
