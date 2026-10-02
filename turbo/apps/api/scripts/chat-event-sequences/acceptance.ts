import { parseRawRows } from "../../src/lib/db-raw-rows";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  appendCanonicalChatEventsSql,
  chatEventAppendResultSchema,
  type PreparedChatEventRow,
} from "../../src/signals/services/chat-event-append.service";
import { createSequenceFixture } from "./fixture";

// The atomic allocation contract cannot be constructed through a production
// API: it requires concurrent independent sessions, lock holders and faults.
const fixture = await createSequenceFixture();
const { pool, db } = fixture;
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
async function createThread(): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO chat_threads(id) VALUES($1)", [id]);
  return id;
}
try {
  // The first append creates the sequence row for an empty thread.
  const first = await createThread();
  assert.equal(await watermark(first), 0);
  const [firstRow] = parseRawRows(
    chatEventAppendResultSchema,
    await db.execute(appendCanonicalChatEventsSql([event(first)], "none")),
  );
  assert.equal(firstRow?.seqId, 1);
  assert.equal(await watermark(first), 1);
  const concurrent = await createThread();
  const concurrentPositions = (
    await Promise.all(
      Array.from({ length: 24 }, async () => {
        const rows = parseRawRows(
          chatEventAppendResultSchema,
          await db.execute(
            appendCanonicalChatEventsSql(
              [event(concurrent), event(concurrent)],
              "any",
            ),
          ),
        );
        return rows.map((row) => {
          return row.seqId;
        });
      }),
    )
  ).flat();
  assert.equal(new Set(concurrentPositions).size, 48);
  assert.equal(await watermark(concurrent), 48);
  const second = await createThread();
  await Promise.all([
    db
      .execute(
        appendCanonicalChatEventsSql([event(concurrent), event(second)], "any"),
      )
      .then((rawRows) => {
        return parseRawRows(chatEventAppendResultSchema, rawRows);
      }),
    db
      .execute(
        appendCanonicalChatEventsSql([event(second), event(concurrent)], "any"),
      )
      .then((rawRows) => {
        return parseRawRows(chatEventAppendResultSchema, rawRows);
      }),
    db
      .execute(
        appendCanonicalChatEventsSql([event(second), event(concurrent)], "any"),
      )
      .then((rawRows) => {
        return parseRawRows(chatEventAppendResultSchema, rawRows);
      }),
  ]);
  assert.equal(await watermark(second), 3);
  const id = randomUUID();
  parseRawRows(
    chatEventAppendResultSchema,
    await db.execute(
      appendCanonicalChatEventsSql([event(second, { id })], "id"),
    ),
  );
  assert.deepEqual(
    parseRawRows(
      chatEventAppendResultSchema,
      await db.execute(
        appendCanonicalChatEventsSql([event(second, { id })], "id"),
      ),
    ),
    [],
  );
  const gap = await watermark(second);
  assert.equal(gap, 5);
  await assert.rejects(
    db
      .execute(
        appendCanonicalChatEventsSql(
          [event(second, { eventType: "input.prompt" }), event(second)],
          "none",
        ),
      )
      .then((rawRows) => {
        return parseRawRows(chatEventAppendResultSchema, rawRows);
      }),
  );
  assert.equal(await watermark(second), gap);
  const runId = randomUUID();
  parseRawRows(
    chatEventAppendResultSchema,
    await db.execute(
      appendCanonicalChatEventsSql(
        [event(second, { runId, runEventSequenceNumber: 10 })],
        "any",
      ),
    ),
  );
  assert.deepEqual(
    parseRawRows(
      chatEventAppendResultSchema,
      await db.execute(
        appendCanonicalChatEventsSql(
          [event(second, { runId, runEventSequenceNumber: 10 })],
          "any",
        ),
      ),
    ),
    [],
  );
  const [target] = parseRawRows(
    chatEventAppendResultSchema,
    await db.execute(appendCanonicalChatEventsSql([event(second)], "none")),
  );
  assert.ok(target);
  const replacement = [
    event(second, { eventType: "control.revoke", revokesEventId: target.id }),
  ];
  const revocations = await Promise.all([
    db
      .execute(appendCanonicalChatEventsSql(replacement, "any"))
      .then((rawRows) => {
        return parseRawRows(chatEventAppendResultSchema, rawRows);
      }),
    db
      .execute(
        appendCanonicalChatEventsSql(
          [
            event(second, {
              eventType: "control.revoke",
              revokesEventId: target.id,
            }),
          ],
          "any",
        ),
      )
      .then((rawRows) => {
        return parseRawRows(chatEventAppendResultSchema, rawRows);
      }),
  ]);
  assert.equal(revocations.flat().length, 1);
  const terminal = [event(second, { runId, eventType: "run.completed" })];
  const completions = await Promise.all([
    db
      .execute(appendCanonicalChatEventsSql(terminal, "run-lifecycle"))
      .then((rawRows) => {
        return parseRawRows(chatEventAppendResultSchema, rawRows);
      }),
    db
      .execute(
        appendCanonicalChatEventsSql(
          [event(second, { runId, eventType: "run.failed" })],
          "run-lifecycle",
        ),
      )
      .then((rawRows) => {
        return parseRawRows(chatEventAppendResultSchema, rawRows);
      }),
  ]);
  assert.equal(completions.flat().length, 1);
  const beforeRetention = await watermark(second);
  await pool.query("DELETE FROM chat_events WHERE chat_thread_id=$1", [second]);
  const [afterRetention] = parseRawRows(
    chatEventAppendResultSchema,
    await db.execute(appendCanonicalChatEventsSql([event(second)], "none")),
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
      parseRawRows(
        chatEventAppendResultSchema,
        await drizzle(writer).execute(
          appendCanonicalChatEventsSql([event(second)], "none"),
        ),
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
        drizzle(blocked)
          .execute(appendCanonicalChatEventsSql([event(second)], "none"))
          .then((rawRows) => {
            return parseRawRows(chatEventAppendResultSchema, rawRows);
          }),
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
  await pool.query("DELETE FROM chat_threads WHERE id=$1", [second]);
  assert.equal(await watermark(second), 0);
  process.stdout.write(
    "Chat event sequence atomic writes, conflicts, gaps, rollback, retention and locks passed\n",
  );
} finally {
  await fixture.close();
}
