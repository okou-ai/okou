import "./env";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { Client } from "pg";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { migrateErasureJournal } from "@okouai/db/erasure-journal/migrate";
import {
  accountErasureIngress as ingress,
  accountErasureReplay as replay,
} from "@okouai/db/schema/account-erasure-bridge";
import { accountErasureJobs as jobs } from "@okouai/db/schema/account-erasure";
import {
  beginErasureReplay,
  claimErasureReplay,
  checkpointErasureReplay,
} from "@okouai/db/operations/account-erasure-bridge";
import { projectErasureDecision } from "@okouai/db/operations/account-erasure";
import { createClerkErasureBridge } from "../../src/signals/services/account-erasure-bridge";
import { verifyClerkDeletion } from "../../src/signals/external/clerk";
import {
  audience,
  authority,
  event,
  fixture,
  request,
  requestedAt,
  secret,
} from "./fixture";

// Explicit infrastructure exception: B2a is deliberately unregistered. Exercise
// its raw Request handler, genuine SDK verifier, two migrated PostgreSQL stores
// and actual B1. Process death, corruption/restore and lease replacement cannot
// be constructed through any production endpoint. No projector/DB is mocked.
assert.ok(process.env.DATABASE_URL, "local DATABASE_URL required");
const base = new URL(process.env.DATABASE_URL);
assert.ok(["127.0.0.1", "localhost", "postgres"].includes(base.hostname));
const suffix = randomUUID().replaceAll("-", "");
const applicationName = `b2a_app_${suffix}`;
const controlName = `b2a_control_${suffix}`;
function url(name: string) {
  const value = new URL(base);
  value.pathname = `/${name}`;
  return value.toString();
}
const applicationUrl = url(applicationName);
const controlUrl = url(controlName);
const authorityId = randomUUID();
const signal = new AbortController().signal;
const admin = new Client({ connectionString: base.toString() });
await admin.connect();
const temp = await mkdtemp(join(tmpdir(), "b2a-test-"));
const fixtures: ReturnType<typeof fixture>[] = [];
function fresh(policy = authority()) {
  const value = fixture(applicationUrl, controlUrl, authorityId, policy);
  fixtures.push(value);
  return value;
}
const f = fresh();
const childPath = fileURLToPath(new URL("./child.ts", import.meta.url));
async function child(input: Record<string, unknown>) {
  const path = join(temp, `${randomUUID()}.json`);
  await writeFile(
    path,
    JSON.stringify({
      applicationUrl,
      controlUrl,
      authorityId,
      subjectId: `synthetic_${randomUUID()}`,
      eventId: randomUUID(),
      boundary: "resume",
      ...input,
    }),
  );
  const process = spawn("node", ["--import", "tsx", childPath, path], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  let errors = "";
  assert.ok(process.stdout);
  assert.ok(process.stderr);
  process.stdout.on("data", (value: Buffer) => {
    output += value.toString();
  });
  process.stderr.on("data", (value: Buffer) => {
    errors += value.toString();
  });
  const done = new Promise<{
    code: number | null;
    output: string;
    errors: string;
  }>((resolve, reject) => {
    process.once("error", reject);
    process.once("close", (code) => {
      resolve({ code, output, errors });
    });
  });
  await new Promise<void>((resolve, reject) => {
    process.once("message", () => {
      resolve();
    });
    process.once("error", reject);
    process.once("exit", (code) => {
      reject(new Error(`child exited before handshake: ${code}: ${errors}`));
    });
  });
  return { process, done };
}
async function captures(eventId: string) {
  return await f.db.select().from(ingress).where(eq(ingress.eventId, eventId));
}
async function ready(ref: string) {
  await f.pool.query(
    "UPDATE account_erasure_ingress SET available_at = clock_timestamp() - interval '1 second' WHERE confirmation_ref=$1",
    [ref],
  );
}
async function state() {
  return {
    captures: await f.db.select().from(ingress),
    jobs: await f.db.select().from(jobs),
    watermark: await f.journal.readWatermark(),
  };
}
async function lockObserved(applicationName: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await admin.query(
      "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
      [applicationName],
    );
    if (result.rowCount) {
      return;
    }
    await setTimeout(5);
  }
  assert.fail("child did not reach the real database lock");
}
try {
  await admin.query(`CREATE DATABASE "${applicationName}"`);
  await admin.query(`CREATE DATABASE "${controlName}"`);
  const execFileAsync = promisify(execFile);
  for (let i = 0; i < 2; i++) {
    await execFileAsync("node", ["--import", "tsx", "scripts/migrate.ts"], {
      cwd: fileURLToPath(new URL("../../../../packages/db", import.meta.url)),
      env: { ...process.env, DATABASE_URL: applicationUrl },
    });
  }
  await migrateErasureJournal(controlUrl);
  await migrateErasureJournal(controlUrl);

  await test("actual SDK verifies immutable event time and distinct user/organization domains", async () => {
    const subjectId = `synthetic_${randomUUID()}`;
    const billingOrg = `synthetic_surviving_org_${randomUUID()}`;
    const ledger = await f.pool.query(
      "INSERT INTO usage_event(idempotency_key, org_id, user_id, kind, provider, category, quantity, credits_charged, status) VALUES($1,$2,$3,'model','synthetic','tokens',100,7,'processed'),($4,$2,$5,'model','synthetic','tokens',200,9,'processed') RETURNING *",
      [
        randomUUID(),
        billingOrg,
        subjectId,
        randomUUID(),
        `synthetic_other_owner_${randomUUID()}`,
      ],
    );
    for (const kind of ["user", "organization"]) {
      const body = event({
        type: `${kind}.deleted`,
        data: { id: subjectId, deleted: true },
      });
      const eventId = randomUUID();
      assert.equal(
        (await f.bridge.handle(request(body, eventId), signal)).status,
        "projection_committed",
      );
      const [row] = await captures(eventId);
      assert.ok(row);
      assert.equal(row.subjectKind, kind);
      assert.equal(row.requestedAt.getTime(), requestedAt);
      const stored = await f.journal.readDecisionByConfirmationRef(
        row.confirmationRef,
      );
      assert.ok(stored);
      const [job] = await f.db
        .select()
        .from(jobs)
        .where(eq(jobs.decisionRef, stored.decisionRef));
      assert.equal(job?.decisionSequence, stored.decisionSequence);
    }
    const billingAfter = await f.pool.query(
      "SELECT * FROM usage_event WHERE org_id=$1 ORDER BY quantity",
      [billingOrg],
    );
    assert.deepEqual(billingAfter.rows, ledger.rows);
    const before = await state();
    const bodies = [
      event({ timestamp: undefined }),
      event({ timestamp: "2020" }),
      event({ timestamp: -1 }),
      event({ timestamp: 1.5 }),
      event({ timestamp: Number.MAX_SAFE_INTEGER }),
      event({ instance_id: "ins_wrong" }),
      event({ data: { id: "", deleted: true } }),
      event({ data: { id: "synthetic_x", deleted: false } }),
    ];
    for (const body of bodies) {
      assert.notEqual(
        (await f.bridge.handle(request(body), signal)).status,
        "projection_committed",
      );
    }
    const unsigned = request(event());
    unsigned.headers.delete("svix-signature");
    await assert.rejects(
      verifyClerkDeletion(unsigned, { audience, signingSecret: secret }),
    );
    const invalid = request(event());
    invalid.headers.set("svix-signature", "v1,invalid");
    assert.notEqual(
      (await f.bridge.handle(invalid, signal)).status,
      "projection_committed",
    );
    assert.deepEqual(await state(), before);
  });

  await test("redelivery and policy rollout keep every original field; changed event tuples conflict", async () => {
    const body = event();
    const eventId = randomUUID();
    assert.equal(
      (await f.bridge.handle(request(body, eventId), signal)).status,
      "projection_committed",
    );
    const [captured] = await captures(eventId);
    assert.ok(captured);
    const original = await f.journal.readDecisionByConfirmationRef(
      captured.confirmationRef,
    );
    assert.ok(original);
    const rolled = fresh({
      ...authority(7),
      decideInitial: () => {
        throw new Error("must not consult current defaults");
      },
    });
    assert.equal(
      (await rolled.bridge.handle(request(body, eventId, -30), signal)).status,
      "projection_committed",
    );
    assert.deepEqual(
      await f.journal.readDecisionByConfirmationRef(captured.confirmationRef),
      original,
    );
    for (const changed of [
      event({ ...body, timestamp: requestedAt + 1 }),
      event({ ...body, type: "organization.deleted" }),
      event({ ...body, data: { id: "synthetic_other", deleted: true } }),
    ]) {
      assert.equal(
        (await rolled.bridge.handle(request(changed, eventId), signal)).status,
        "unresolved",
      );
    }
    await f.db
      .delete(ingress)
      .where(eq(ingress.confirmationRef, captured.confirmationRef));
    await f.db.delete(jobs).where(eq(jobs.decisionRef, original.decisionRef));
    assert.equal(
      (await rolled.bridge.handle(request(body, eventId), signal)).status,
      "projection_committed",
    );
    const [restored] = await captures(eventId);
    assert.ok(restored);
    assert.equal(restored.deadlineAt.getTime(), original.deadlineAt.getTime());
    assert.equal(restored.dispositionVersion, original.dispositionVersion);
    assert.deepEqual(
      await f.journal.readDecisionByConfirmationRef(captured.confirmationRef),
      original,
    );
  });

  await test("new process resumes durable capture and unknown external commit without regeneration", async () => {
    for (const boundary of ["capture", "unknown_commit"]) {
      const eventId = randomUUID();
      const subjectId = `synthetic_${randomUUID()}`;
      const killed = await child({ eventId, subjectId, boundary });
      const exited = await killed.done;
      assert.equal(exited.code, 71, exited.errors + exited.output);
      const [row] = await captures(eventId);
      assert.ok(row);
      const before = await f.journal.readDecisionByConfirmationRef(
        row.confirmationRef,
      );
      assert.equal(Boolean(before), boundary === "unknown_commit");
      assert.equal(
        (
          await f.db
            .select()
            .from(jobs)
            .where(eq(jobs.decisionRef, row.decisionRef))
        ).length,
        0,
      );
      await ready(row.confirmationRef);
      const restarted = await child({
        eventId,
        subjectId,
        confirmationRef: row.confirmationRef,
      });
      const result = await restarted.done;
      assert.equal(result.code, 0, result.errors);
      assert.equal(JSON.parse(result.output).status, "projection_committed");
      const stored = await f.journal.readDecisionByConfirmationRef(
        row.confirmationRef,
      );
      assert.ok(stored);
      assert.equal(stored.dispositionVersion, row.dispositionVersion);
      assert.equal(stored.deadlineAt.getTime(), row.deadlineAt.getTime());
      if (before) {
        assert.deepEqual(stored, before);
      }
    }
  });

  await test("real transaction rollback and process death at receipt/projection commit boundaries", async () => {
    const blocker = new Client({ connectionString: applicationUrl });
    await blocker.connect();
    try {
      for (const boundary of ["external_committed", "projection_committed"]) {
        const lock = boundary === "external_committed" ? 3_427_401 : 3_427_402;
        await blocker.query("SELECT pg_advisory_lock($1)", [lock]);
        await f.pool.query(
          `CREATE FUNCTION b2a_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='${boundary}' THEN PERFORM pg_advisory_xact_lock(${lock}); END IF; RETURN NEW; END $$`,
        );
        await f.pool.query(
          "CREATE TRIGGER b2a_pause BEFORE UPDATE ON account_erasure_ingress FOR EACH ROW EXECUTE FUNCTION b2a_pause()",
        );
        const eventId = randomUUID();
        const name = `b2a_${randomUUID()}`;
        const childUrl = new URL(applicationUrl);
        childUrl.searchParams.set("application_name", name);
        const running = await child({
          eventId,
          boundary: "database_pause",
          applicationUrl: childUrl.toString(),
        });
        await lockObserved(name);
        const [row] = await captures(eventId);
        assert.ok(row);
        const stored = await f.journal.readDecisionByConfirmationRef(
          row.confirmationRef,
        );
        assert.ok(stored);
        assert.equal(
          (
            await f.db
              .select()
              .from(jobs)
              .where(eq(jobs.decisionRef, row.decisionRef))
          ).length,
          boundary === "projection_committed" ? 1 : 0,
        );
        running.process.kill("SIGKILL");
        await running.done;
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1",
          [name],
        );
        await blocker.query("SELECT pg_advisory_unlock($1)", [lock]);
        await f.pool.query(
          "DROP TRIGGER b2a_pause ON account_erasure_ingress; DROP FUNCTION b2a_pause()",
        );
        await ready(row.confirmationRef);
        const restarted = await child({ confirmationRef: row.confirmationRef });
        const result = await restarted.done;
        assert.equal(result.code, 0, result.errors);
        assert.equal(JSON.parse(result.output).status, "projection_committed");
        assert.deepEqual(
          await f.journal.readDecisionByConfirmationRef(row.confirmationRef),
          stored,
        );
      }
    } finally {
      await blocker.end();
    }
  });

  await test("concurrent deliveries with competing policies converge on first capture and one B1 job", async () => {
    const body = event();
    const eventId = randomUUID();
    const arrivals: (() => void)[] = [];
    function racingPolicy(version: number) {
      const policy = authority(version);
      return {
        ...policy,
        decideInitial: async (
          ...args: Parameters<typeof policy.decideInitial>
        ) => {
          const decision = await policy.decideInitial(...args);
          await new Promise<void>((resolve) => {
            arrivals.push(resolve);
            if (arrivals.length === 2) {
              for (const resume of arrivals) {
                resume();
              }
            }
          });
          return decision;
        },
      };
    }
    const first = fresh(racingPolicy(1));
    const rolled = fresh(racingPolicy(9));
    await Promise.all([
      first.bridge.handle(request(body, eventId), signal),
      rolled.bridge.handle(request(body, eventId), signal),
    ]);
    assert.equal(arrivals.length, 2);
    const rows = await captures(eventId);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.equal(
      (await f.bridge.resume(row.confirmationRef, signal)).status,
      "projection_committed",
    );
    const stored = await f.journal.readDecisionByConfirmationRef(
      row.confirmationRef,
    );
    assert.ok(stored);
    assert.equal(stored.dispositionVersion, row.dispositionVersion);
    assert.equal(stored.deadlineAt.getTime(), row.deadlineAt.getTime());
    assert.equal(
      (
        await f.db
          .select()
          .from(jobs)
          .where(eq(jobs.decisionRef, row.decisionRef))
      ).length,
      1,
    );
  });

  await test("current applicability rejects committed and captured-only recovered/transferred/retired identities", async () => {
    for (const reason of [
      "recovered",
      "transferred",
      "retired",
      "ambiguous",
    ] as const) {
      for (const committed of [true, false]) {
        const eventId = randomUUID();
        const body = event();
        if (committed) {
          await f.bridge.handle(request(body, eventId), signal);
        } else {
          const stopped = await child({
            eventId,
            subjectId: body.data.id,
            boundary: "capture",
          });
          assert.equal((await stopped.done).code, 71);
        }
        const [row] = await captures(eventId);
        assert.ok(row);
        const before = await f.journal.readDecisionByConfirmationRef(
          row.confirmationRef,
        );
        if (committed) {
          await f.db.delete(jobs).where(eq(jobs.decisionRef, row.decisionRef));
        }
        await ready(row.confirmationRef);
        const denied = fresh({
          decideInitial: () => {
            throw new Error("no current default");
          },
          applicability: () => {
            return Promise.resolve({ outcome: "unresolved", reason });
          },
        });
        assert.equal(
          (await denied.bridge.handle(request(body, eventId), signal)).status,
          "unresolved",
        );
        assert.deepEqual(
          await f.journal.readDecisionByConfirmationRef(row.confirmationRef),
          before,
        );
        assert.equal(
          (
            await f.db
              .select()
              .from(jobs)
              .where(eq(jobs.decisionRef, row.decisionRef))
          ).length,
          0,
        );
      }
    }
    const denied = fresh({
      ...authority(),
      decideInitial: () => {
        return Promise.resolve({ outcome: "unresolved", reason: "ambiguous" });
      },
    });
    const before = await state();
    assert.equal(
      (await denied.bridge.handle(request(event()), signal)).status,
      "unresolved",
    );
    assert.deepEqual(await state(), before); // No optional users row was required.
    const retired = fresh({
      ...authority(),
      applicability: () => {
        return Promise.resolve({ outcome: "unresolved", reason: "retired" });
      },
    });
    const priorJobs = await f.db.select().from(jobs);
    const pass = await retired.bridge.replayPage(
      { targetId: randomUUID(), replayGeneration: randomUUID() },
      signal,
    );
    assert.equal(pass.status, "unresolved");
    assert.equal(pass.cursor, 0n);
    assert.deepEqual(await f.db.select().from(jobs), priorJobs);
  });

  await test("unavailable stores, aborted callers and exhausted retry leave explicit non-success", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const before = await state();
    assert.equal(
      (await f.bridge.handle(request(event()), aborted.signal)).status,
      "pending",
    );
    assert.deepEqual(await state(), before);
    const badUrl = new URL(controlUrl);
    badUrl.pathname = "/synthetic_database_absent";
    const down = fixture(applicationUrl, badUrl.toString(), authorityId);
    fixtures.push(down);
    assert.notEqual(
      (await down.bridge.handle(request(event()), signal)).status,
      "projection_committed",
    );
    const appDown = fixture(badUrl.toString(), controlUrl, authorityId);
    fixtures.push(appDown);
    assert.notEqual(
      (await appDown.bridge.handle(request(event()), signal)).status,
      "projection_committed",
    );
    const eventId = randomUUID();
    const stopped = await child({ eventId, boundary: "capture" });
    await stopped.done;
    const [row] = await captures(eventId);
    assert.ok(row);
    await f.pool.query(
      "UPDATE account_erasure_ingress SET attempts=5 WHERE confirmation_ref=$1",
      [row.confirmationRef],
    );
    assert.equal(
      (await f.bridge.resume(row.confirmationRef, signal)).status,
      "unresolved",
    );
    assert.equal(
      await f.journal.readDecisionByConfirmationRef(row.confirmationRef),
      undefined,
    );
  });

  await test("post-commit abort retains exact work and completed retry detail can retire", async () => {
    const controller = new AbortController();
    const wrapped = createClerkErasureBridge({
      db: f.db,
      audience,
      authorityId,
      signingSecret: secret,
      authority: authority(),
      journal: {
        ...f.journal,
        append: async (input) => {
          const result = await f.journal.append(input);
          controller.abort();
          return result;
        },
      },
    });
    const eventId = randomUUID();
    const body = event();
    const result = await wrapped.handle(
      request(body, eventId),
      controller.signal,
    );
    assert.equal(result.status, "external_committed_local_pending");
    const [row] = await captures(eventId);
    assert.ok(row);
    const original = await f.journal.readDecisionByConfirmationRef(
      row.confirmationRef,
    );
    assert.ok(original);
    assert.equal(
      await f.bridge.retireCompleted(row.confirmationRef, signal),
      false,
    );
    assert.equal(
      (
        await f.db
          .select()
          .from(jobs)
          .where(eq(jobs.decisionRef, row.decisionRef))
      ).length,
      0,
    );
    await ready(row.confirmationRef);
    assert.equal(
      (await f.bridge.retryNext(signal)).status,
      "projection_committed",
    );
    assert.equal(
      await f.bridge.retireCompleted(row.confirmationRef, signal),
      true,
    );
    assert.equal((await captures(eventId)).length, 0);
    const restarted = await child({ eventId, subjectId: body.data.id });
    const receipt = await restarted.done;
    assert.equal(receipt.code, 0, receipt.errors);
    assert.equal(JSON.parse(receipt.output).status, "projection_committed");
    assert.deepEqual(
      await f.journal.readDecisionByConfirmationRef(row.confirmationRef),
      original,
    );
  });

  await test("five actual failed control-store attempts exhaust without losing captured input", async () => {
    const eventId = randomUUID();
    const stopped = await child({ eventId, boundary: "capture" });
    assert.equal((await stopped.done).code, 71);
    const [row] = await captures(eventId);
    assert.ok(row);
    const missing = new URL(controlUrl);
    missing.pathname = "/synthetic_no_control_store";
    const down = fixture(applicationUrl, missing.toString(), authorityId);
    fixtures.push(down);
    for (let attempt = row.attempts; attempt < 5; attempt++) {
      await ready(row.confirmationRef);
      const result = await down.bridge.resume(row.confirmationRef, signal);
      assert.notEqual(result.status, "projection_committed");
    }
    const [exhausted] = await captures(eventId);
    assert.ok(exhausted);
    assert.equal(exhausted.attempts, 5);
    assert.equal(exhausted.state, "unresolved");
    assert.equal(exhausted.decisionRef, row.decisionRef);
    assert.equal(exhausted.deadlineAt.getTime(), row.deadlineAt.getTime());
    assert.equal(
      await f.journal.readDecisionByConfirmationRef(row.confirmationRef),
      undefined,
    );
  });

  await test("indexed point lookup validates store authority and persisted decision fields", async () => {
    const before = await state();
    const ref = before.captures[0]?.confirmationRef;
    assert.ok(ref);
    const wrong = fixture(applicationUrl, controlUrl, randomUUID());
    fixtures.push(wrong);
    await assert.rejects(
      wrong.journal.readDecisionByConfirmationRef(randomUUID()),
      /authority_mismatch/,
    );
    await assert.rejects(
      f.journal.readDecisionByConfirmationRef("bad-ref"),
      /invalid_reference/,
    );
    assert.equal(
      await f.journal.readDecisionByConfirmationRef(randomUUID()),
      undefined,
    );
    const control = new Client({ connectionString: controlUrl });
    await control.connect();
    try {
      await control.query(
        "ALTER TABLE erasure_journal_decisions DROP CONSTRAINT erasure_journal_subject",
      );
      await control.query(
        "UPDATE erasure_journal_decisions SET subject_id='' WHERE confirmation_ref=$1",
        [ref],
      );
      await assert.rejects(
        f.journal.readDecisionByConfirmationRef(ref),
        /invalid_subject/,
      );
      const row = before.captures.find((r) => {
        return r.confirmationRef === ref;
      });
      assert.ok(row);
      await control.query(
        "UPDATE erasure_journal_decisions SET subject_id=$1 WHERE confirmation_ref=$2",
        [row.subjectId, ref],
      );
      await control.query(
        "ALTER TABLE erasure_journal_decisions ADD CONSTRAINT erasure_journal_subject CHECK(subject_kind IN ('user', 'organization') AND octet_length(subject_id) BETWEEN 1 AND 192)",
      );
    } finally {
      await control.end();
    }
  });

  // These are test-owned stores. Isolate pagination from the earlier failure
  // cases, leaving all migration ledgers and real constraints in place.
  await f.pool.query(
    "TRUNCATE account_erasure_ingress, account_erasure_replay, account_erasure_jobs CASCADE",
  );
  const control = new Client({ connectionString: controlUrl });
  await control.connect();
  await control.query(
    "TRUNCATE erasure_journal_decisions, erasure_journal_head",
  );
  const high = BigInt(Number.MAX_SAFE_INTEGER) + 1000n;
  await control.query(
    "INSERT INTO erasure_journal_head(slot,authority_id,committed_sequence) VALUES(1,$1,$2)",
    [authorityId, high.toString()],
  );
  const decisions: Awaited<ReturnType<typeof f.journal.append>>[] = [];
  for (let i = 0; i < 203; i++) {
    decisions.push(
      await f.journal.append({
        subjectKind: "user",
        subjectId: `synthetic_page_${suffix}_${i}`,
        generation: 1,
        decisionRef: randomUUID(),
        confirmationRef: randomUUID(),
        previousDecisionRef: null,
        dispositionVersion: 1,
        requestedAt: new Date(requestedAt),
        deadlineAt: new Date("2090-01-01T00:00:00.456Z"),
      }),
    );
  }
  await control.end();
  const identity = { targetId: randomUUID(), replayGeneration: randomUUID() };

  await test("203 decisions pin 100/100/3 pages; new process repeats committed page after death before checkpoint", async () => {
    const watermark = await f.journal.readWatermark();
    assert.equal(watermark.sequence, high + 203n);
    const sizes = [];
    let cursor = 0n;
    for (;;) {
      const page = await f.journal.readPage({
        afterSequence: cursor,
        watermark,
        limit: 100,
      });
      sizes.push(page.decisions.length);
      cursor = page.nextAfterSequence;
      if (page.done) {
        break;
      }
    }
    assert.deepEqual(sizes, [100, 100, 3]);
    const blocker = new Client({ connectionString: applicationUrl });
    await blocker.connect();
    await blocker.query("SELECT pg_advisory_lock(3427403)");
    await f.pool.query(
      "CREATE FUNCTION b2a_pause_replay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.cursor > OLD.cursor THEN PERFORM pg_advisory_xact_lock(3427403); END IF; RETURN NEW; END $$; CREATE TRIGGER b2a_pause_replay BEFORE UPDATE ON account_erasure_replay FOR EACH ROW EXECUTE FUNCTION b2a_pause_replay()",
    );
    const name = `b2a_replay_${randomUUID()}`;
    const childUrl = new URL(applicationUrl);
    childUrl.searchParams.set("application_name", name);
    const running = await child({
      ...identity,
      applicationUrl: childUrl.toString(),
    });
    await lockObserved(name);
    const [before] = await f.db.select().from(replay);
    assert.ok(before);
    assert.equal(before.cursor, 0n);
    assert.equal(before.watermark, high + 203n);
    assert.equal((await f.db.select().from(jobs)).length, 100);
    const extra = await f.journal.append({
      ...decisions[0]!,
      subjectId: `synthetic_late_${suffix}`,
      decisionRef: randomUUID(),
      confirmationRef: randomUUID(),
    });
    assert.equal(extra.decisionSequence, high + 204n);
    running.process.kill("SIGKILL");
    await running.done;
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1",
      [name],
    );
    await blocker.query("SELECT pg_advisory_unlock(3427403)");
    await blocker.end();
    await f.pool.query(
      "DROP TRIGGER b2a_pause_replay ON account_erasure_replay; DROP FUNCTION b2a_pause_replay(); UPDATE account_erasure_replay SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE lease_id IS NOT NULL",
    );
    const restarted = await child(identity);
    const result = await restarted.done;
    assert.equal(result.code, 0, result.errors);
    assert.equal(JSON.parse(result.output).cursor, (high + 100n).toString());
    const second = await f.bridge.replayPage(identity, signal);
    assert.equal(second.cursor, high + 200n);
    assert.equal(second.status, "pending");
    const third = await f.bridge.replayPage(identity, signal);
    assert.equal(third.cursor, high + 203n);
    assert.equal(third.status, "complete");
    assert.equal((await f.db.select().from(jobs)).length, 203);
    const next = { ...identity, replayGeneration: randomUUID() };
    let page;
    do {
      page = await f.bridge.replayPage(next, signal);
    } while (page.status === "pending");
    assert.equal(page.status, "complete");
    assert.equal(page.watermark, high + 204n);
    assert.equal((await f.db.select().from(jobs)).length, 204);
  });

  await test("lease CAS prevents a replaced replay worker from checkpointing", async () => {
    const id = {
      ...identity,
      replayGeneration: randomUUID(),
      audience,
      authorityId,
    };
    const pass = await beginErasureReplay(f.db, id, high + 204n);
    const [a, b] = await Promise.all([
      claimErasureReplay(f.db, pass),
      claimErasureReplay(f.db, pass),
    ]);
    const old = a ?? b;
    assert.ok(old);
    assert.equal(Number(Boolean(a)) + Number(Boolean(b)), 1);
    await f.pool.query(
      "UPDATE account_erasure_replay SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE replay_generation=$1",
      [id.replayGeneration],
    );
    const next = await claimErasureReplay(f.db, pass);
    assert.ok(next);
    await assert.rejects(
      checkpointErasureReplay(f.db, old, high + 100n, "pending", signal),
      /lease_lost/,
    );
    const [row] = await f.db
      .select()
      .from(replay)
      .where(eq(replay.replayGeneration, id.replayGeneration));
    assert.equal(row?.cursor, 0n);
    assert.equal(row?.leaseId, next.leaseId);
  });

  await test("a completed cursor needs a fresh zero-start reconciliation to rebuild missing jobs", async () => {
    const missing = decisions[0];
    assert.ok(missing);
    await f.db.delete(jobs).where(eq(jobs.decisionRef, missing.decisionRef));
    assert.equal(
      (await f.bridge.replayPage(identity, signal)).status,
      "complete",
    );
    assert.equal(
      (
        await f.db
          .select()
          .from(jobs)
          .where(eq(jobs.decisionRef, missing.decisionRef))
      ).length,
      0,
    );
    const next = { ...identity, replayGeneration: randomUUID() };
    let page;
    do {
      page = await f.bridge.replayPage(next, signal);
    } while (page.status === "pending");
    assert.equal(page.status, "complete");
    const [row] = await f.db
      .select()
      .from(jobs)
      .where(eq(jobs.decisionRef, missing.decisionRef));
    assert.ok(row);
    assert.equal(row.deadlineAt.getTime(), missing.deadlineAt.getTime());
    assert.equal(row.decisionSequence, missing.decisionSequence);
  });

  await test("whole retained chains rebuild in order; a partial hole remains unresolved under unchanged B1", async () => {
    const first = await f.journal.append({
      ...decisions[0]!,
      subjectId: `synthetic_chain_${suffix}`,
      decisionRef: randomUUID(),
      confirmationRef: randomUUID(),
    });
    const second = await f.journal.append({
      ...first,
      generation: 2,
      previousDecisionRef: first.decisionRef,
      decisionRef: randomUUID(),
      confirmationRef: randomUUID(),
    });
    const whole = { ...identity, replayGeneration: randomUUID() };
    let page;
    do {
      page = await f.bridge.replayPage(whole, signal);
    } while (page.status === "pending");
    assert.equal(page.status, "complete");
    assert.equal(
      (
        await f.db
          .select()
          .from(jobs)
          .where(eq(jobs.subjectId, first.subjectId))
      ).length,
      2,
    );
    await f.db.delete(jobs).where(eq(jobs.subjectId, first.subjectId));
    const rebuilt = { ...identity, replayGeneration: randomUUID() };
    do {
      page = await f.bridge.replayPage(rebuilt, signal);
    } while (page.status === "pending");
    assert.equal(page.status, "complete");
    await f.db.delete(jobs).where(eq(jobs.decisionRef, first.decisionRef));
    await assert.rejects(projectErasureDecision(f.db, first), /stale_decision/);
    const hole = { ...identity, replayGeneration: randomUUID() };
    do {
      page = await f.bridge.replayPage(hole, signal);
    } while (page.status === "pending");
    assert.equal(page.status, "unresolved");
    assert.ok(page.cursor < first.decisionSequence);
    const remaining = await f.db
      .select()
      .from(jobs)
      .where(eq(jobs.subjectId, first.subjectId));
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.decisionRef, second.decisionRef);
  });
} finally {
  for (const value of fixtures) {
    await value.close();
  }
  await admin.query(
    `DROP DATABASE IF EXISTS "${applicationName}" WITH (FORCE)`,
  );
  await admin.query(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
  await admin.end();
  await rm(temp, { recursive: true, force: true });
}
