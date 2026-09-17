#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import postgres from "postgres";
import {
  createErasureJournal,
  type JournalAppend,
} from "../src/erasure-journal/client";
import { migrateErasureJournal } from "../src/erasure-journal/migrate";
import { projectErasureDecision } from "../src/operations/account-erasure";
import { accountErasureJobs as jobs } from "../src/schema/account-erasure";
import { applyPendingMigrations } from "./migration-runner";

// Explicit external-behavior exception: this dormant package has no HTTP,
// worker or trusted ingress. Exercise its actual exported persistence contract
// and B1 against two freshly created databases. Locks, corruption and restart
// are infrastructure fixtures; no database, B1 operation or receipt is mocked.
assert.ok(
  process.env.DATABASE_URL,
  "DATABASE_URL must name a development PG server",
);
const developmentUrl = new URL(process.env.DATABASE_URL);
assert.ok(
  ["localhost", "127.0.0.1", "postgres"].includes(developmentUrl.hostname),
  "Journal integration tests require local PostgreSQL",
);
const admin = new Client({ connectionString: developmentUrl.toString() });
await admin.connect();
const suffix = randomUUID().replaceAll("-", "");
const controlName = `journal_control_${suffix}`;
const applicationName = `journal_application_${suffix}`;
function databaseUrl(name: string): string {
  const url = new URL(developmentUrl);
  url.pathname = `/${name}`;
  return url.toString();
}
const controlUrl = databaseUrl(controlName);
const applicationUrl = databaseUrl(applicationName);
const authorityId = randomUUID();
const clients: ReturnType<typeof createErasureJournal>[] = [];
function journal(name: string = randomUUID(), authority: string = authorityId) {
  const url = new URL(controlUrl);
  url.searchParams.set("application_name", name);
  const client = createErasureJournal(url.toString(), authority);
  clients.push(client);
  return client;
}
const appPool = new Pool({ connectionString: applicationUrl });
const app = drizzle(appPool);
const observer = new Client({ connectionString: controlUrl });
const blocker = new Client({ connectionString: controlUrl });
const execFileAsync = promisify(execFile);
function input(overrides: Partial<JournalAppend> = {}): JournalAppend {
  return {
    subjectKind: "user",
    subjectId: `synthetic_${randomUUID()}`,
    generation: 1,
    decisionRef: randomUUID(),
    confirmationRef: randomUUID(),
    previousDecisionRef: null,
    dispositionVersion: 1,
    requestedAt: new Date("2020-01-01T00:00:00.123Z"),
    deadlineAt: new Date("2099-01-01T00:00:00.456Z"),
    ...overrides,
  };
}
async function blocked(name: string) {
  // Observe a real lock wait, never assume an elapsed delay scheduled the writer.
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await observer.query(
      "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
      [name],
    );
    if (result.rowCount === 1) return;
    await setTimeout(2);
  }
  assert.fail(`writer ${name} never reached its lock boundary`);
}

