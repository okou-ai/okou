import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSequenceFixture, sequenceMigration } from "./fixture";

/** A draining Web writer retains its old strong thread lock during expansion. */
export async function verifyBackfillWithLegacyThreadLock() {
  const fixture = await createSequenceFixture();
  const writer = await fixture.pool.connect();
  const backfill = await fixture.pool.connect();
  const threadId = randomUUID();
  try {
    await writer.query(
      "INSERT INTO chat_threads(id,last_chat_event_seq_id) VALUES($1,100)",
      [threadId],
    );
    for (const statement of await sequenceMigration(
      "chat_event_sequence_bridge",
    )) {
      await writer.query(statement);
    }
    const statements = await sequenceMigration("backfill_chat_event_sequences");
    const callIndex = statements.findIndex((statement) => {
      return statement.includes('CALL "backfill_chat_event_sequences"');
    });
    assert.ok(callIndex > 0);
    for (const statement of statements.slice(0, callIndex)) {
      await backfill.query(statement);
    }
    await writer.query("SET statement_timeout='5s'");
    await backfill.query("SET statement_timeout='5s'; SET lock_timeout='5s'");
    const backend = await backfill.query("SELECT pg_backend_pid() AS pid");
    const backendId: number = backend.rows[0]?.pid;
    assert.ok(backendId);
    await writer.query("BEGIN");
    await writer.query("SELECT id FROM chat_threads WHERE id=$1 FOR UPDATE", [
      threadId,
    ]);
    const running = Promise.allSettled([
      backfill.query(statements[callIndex] ?? ""),
    ]);
    const deadline = AbortSignal.timeout(5000);
    // Observe the actual lock wait instead of assuming a sleep schedules it.
    for (;;) {
      deadline.throwIfAborted();
      const activity = await fixture.pool.query(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1 AND state='active'",
        [backendId],
      );
      if (activity.rows[0]?.wait_event_type === "Lock") {
        break;
      }
    }
    const [allocation] = await Promise.allSettled([
      writer.query(
        "UPDATE chat_threads SET last_chat_event_seq_id=last_chat_event_seq_id+1 WHERE id=$1 RETURNING last_chat_event_seq_id",
        [threadId],
      ),
    ]);
    await writer.query(
      allocation?.status === "fulfilled" ? "COMMIT" : "ROLLBACK",
    );
    const [copied] = await running;
    assert.equal(
      allocation?.status,
      "fulfilled",
      "legacy allocation must not deadlock with backfill",
    );
    if (allocation?.status === "fulfilled") {
      assert.equal(allocation.value.rows[0]?.last_chat_event_seq_id, "101");
    }
    // Preserve SQLSTATE/deadlock diagnostics if this lock-order contract regresses.
    assert.ifError(copied?.status === "rejected" ? copied.reason : undefined);
    for (const statement of statements.slice(callIndex + 1)) {
      await backfill.query(statement);
    }
    assert.equal(
      (
        await writer.query(
          "SELECT last_seq_id FROM chat_event_sequences WHERE chat_thread_id=$1",
          [threadId],
        )
      ).rows[0]?.last_seq_id,
      "101",
    );
    process.stdout.write(
      "Missing-sequence backfill preserves legacy strong-thread-lock ordering\n",
    );
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
    backfill.release();
    await fixture.close();
  }
}
