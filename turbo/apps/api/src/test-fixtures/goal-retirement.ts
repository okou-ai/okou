import { reserveFixtureChatEventSequence } from "./chat-event-sequences";
import { randomUUID } from "node:crypto";
import { db } from "../lib/db";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { Client } from "pg";
import { env } from "../lib/env";
import { visiblePiMemoryCitationText } from "@okouai/api-contracts/contracts/pi-memory-citations";

/**
 * Current APIs cannot construct retained historical or malformed rows.
 * Temporary updatable views scope these fixtures to one test-owned thread.
 */
async function withGoalRetirementFixture(
  threadId: string,
  work: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: env("DATABASE_URL") });
  const runFixture = async () => {
    await client.connect();
    await client.query(
      "SELECT set_config('test.goal_retirement_thread', $1, false)",
      [threadId],
    );
    await client.query(`
      CREATE TEMP VIEW chat_threads AS SELECT * FROM public.chat_threads WHERE id = current_setting('test.goal_retirement_thread')::uuid;
      CREATE TEMP VIEW chat_events AS SELECT * FROM public.chat_events WHERE chat_thread_id = current_setting('test.goal_retirement_thread')::uuid;
      CREATE TEMP VIEW agents AS SELECT * FROM public.agents WHERE id IN (SELECT agent_id FROM pg_temp.chat_threads);
      SET search_path TO pg_temp, public;
    `);
    await work(client);
  };
  const [result] = await Promise.allSettled([runFixture()]);
  await client.end();
  if (result.status === "rejected") {
    throw result.reason;
  }
}

export async function removeSnapshottedGoalFixtureEvents(
  threadId: string,
): Promise<void> {
  await withGoalRetirementFixture(threadId, async (client) => {
    // Simulate the later retention deletion after real snapshot/search
    // publication, without changing immutable timestamps or any trigger.
    await client.query(`DELETE FROM chat_events event USING public.chat_event_snapshots snapshot, public.chat_event_search_message_watermarks watermark
      WHERE event.chat_thread_id = snapshot.chat_thread_id AND event.chat_thread_id = watermark.chat_thread_id
        AND snapshot.archive_schema_version = 7 AND snapshot.last_seq_id >= event.seq_id
        AND watermark.indexed_seq_id >= event.seq_id`);
  });
}

/** Old API materialization cannot be requested after the reader is repaired. */
export async function seedFilteredGoalArchiveProjections(
  threadId: string,
): Promise<string> {
  let shareId: string | undefined;
  await withGoalRetirementFixture(threadId, async (client) => {
    const result = await client.query<
      Record<string, unknown>
    >(`SELECT event.payload->>'content' AS content, event.seq_id,
      event.created_at, thread.user_id, agent.id AS agent_id, agent.org_id
      FROM chat_events event
      JOIN chat_threads thread ON thread.id = event.chat_thread_id JOIN agents agent ON agent.id = thread.agent_id
      WHERE event.event_type = 'output.message' AND event.run_id IS NULL
        AND starts_with(event.payload->>'content', E'Okou Goal retired.\\nGoal ID: ')
      ORDER BY event.seq_id DESC LIMIT 1`);
    const row = result.rows[0];
    if (!row || typeof row.content !== "string") {
      throw new Error("Expected archive fixture");
    }
    const filtered = visiblePiMemoryCitationText(row.content).trim();
    const share = await client.query<Record<string, unknown>>(
      `INSERT INTO shared_threads (user_id, source_chat_thread_id, title, messages)
      VALUES ($1, $2, 'Historical public copy', $3) RETURNING id`,
      [
        row.user_id,
        threadId,
        JSON.stringify([
          { messageIndex: 0, role: "assistant", content: filtered },
        ]),
      ],
    );
    if (typeof share.rows[0]?.id !== "string") {
      throw new Error("Expected historical share");
    }
    shareId = share.rows[0].id;
  });
  if (shareId === undefined) {
    throw new Error("Expected historical share ID");
  }
  return shareId;
}

/** Current writers cannot produce extra payload keys on assistant output. */
export async function seedMalformedGoalArchiveFixture(
  threadId: string,
  content: string,
): Promise<string> {
  let eventId: string | undefined;
  await withGoalRetirementFixture(threadId, async (client) => {
    const payload = Object.fromEntries([
      ["content", content],
      ["__proto__", "historical extra key"],
    ]);
    const rows = await client.query<Record<string, unknown>>(
      `WITH reservation AS (
        INSERT INTO chat_event_sequences (chat_thread_id, last_seq_id)
        SELECT id, 1 FROM chat_threads ORDER BY id
        ON CONFLICT (chat_thread_id) DO UPDATE SET last_seq_id = chat_event_sequences.last_seq_id + 1
        RETURNING chat_thread_id AS id, last_seq_id
      ) INSERT INTO chat_events (chat_thread_id, event_type, seq_id, payload)
      SELECT id, 'output.message', last_seq_id, $1 FROM reservation RETURNING id`,
      [JSON.stringify(payload)],
    );
    if (typeof rows.rows[0]?.id !== "string") {
      throw new Error("Expected malformed historical event ID");
    }
    eventId = rows.rows[0].id;
  });
  if (eventId === undefined) {
    throw new Error("Expected malformed historical event ID");
  }
  return eventId;
}

/** Seed a retained Goal-context message through historical storage, not current writers. */
export async function seedRetainedGoalGroupedOutput(
  threadId: string,
  goalId: string,
): Promise<string> {
  const [event] = await db().transaction(async (tx) => {
    const seqId = await reserveFixtureChatEventSequence(tx, threadId, 1);
    return await tx
      .insert(chatEvents)
      .values({
        chatThreadId: threadId,
        eventType: "output.message",
        contextType: "goal",
        contextId: goalId,
        payload: { content: "Retained Goal grouped output" },
        seqId,
      })
      .returning({ id: chatEvents.id });
  });
  if (!event) {
    throw new Error("Expected retained Goal-context message");
  }
  return event.id;
}

/** Permanent history fixtures contain only canonical retained events after S5. */
export async function seedLiteralGoalArchive(
  threadId: string,
  objective: string,
  status: "active" | "paused" | "blocked" | "complete" = "active",
): Promise<string> {
  const goalId = randomUUID();
  const content = `Okou Goal retired.\nGoal ID: ${goalId}\nOriginal recorded status: ${status}\n${
    status === "active"
      ? "Retirement changed this Goal from active to paused; this does not mark the objective complete."
      : "The recorded status is preserved; retirement does not mark the objective complete."
  }\n\nFull original objective:\n${objective}`;
  await db().transaction(async (tx) => {
    const thread = {
      seqId: await reserveFixtureChatEventSequence(tx, threadId, 2),
    };
    if (!thread) {
      throw new Error("Expected an owned history fixture thread");
    }
    await tx.insert(chatEvents).values([
      {
        chatThreadId: threadId,
        eventType: "output.message",
        payload: { content },
        seqId: thread.seqId - 1,
      },
      { chatThreadId: threadId, eventType: "goal.close", seqId: thread.seqId },
    ]);
  });
  return goalId;
}
