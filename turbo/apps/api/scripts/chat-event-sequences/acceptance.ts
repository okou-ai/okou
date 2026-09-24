import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  appendCanonicalChatEvents,
  type PreparedChatEventRow,
} from "../../src/signals/services/chat-event-append.service";
import { isSplitChatEventWriteEnabled } from "../../src/signals/services/chat-event-write-mode.service";
import { createSequenceFixture, sequenceMigration } from "./fixture";
import { verifyOwnershipAndReceiptPreparation } from "./preparation";
import { verifyBackfillWithLegacyThreadLock } from "./backfill-locking";

// This rollout/locking contract cannot be constructed through a production API:
// it requires an outgoing binary's SQL, DDL, and concurrent independent sessions.
const fixture = await createSequenceFixture();
const { pool, db } = fixture;
const bridge = await sequenceMigration("chat_event_sequence_bridge");
const backfill = await sequenceMigration("backfill_chat_event_sequences");
function event(
  chatThreadId: string,
  fields: Partial<PreparedChatEventRow> = {},
): PreparedChatEventRow {
  return {
    id: randomUUID(),
    chatThreadId,
    eventType: "output.message",
    payload: { content: "visible message" },
    createdAt: new Date(),
    ...fields,
  };
}
async function watermark(threadId: string): Promise<number> {
  const result = await pool.query(
    "SELECT last_seq_id::text AS value FROM chat_event_sequences WHERE chat_thread_id=$1",
    [threadId],
  );
  return Number(result.rows[0]?.value ?? 0);
}
async function createThread(lastSeqId = 0): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO chat_threads(id,last_chat_event_seq_id) VALUES($1,$2)",
    [id, lastSeqId],
  );
  return id;
}
try {
  const retained = await createThread(100);
  // An unseeded expansion is not an inactive rollout. Promotion requires the
  // bridge migration below; missing required control data must fail closed.
  await assert.rejects(isSplitChatEventWriteEnabled(db), {
    message: "Chat event write control singleton is missing",
  });
  // The rollout starts before new API promotion: outgoing writers still run.
  for (const statement of bridge) {
    await pool.query(statement);
  }
  assert.equal(await isSplitChatEventWriteEnabled(db), false);
  const first = await createThread();
  const [firstLegacy] = await appendCanonicalChatEvents(
    db,
    [event(first)],
    "none",
    false,
  );
  assert.equal(firstLegacy?.seqId, 1);
  const [firstDirect] = await appendCanonicalChatEvents(
    db,
    [event(first)],
    "none",
    true,
  );
  assert.equal(firstDirect?.seqId, 2);
  await pool.query("INSERT INTO chat_event_sequences VALUES($1,110)", [
    retained,
  ]);
  const routed = await pool.query(
    "UPDATE chat_threads SET last_chat_event_seq_id=last_chat_event_seq_id+1 WHERE id=$1 RETURNING last_chat_event_seq_id",
    [retained],
  );
  assert.equal(routed.rows[0]?.last_chat_event_seq_id, "111");
  const seeded = await createThread(400);
  // Backfill may race both bridges and direct writes; it never overwrites a newer allocation.
  await Promise.all([
    (async () => {
      const client = await pool.connect();
      try {
        for (const statement of backfill) {
          await client.query(statement);
        }
      } finally {
        client.release();
      }
    })(),
    appendCanonicalChatEvents(
      db,
      [event(retained), event(retained)],
      "any",
      true,
    ),
  ]);
  assert.equal(await watermark(seeded), 400);
  assert.equal(await watermark(retained), 113);
  // The backfill is restartable after completed batches / a journal retry.
  const retryClient = await pool.connect();
  try {
    for (const statement of backfill) {
      await retryClient.query(statement);
    }
  } finally {
    retryClient.release();
  }
  assert.equal(await watermark(retained), 113);
  // A locked row in batch two must not erase the already committed first
  // batch. Retrying starts from the legacy watermark and keeps newer counters.
  await pool.query(`INSERT INTO chat_threads(id,last_chat_event_seq_id)
    SELECT ('00000000-0000-4000-8000-' || lpad(value::text,12,'0'))::uuid, 50
    FROM generate_series(1,1005) AS value`);
  const lockedBackfillId = "00000000-0000-4000-8000-000000001001";
  await pool.query("INSERT INTO chat_event_sequences VALUES($1,1)", [
    lockedBackfillId,
  ]);
  const backfillBlocker = await pool.connect();
  const interrupted = await pool.connect();
  try {
    await backfillBlocker.query("BEGIN");
    await backfillBlocker.query(
      "SELECT * FROM chat_event_sequences WHERE chat_thread_id=$1 FOR UPDATE",
      [lockedBackfillId],
    );
    await assert.rejects(
      (async () => {
        for (const statement of backfill) {
          await interrupted.query(statement);
        }
      })(),
      (error: unknown) => {
        return (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "55P03"
        );
      },
    );
    const committedBatch = await pool.query(
      "SELECT count(*)::int AS count FROM chat_event_sequences WHERE chat_thread_id < $1 AND last_seq_id=50",
      [lockedBackfillId],
    );
    assert.equal(committedBatch.rows[0]?.count, 1000);
    await backfillBlocker.query("ROLLBACK");
    for (const statement of backfill) {
      await interrupted.query(statement);
    }
    assert.equal(await watermark(lockedBackfillId), 50);
  } finally {
    await backfillBlocker.query("ROLLBACK");
    backfillBlocker.release();
    interrupted.release();
  }
  const mixed = await createThread();
  const mixedRows = (
    await Promise.all(
      Array.from({ length: 24 }, (_, index) => {
        return appendCanonicalChatEvents(
          db,
          [event(mixed), event(mixed)],
          "any",
          index % 2 === 0,
        );
      }),
    )
  ).flat();
  assert.equal(
    new Set(
      mixedRows.map((row) => {
        return row.seqId;
      }),
    ).size,
    48,
  );
  assert.equal(await watermark(mixed), 48);
  const second = await createThread();
  await Promise.all([
    appendCanonicalChatEvents(db, [event(mixed), event(second)], "any", true),
    appendCanonicalChatEvents(db, [event(second), event(mixed)], "any", true),
    appendCanonicalChatEvents(db, [event(second), event(mixed)], "any", false),
  ]);
  assert.equal(await watermark(second), 3);
  const id = randomUUID();
  await appendCanonicalChatEvents(db, [event(second, { id })], "id", true);
  assert.deepEqual(
    await appendCanonicalChatEvents(db, [event(second, { id })], "id", true),
    [],
  );
  const gap = await watermark(second);
  assert.equal(gap, 5);
  await assert.rejects(
    appendCanonicalChatEvents(
      db,
      [event(second, { eventType: "input.prompt" }), event(second)],
      "none",
      true,
    ),
  );
  assert.equal(await watermark(second), gap);
  const runId = randomUUID();
  await appendCanonicalChatEvents(
    db,
    [event(second, { runId, runEventSequenceNumber: 10 })],
    "any",
    true,
  );
  assert.deepEqual(
    await appendCanonicalChatEvents(
      db,
      [event(second, { runId, runEventSequenceNumber: 10 })],
      "any",
      false,
    ),
    [],
  );
  const [target] = await appendCanonicalChatEvents(
    db,
    [event(second)],
    "none",
    true,
  );
  assert.ok(target);
  const replacement = [
    event(second, { eventType: "control.revoke", revokesEventId: target.id }),
  ];
  const revocations = await Promise.all([
    appendCanonicalChatEvents(db, replacement, "any", true),
    appendCanonicalChatEvents(
      db,
      [
        event(second, {
          eventType: "control.revoke",
          revokesEventId: target.id,
        }),
      ],
      "any",
      false,
    ),
  ]);
  assert.equal(revocations.flat().length, 1);
  const terminal = [event(second, { runId, eventType: "run.completed" })];
  const completions = await Promise.all([
    appendCanonicalChatEvents(db, terminal, "run-lifecycle", true),
    appendCanonicalChatEvents(
      db,
      [event(second, { runId, eventType: "run.failed" })],
      "run-lifecycle",
      false,
    ),
  ]);
  assert.equal(completions.flat().length, 1);
  const beforeRetention = await watermark(second);
  await pool.query("DELETE FROM chat_events WHERE chat_thread_id=$1", [second]);
  const [afterRetention] = await appendCanonicalChatEvents(
    db,
    [event(second)],
    "none",
    true,
  );
  assert.equal(afterRetention?.seqId, beforeRetention + 1);
  // A normal control lock must remain compatible with the event FK KEY SHARE.
  const lock = await pool.connect();
  try {
    await lock.query("BEGIN");
    await lock.query(
      "SELECT id FROM chat_threads WHERE id=$1 FOR NO KEY UPDATE",
      [second],
    );
    const writer = await pool.connect();
    try {
      await writer.query("SET lock_timeout='1s'");
      await appendCanonicalChatEvents(
        drizzle(writer),
        [event(second)],
        "none",
        true,
      );
    } finally {
      writer.release();
    }
    await lock.query("COMMIT");
    // The stronger retained lock really blocks, demonstrating why controls use
    // NO KEY UPDATE rather than claiming the new sequence table removes all locks.
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM chat_threads WHERE id=$1 FOR UPDATE", [
      second,
    ]);
    const blocked = await pool.connect();
    try {
      await blocked.query("SET lock_timeout='100ms'");
      await assert.rejects(
        appendCanonicalChatEvents(
          drizzle(blocked),
          [event(second)],
          "none",
          true,
        ),
        (error: unknown) => {
          return (
            typeof error === "object" &&
            error !== null &&
            "cause" in error &&
            typeof error.cause === "object" &&
            error.cause !== null &&
            "code" in error.cause &&
            error.cause.code === "55P03"
          );
        },
      );
    } finally {
      blocked.release();
    }
    await lock.query("ROLLBACK");
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
  await pool.query(
    "UPDATE chat_event_write_control SET activated_at=now() WHERE id='global'",
  );
  assert.equal(await isSplitChatEventWriteEnabled(db), true);
  await assert.rejects(
    pool.query(
      "UPDATE chat_event_write_control SET activated_at=NULL WHERE id='global'",
    ),
  );
  await assert.rejects(pool.query("DELETE FROM chat_event_write_control"));
  // Planned PR2 shape: PR1 new mode cannot enumerate the retired physical field.
  await pool.query(
    "DROP TRIGGER bridge_chat_event_sequence_allocation ON chat_threads; DROP FUNCTION bridge_chat_event_sequence_allocation(); ALTER TABLE chat_threads DROP COLUMN last_chat_event_seq_id",
  );
  assert.doesNotMatch(
    db.insert(chatThreads).values({ userId: "fixture" }).returning().toSQL()
      .sql,
    /last_chat_event_seq_id/,
  );
  assert.doesNotMatch(
    db.select().from(chatThreads).toSQL().sql,
    /last_chat_event_seq_id/,
  );
  await appendCanonicalChatEvents(
    db,
    [event(second)],
    "none",
    await isSplitChatEventWriteEnabled(db),
  );
  await pool.query("DELETE FROM chat_threads WHERE id=$1", [second]);
  assert.equal(await watermark(second), 0);
  process.stdout.write(
    "Chat event sequence bridge, atomic writes, locks, retention and contraction passed\n",
  );
} finally {
  await fixture.close();
}

await verifyBackfillWithLegacyThreadLock();
await verifyOwnershipAndReceiptPreparation();
