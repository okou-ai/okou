import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { storedExecutionContextSchema } from "@okouai/api-contracts/contracts/runners";
import postgres from "postgres";
import {
  array,
  json,
  number,
  object,
  record,
  string,
  unknown,
  uuid,
} from "zod";
import { applyPendingMigrations } from "./migration-runner";

/** Verify the real JSON migration against retained rows and explicit writers. */
export async function validatePreviewBypassAuthorizationBackfill(
  databaseUrl: string,
): Promise<void> {
  const tag = "1541_backfill_preview_bypass_authorization";
  const journal = object({
    entries: array(object({ tag: string(), when: number() })),
  }).parse(
    JSON.parse(
      await readFile(
        new URL("../src/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const migration = journal.entries.find((entry) => {
    return entry.tag === tag;
  });
  assert.ok(migration);
  const migrationSql = await readFile(
    new URL(`../src/migrations/${tag}.sql`, import.meta.url),
    "utf8",
  );
  const name = `preview_receipt_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const admin = postgres(databaseUrl, { max: 1 });
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    created = true;
    const sql = postgres(url.toString(), { max: 1 });
    const writer = postgres(url.toString(), { max: 1 });
    try {
      await applyPendingMigrations(sql, { beforeMillis: migration.when });
      const base = {
        nativeContinuation: {
          sessionId: null,
          generationRunId: null,
          recoveryPrompt: null,
        },
        platformEnvironment: {
          OKOU_DISABLED_PAID_TOOLS: "[]",
          OKOU_TOKEN: "retained-authorization-token",
        },
        featureFlags: { singleAgent: true, connectorChatAccountAccess: false },
        retainedSnapshot: { value: "preserve this unrelated JSON" },
      };
      const expected = new Map<string, Record<string, unknown>>();
      const insert = async (
        extra: Record<string, unknown>,
        authorized: boolean,
        orgId: string,
      ) => {
        const id = randomUUID();
        const context = { ...base, ...extra };
        await writer`
          INSERT INTO agent_runs (id, user_id, org_id, status, prompt)
          VALUES (${id}, 'receipt-owner', ${orgId}, 'pending', 'retained prompt')
        `;
        await writer`
          INSERT INTO runner_job_queue
            (run_id, runner_group, profile, session_id, reuse_key, execution_context, created_at, discovery_started_at, expires_at)
          VALUES (${id}, 'receipt-group', 'vm0/default', 'retained-session', 'retained-reuse',
            ${writer.json(json().parse(context))}, '2026-11-01', '2026-11-02', '2100-01-01')
        `;
        expected.set(id, { ...context, previewBypassAuthorized: authorized });
        return id;
      };
      const legacy = (value: unknown) => {
        return {
          ...base.platformEnvironment,
          VERCEL_AUTOMATION_BYPASS_SECRET: value,
        };
      };
      await insert(
        { platformEnvironment: legacy("old-secret") },
        true,
        "receipt-baseline",
      );
      await insert(
        { platformEnvironment: legacy("") },
        false,
        "receipt-baseline",
      );
      await insert({}, false, "receipt-baseline");
      await insert({ previewBypassAuthorized: true }, true, "receipt-baseline");
      await insert(
        {
          previewBypassAuthorized: false,
          platformEnvironment: legacy("old-secret"),
        },
        false,
        "receipt-baseline",
      );
      const queueState = async () => {
        return array(
          object({
            runId: uuid(),
            context: record(string(), unknown()),
            metadata: record(string(), unknown()),
          }),
        ).parse(
          await sql`
          SELECT run_id AS "runId", execution_context AS context,
            to_jsonb(runner_job_queue) - 'execution_context' AS metadata
          FROM runner_job_queue ORDER BY run_id
        `,
        );
      };
      const businessState = async () => {
        return JSON.stringify(
          Array.from(
            await sql`
          SELECT to_jsonb(agent_runs) FROM agent_runs
          WHERE org_id = 'receipt-baseline' ORDER BY id
        `,
          ),
        );
      };
      const journalState = async () => {
        return JSON.stringify(
          Array.from(
            await sql`
          SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id
        `,
          ),
        );
      };
      for (const malformed of [
        { previewBypassAuthorized: null },
        { platformEnvironment: legacy(1) },
      ]) {
        const id = await insert(malformed, false, "receipt-malformed");
        const before = await queueState();
        const beforeJournal = await journalState();
        await assert.rejects(
          applyPendingMigrations(sql, { beforeMillis: migration.when + 1 }),
          /Invalid queued preview bypass authorization receipt/u,
        );
        assert.deepEqual(await queueState(), before);
        assert.equal(await journalState(), beforeJournal);
        await sql`DELETE FROM runner_job_queue WHERE run_id = ${id}`;
        await sql`DELETE FROM agent_runs WHERE id = ${id}`;
        expected.delete(id);
      }
      const before = await queueState();
      const beforeRuns = await businessState();
      await Promise.all([
        applyPendingMigrations(sql, { beforeMillis: migration.when + 1 }),
        insert(
          {
            previewBypassAuthorized: false,
            platformEnvironment: legacy("old-secret"),
          },
          false,
          "receipt-concurrent",
        ),
      ]);
      await insert({ previewBypassAuthorized: true }, true, "receipt-after");
      const after = await queueState();
      assert.equal(after.length, expected.size);
      for (const row of after) {
        assert.deepEqual(row.context, expected.get(row.runId));
        assert.equal(
          storedExecutionContextSchema.safeParse(row.context).success,
          true,
        );
        const previous = before.find((item) => {
          return item.runId === row.runId;
        });
        if (previous) assert.deepEqual(row.metadata, previous.metadata);
      }
      assert.equal(await businessState(), beforeRuns);
      await sql.unsafe(migrationSql);
      assert.deepEqual(await queueState(), after);
      await applyPendingMigrations(sql, { beforeMillis: migration.when + 1 });
      assert.deepEqual(await queueState(), after);
      console.log(
        "Preview receipt backfill preserves authorization, metadata and concurrent explicit writes",
      );
    } finally {
      try {
        await writer.end();
      } finally {
        await sql.end();
      }
    }
  } finally {
    try {
      if (created) await admin.unsafe(`DROP DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
  }
}