try {
  await admin.query(`CREATE DATABASE "${controlName}"`);
  await admin.query(`CREATE DATABASE "${applicationName}"`);
  await observer.connect();
  await blocker.connect();
  const mainConnection = postgres(applicationUrl, { max: 1 });
  try {
    await applyPendingMigrations(mainConnection);
  } finally {
    await mainConnection.end();
  }
  const store = journal();

  await test("explicit installation, independent migration replay and empty watermark", async () => {
    assert.throws(() => {
      return createErasureJournal("", authorityId);
    }, /connection_required/);
    assert.throws(() => {
      return createErasureJournal("postgresql://localhost", authorityId);
    }, /invalid_connection/);
    await assert.rejects(store.readWatermark());
    assert.equal(
      (
        await observer.query(
          "SELECT to_regclass('erasure_journal_head') AS name",
        )
      ).rows[0].name,
      null,
    );
    await migrateErasureJournal(controlUrl);
    await migrateErasureJournal(controlUrl);
    assert.equal(
      (
        await observer.query(
          "SELECT count(*)::int AS count FROM erasure_journal_migrations.__drizzle_migrations",
        )
      ).rows[0].count,
      1,
    );
    assert.equal(
      (
        await observer.query(
          "SELECT to_regclass('account_erasure_jobs') AS name",
        )
      ).rows[0].name,
      null,
    );
    assert.equal(
      (
        await appPool.query(
          "SELECT to_regclass('erasure_journal_head') AS name",
        )
      ).rows[0].name,
      null,
    );
    const watermark = await store.readWatermark();
    assert.deepEqual(watermark, { authorityId, sequence: 0n });
    assert.deepEqual(
      await store.readPage({ afterSequence: 0n, watermark, limit: 1 }),
      {
        decisions: [],
        watermark,
        nextAfterSequence: 0n,
        done: true,
      },
    );
  });

  await test("concurrent first append and exact retries preserve all decision fields", async () => {
    const request = input();
    const [first, retry] = await Promise.all([
      store.append(request),
      journal().append(request),
    ]);
    assert.deepEqual(first, retry);
    assert.deepEqual(first, { ...request, authorityId, decisionSequence: 1n });
    const restarted = journal();
    assert.deepEqual(await restarted.append(request), first);
    assert.equal((await restarted.readWatermark()).sequence, 1n);
    for (const changed of [
      { decisionRef: randomUUID() },
      { confirmationRef: randomUUID() },
      { subjectId: `${request.subjectId}X` },
      { subjectKind: "organization" as const },
      { generation: 2 },
      { previousDecisionRef: randomUUID() },
      { dispositionVersion: 2 },
      { requestedAt: new Date("2020-01-02") },
      { deadlineAt: new Date("2098-01-01") },
    ]) {
      await assert.rejects(
        store.append({ ...request, ...changed }),
        /conflicting_decision/,
      );
    }
    await assert.rejects(
      journal(randomUUID(), randomUUID()).append(input()),
      /authority_mismatch/,
    );
    assert.equal((await store.readWatermark()).sequence, 1n);
  });

  await test("subject domains, case-sensitive identities and a single predecessor chain", async () => {
    const subjectId = `Synthetic_${randomUUID()}`;
    const request = input({ subjectId });
    const races = await Promise.allSettled([
      store.append(request),
      journal().append(input({ subjectId })),
    ]);
    assert.equal(
      races.filter((r) => {
        return r.status === "fulfilled";
      }).length,
      1,
    );
    const first = races.find((r) => {
      return r.status === "fulfilled";
    });
    assert.ok(first && first.status === "fulfilled");
    const root = first.value;
    const nextInput = input({
      subjectId,
      generation: 3,
      previousDecisionRef: root.decisionRef,
    });
    const next = await store.append(nextInput);
    assert.ok(next.decisionSequence > root.decisionSequence);
    assert.deepEqual(await store.append(root), root);
    const advances = await Promise.allSettled([
      store.append(
        input({
          subjectId,
          generation: 4,
          previousDecisionRef: next.decisionRef,
        }),
      ),
      journal().append(
        input({
          subjectId,
          generation: 5,
          previousDecisionRef: next.decisionRef,
        }),
      ),
    ]);
    assert.equal(
      advances.filter((result) => {
        return result.status === "fulfilled";
      }).length,
      1,
    );
    await assert.rejects(
      store.append(
        input({
          subjectId,
          generation: 4,
          previousDecisionRef: root.decisionRef,
        }),
      ),
      /stale_decision/,
    );
    await assert.rejects(
      store.append(
        input({
          subjectId,
          generation: 3,
          previousDecisionRef: next.decisionRef,
        }),
      ),
      /stale_decision/,
    );
    await assert.rejects(
      store.append(input({ previousDecisionRef: next.decisionRef })),
      /missing_predecessor/,
    );
    const org = await store.append(
      input({ subjectKind: "organization", subjectId }),
    );
    const lower = await store.append(
      input({ subjectId: subjectId.toLowerCase() }),
    );
    assert.equal(org.subjectId, subjectId);
    assert.notEqual(lower.subjectId, subjectId);
    assert.equal(org.subjectKind, "organization");
    // B1 permits a positive initial generation and strictly advancing gaps.
    assert.equal((await projectErasureDecision(app, root)).generation, 1);
    assert.equal((await projectErasureDecision(app, next)).generation, 3);
    assert.equal(
      (await projectErasureDecision(app, org)).subjectKind,
      "organization",
    );
    assert.equal(
      (await projectErasureDecision(app, lower)).subjectId,
      subjectId.toLowerCase(),
    );
  });

  await test("canonical references, bounded versions, subject bytes and deadlines fail before append", async () => {
    const before = await store.readWatermark();
    const request = input();
    for (const invalid of [
      { decisionRef: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" },
      { confirmationRef: "not-a-uuid" },
      { decisionRef: `${request.decisionRef}\n` },
      { confirmationRef: `${request.confirmationRef}\n` },
      { previousDecisionRef: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" },
      { generation: 0 },
      { generation: 2_147_483_648 },
      { generation: 1.5 },
      { dispositionVersion: 0 },
      { subjectId: "" },
      { subjectId: "界".repeat(65) },
      { subjectId: "a\0b" },
      { requestedAt: new Date("invalid") },
      { deadlineAt: request.requestedAt },
    ]) {
      await assert.rejects(
        store.append({ ...request, ...invalid }),
        /erasure_journal:invalid_/,
      );
    }
    assert.deepEqual(await store.readWatermark(), before);
    const exactBytes = await store.append(
      input({ subjectId: "界".repeat(64) }),
    );
    assert.equal(Buffer.byteLength(exactBytes.subjectId), 192);
  });

  for (const rollback of [false, true]) {
    await test(`head lock enforces commit order and invisibility with rollback=${rollback}`, async () => {
      const before = await store.readWatermark();
      const aName = `journal_a_${randomUUID()}`;
      const bName = `journal_b_${randomUUID()}`;
      const a = journal(aName);
      const b = journal(bName);
      // Hold A inside the actual append, after INSERT and before head UPDATE.
      // B then waits on A's authority-head row, not on a test callback in code.
      await observer.query(`CREATE FUNCTION journal_test_gate() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF current_setting('application_name') = '${aName}' THEN
            PERFORM pg_advisory_xact_lock(34205);
            ${rollback ? "RAISE EXCEPTION 'synthetic rollback' USING ERRCODE = '23514';" : ""}
          END IF;
          RETURN NEW;
        END $$`);
      await observer.query(
        "CREATE TRIGGER journal_test_gate BEFORE UPDATE ON erasure_journal_head FOR EACH ROW EXECUTE FUNCTION journal_test_gate()",
      );
      await blocker.query("SELECT pg_advisory_lock(34205)");
      const aInput = input();
      const bInput = input();
      const aResult = a.append(aInput).then(
        (value) => {
          return { status: "committed" as const, value };
        },
        (error: unknown) => {
          return { status: "failed" as const, error };
        },
      );
      let bResult: ReturnType<typeof b.append> | undefined;
      try {
        await blocked(aName);
        bResult = b.append(bInput);
        await blocked(bName);
        assert.deepEqual(await store.readWatermark(), before);
        const page = await store.readPage({
          afterSequence: before.sequence,
          watermark: before,
          limit: 10,
        });
        assert.deepEqual(page.decisions, []);
        await assert.rejects(
          store.readPage({
            afterSequence: before.sequence,
            watermark: { ...before, sequence: before.sequence + 1n },
            limit: 10,
          }),
          /future_watermark/,
        );
      } finally {
        await blocker.query("SELECT pg_advisory_unlock(34205)");
        const result = await aResult;
        const second = bResult ? await bResult : undefined;
        await observer.query(
          "DROP TRIGGER journal_test_gate ON erasure_journal_head",
        );
        await observer.query("DROP FUNCTION journal_test_gate()");
        assert.ok(second);
        assert.equal(result.status, rollback ? "failed" : "committed");
        if (result.status === "committed")
          assert.equal(result.value.decisionSequence, before.sequence + 1n);
        assert.equal(
          second.decisionSequence,
          before.sequence + (rollback ? 1n : 2n),
        );
      }
      if (rollback) {
        const replay = await store.append(aInput);
        assert.equal(replay.decisionSequence, before.sequence + 2n);
        assert.equal(replay.decisionRef, aInput.decisionRef);
      }
    });
  }

  await test("bounded serialization and deadlock retries; failures cannot return authority receipts", async () => {
    const before = await store.readWatermark();
    for (const sqlstate of ["40001", "40P01", "23514"]) {
      await observer.query("CREATE SEQUENCE journal_test_attempts");
      // nextval is used solely to count rolled-back test attempts, never ordering.
      await observer.query(`CREATE FUNCTION journal_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM nextval('journal_test_attempts');
          RAISE EXCEPTION 'synthetic transaction failure' USING ERRCODE = '${sqlstate}';
        END $$`);
      await observer.query(
        "CREATE TRIGGER journal_test_fail BEFORE INSERT ON erasure_journal_decisions FOR EACH ROW EXECUTE FUNCTION journal_test_fail()",
      );
      const request = input();
      try {
        await assert.rejects(store.append(request));
        assert.deepEqual(await store.readWatermark(), before);
        const attempts = await observer.query(
          "SELECT last_value::int AS attempts FROM journal_test_attempts",
        );
        assert.equal(attempts.rows[0].attempts, sqlstate === "23514" ? 1 : 5);
      } finally {
        await observer.query(
          "DROP TRIGGER journal_test_fail ON erasure_journal_decisions",
        );
        await observer.query("DROP FUNCTION journal_test_fail()");
        await observer.query("DROP SEQUENCE journal_test_attempts");
      }
    }
    const unavailableUrl = new URL(controlUrl);
    unavailableUrl.pathname = `/journal_missing_${suffix}`;
    const unavailable = createErasureJournal(
      unavailableUrl.toString(),
      authorityId,
    );
    clients.push(unavailable);
    await assert.rejects(unavailable.append(input()));
    assert.deepEqual(await store.readWatermark(), before);
  });

  await test("keyset replay pins a watermark across appends, process restart and invalid cursors", async () => {
    const begin = await store.readWatermark();
    const appended = [];
    for (let i = 0; i < 7; i++) appended.push(await store.append(input()));
    const watermark = await store.readWatermark();
    const first = await store.readPage({
      afterSequence: begin.sequence,
      watermark,
      limit: 2,
    });
    assert.equal(first.done, false);
    await store.append(input());
    const restarted = journal();
    assert.deepEqual(
      await restarted.readPage({
        afterSequence: begin.sequence,
        watermark,
        limit: 2,
      }),
      first,
    );
    const replayed = [...first.decisions];
    let cursor = first.nextAfterSequence;
    for (;;) {
      const page = await restarted.readPage({
        afterSequence: cursor,
        watermark,
        limit: 2,
      });
      assert.ok(page.decisions.length <= 2);
      replayed.push(...page.decisions);
      cursor = page.nextAfterSequence;
      if (page.done) break;
    }
    assert.deepEqual(replayed, appended);
    for (const limit of [0, -1, 101, 1.5, Number.NaN]) {
      await assert.rejects(
        store.readPage({ afterSequence: 0n, watermark, limit }),
        /invalid_limit/,
      );
    }
    for (const afterSequence of [
      -1n,
      watermark.sequence + 1n,
      9_223_372_036_854_775_808n,
    ]) {
      await assert.rejects(
        store.readPage({ afterSequence, watermark, limit: 1 }),
        /invalid_(sequence|cursor)/,
      );
    }
    await assert.rejects(
      store.readPage({
        afterSequence: 0n,
        watermark: { ...watermark, authorityId: randomUUID() },
        limit: 1,
      }),
      /authority_mismatch/,
    );
  });

  await test("maximum-sized keyset pages resume across a retained 203-decision stream", async () => {
    const start = await store.readWatermark();
    for (let i = 0; i < 203; i++) await store.append(input());
    const watermark = await store.readWatermark();
    const first = await store.readPage({
      afterSequence: start.sequence,
      watermark,
      limit: 100,
    });
    const second = await store.readPage({
      afterSequence: first.nextAfterSequence,
      watermark,
      limit: 100,
    });
    const third = await store.readPage({
      afterSequence: second.nextAfterSequence,
      watermark,
      limit: 100,
    });
    assert.deepEqual(
      [first.decisions.length, second.decisions.length, third.decisions.length],
      [100, 100, 3],
    );
    assert.deepEqual(
      [first.done, second.done, third.done],
      [false, false, true],
    );
    assert.equal(third.nextAfterSequence, watermark.sequence);
  });

  await test("committed append survives process exit before returning a receipt", async () => {
    const store = journal();
    const before = await store.readWatermark();
    const request = input();
    const childSource = `
      import { createErasureJournal } from "./src/erasure-journal/client.ts";
      const [url, authority, serialized] = process.argv.slice(1);
      const input = JSON.parse(serialized);
      input.requestedAt = new Date(input.requestedAt);
      input.deadlineAt = new Date(input.deadlineAt);
      const journal = createErasureJournal(url, authority);
      journal.append(input).then(() => process.exit(23));
    `;
    await assert.rejects(
      execFileAsync("pnpm", [
        "exec",
        "tsx",
        "--eval",
        childSource,
        controlUrl,
        authorityId,
        JSON.stringify(request),
      ]),
      (error: unknown) => {
        return error instanceof Error && "code" in error && error.code === 23;
      },
    );
    const restarted = journal();
    const watermark = await restarted.readWatermark();
    assert.equal(watermark.sequence, before.sequence + 1n);
    const page = await restarted.readPage({
      afterSequence: before.sequence,
      watermark,
      limit: 1,
    });
    assert.equal(page.decisions.length, 1);
    assert.deepEqual(await restarted.append(request), page.decisions[0]);
    const decision = page.decisions[0];
    assert.ok(decision);
    const job = await projectErasureDecision(app, decision);
    assert.deepEqual(await projectErasureDecision(app, decision), job);
  });

  await test("two-store crash gap, uncertain response, duplicate B1 replay and missing-job reconstruction", async () => {
    const before = await store.readWatermark();
    const request = input();
    const received = await store.append(request);
    // The control commit is complete before the application transaction starts.
    await assert.rejects(
      app.transaction(async (tx) => {
        await projectErasureDecision(tx, received);
        throw new Error("synthetic application failure before commit");
      }),
      /synthetic application failure/,
    );
    assert.equal(
      (
        await app
          .select()
          .from(jobs)
          .where(eq(jobs.decisionRef, received.decisionRef))
      ).length,
      0,
    );
    await store.close(); // Also discard the caller's authority receipt on restart.
    const restarted = journal();
    const watermark = await restarted.readWatermark();
    const page = await restarted.readPage({
      afterSequence: before.sequence,
      watermark,
      limit: 1,
    });
    assert.deepEqual(page.decisions, [received]);
    const decision = page.decisions[0];
    assert.ok(decision);
    const first = await projectErasureDecision(app, decision);
    assert.deepEqual(await projectErasureDecision(app, decision), first);
    assert.deepEqual(await restarted.append(request), received);
    assert.equal(first.state, "pending");
    assert.equal(first.requestedAt.getUTCFullYear(), 2020); // Older than restore point.
    await app.delete(jobs).where(eq(jobs.id, first.id)); // Synthetic restored copy loses job.
    let cursor = 0n;
    let retained: typeof received | undefined;
    for (;;) {
      const page = await restarted.readPage({
        afterSequence: cursor,
        watermark,
        limit: 100,
      });
      retained = page.decisions.find((decision) => {
        return decision.decisionRef === received.decisionRef;
      });
      if (retained || page.done) break;
      cursor = page.nextAfterSequence;
    }
    assert.ok(retained);
    const rebuilt = await projectErasureDecision(app, retained);
    assert.notEqual(rebuilt.id, first.id);
    for (const key of [
      "decisionRef",
      "confirmationRef",
      "deadlineAt",
      "requestedAt",
      "decisionSequence",
    ] as const) {
      assert.deepEqual(rebuilt[key], first[key]);
    }
    assert.deepEqual(await projectErasureDecision(app, retained), rebuilt);
  });

  await test("lossless bigint beyond safe integer and strict persisted row decoding", async () => {
    const store = journal();
    // Infrastructure-only boundary fixture: avoid allocating 2^53 actual rows.
    const frontier = 9_007_199_254_740_992n;
    await observer.query(
      "UPDATE erasure_journal_head SET committed_sequence = $1",
      [frontier.toString()],
    );
    const request = input();
    const saved = await store.append(request);
    assert.equal(saved.decisionSequence, frontier + 1n);
    const watermark = await store.readWatermark();
    assert.equal(watermark.sequence, frontier + 1n);
    const page = await store.readPage({
      afterSequence: frontier,
      watermark,
      limit: 1,
    });
    assert.deepEqual(page.decisions, [saved]);
    assert.equal(
      (await projectErasureDecision(app, saved)).decisionSequence,
      frontier + 1n,
    );
    await observer.query(
      "UPDATE erasure_journal_decisions SET authority_id = $1 WHERE decision_ref = $2",
      [randomUUID(), request.decisionRef],
    );
    await assert.rejects(
      store.readPage({ afterSequence: frontier, watermark, limit: 1 }),
      /authority_mismatch/,
    );
    await observer.query(
      "UPDATE erasure_journal_decisions SET authority_id = $1 WHERE decision_ref = $2",
      [authorityId, request.decisionRef],
    );
    await observer.query(
      "UPDATE erasure_journal_head SET committed_sequence = $1",
      ["9223372036854775807"],
    );
    assert.deepEqual(await store.append(request), saved); // Exact retry at exhaustion.
    await assert.rejects(store.append(input()), /sequence_exhausted/);
  });

  await test("normal application reset/replay cannot install or erase the separate journal", async () => {
    const store = journal();
    const before = await store.readWatermark();
    await appPool.end();
    await execFileAsync("pnpm", ["db:reset"], {
      env: { ...process.env, DATABASE_URL: applicationUrl },
    });
    assert.deepEqual(await store.readWatermark(), before);
    const probe = new Client({ connectionString: applicationUrl });
    await probe.connect();
    try {
      assert.equal(
        (
          await probe.query(
            "SELECT to_regclass('erasure_journal_head') AS name",
          )
        ).rows[0].name,
        null,
      );
      assert.equal(
        (
          await probe.query(
            "SELECT count(*)::int AS count FROM account_erasure_jobs",
          )
        ).rows[0].count,
        0,
      );
      const restored = drizzle(probe);
      let cursor = 0n;
      let projected = 0;
      for (;;) {
        const page = await store.readPage({
          afterSequence: cursor,
          watermark: before,
          limit: 3,
        });
        for (const decision of page.decisions) {
          const job = await projectErasureDecision(restored, decision);
          assert.deepEqual(
            await projectErasureDecision(restored, decision),
            job,
          );
          projected++;
        }
        cursor = page.nextAfterSequence;
        if (page.done) break;
      }
      assert.ok(projected > 20);
      assert.equal(
        (
          await probe.query(
            "SELECT count(*)::int AS count FROM account_erasure_jobs",
          )
        ).rows[0].count,
        projected,
      );
    } finally {
      await probe.end();
    }
    await migrateErasureJournal(controlUrl);
    assert.deepEqual(await store.readWatermark(), before);
  });
} finally {
  await Promise.all(
    clients.map((client) => {
      return client.close();
    }),
  );
  if (!appPool.ended) await appPool.end();
  await observer.end();
  await blocker.end();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${applicationName}"`);
    await admin.query(`DROP DATABASE IF EXISTS "${controlName}"`);
  } finally {
    await admin.end();
  }
}
