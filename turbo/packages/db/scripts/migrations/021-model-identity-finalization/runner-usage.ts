import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { z } from "zod";
import { createApp } from "../../../../../apps/api/src/app-factory";
import { closeDbPool } from "../../../../../apps/api/src/lib/db";
import { clearMockNow, mockNow } from "../../../../../apps/api/src/lib/time";
import { generateSandboxToken } from "../../../../../apps/api/src/signals/auth/tokens";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../../../../../apps/api/src/signals/routes/webhooks-agent-health-usage-telemetry";

// Migration compatibility uses the real authenticated HTTP entry point and
// disposable PostgreSQL. The parent owns the outgoing-schema historical rows.
globalThis.fetch = () => {
  throw new Error("migration_test_external_http_disabled");
};
const runId = z.uuid().parse(process.argv[2]);
const expectedProvider = z.string().min(1).parse(process.argv[3]);
const db = new Client({
  connectionString: process.env.DATABASE_URL,
  statement_timeout: 10_000,
});
const owner = new AbortController();
const app = createApp({
  signal: owner.signal,
  routes: webhooksAgentHealthUsageTelemetryRoutes.filter((entry) => {
    return entry.route.path === "/api/webhooks/agent/usage-event";
  }),
});
try {
  await db.connect();
  const identity = z
    .object({
      user_id: z.string(),
      org_id: z.string(),
      status: z.literal("cancelled"),
    })
    .parse(
      (
        await db.query(
          "SELECT user_id,org_id,status FROM agent_runs WHERE id=$1",
          [runId],
        )
      ).rows[0],
    );
  mockNow(new Date("2026-01-01T00:00:00Z"));
  const expiredToken = generateSandboxToken(
    identity.user_id,
    runId,
    identity.org_id,
  );
  clearMockNow();
  const token = generateSandboxToken(identity.user_id, runId, identity.org_id);
  const events = ["tokens.input", "tokens.input.long_context"].map(
    (category) => {
      return {
        idempotencyKey: randomUUID(),
        kind: "model" as const,
        provider: "okou-1.0-max",
        category,
        quantity: 1,
      };
    },
  );
  const send = async (authorization: string) => {
    return await app.request("/api/webhooks/agent/usage-event", {
      method: "POST",
      headers: {
        authorization: `Bearer ${authorization}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ runId, events }),
    });
  };
  assert.equal(
    (await send(expiredToken)).status,
    401,
    "expired_runner_rejected",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer AS rows FROM usage_event WHERE idempotency_key=ANY($1::uuid[])",
        [
          events.map((event) => {
            return event.idempotencyKey;
          }),
        ],
      )
    ).rows[0].rows,
    0,
    "expired_token_does_not_write",
  );
  assert.equal(
    (await send(token)).status,
    200,
    "cancelled_run_accepts_valid_report",
  );
  assert.equal((await send(token)).status, 200, "replay_accepted");
  const records = z
    .array(
      z.object({
        provider: z.string(),
        category: z.string(),
        records: z.number().int(),
      }),
    )
    .parse(
      (
        await db.query(
          "SELECT provider,category,count(*)::integer AS records FROM usage_event WHERE idempotency_key=ANY($1::uuid[]) GROUP BY provider,category ORDER BY category",
          [
            events.map((event) => {
              return event.idempotencyKey;
            }),
          ],
        )
      ).rows,
    );
  assert.deepEqual(
    records,
    events.map((event) => {
      return {
        provider: expectedProvider,
        category: event.category,
        records: 1,
      };
    }),
  );
  console.log(
    "authenticated cancelled Runner usage: expiry, captured identity, unchanged categories and deduplication passed",
  );
} finally {
  clearMockNow();
  owner.abort();
  await closeDbPool();
  await db.end();
}
