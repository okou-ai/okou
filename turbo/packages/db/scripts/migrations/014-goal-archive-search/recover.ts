import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { Client } from "pg";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import { isRetiredGoalArchiveRow } from "@okouai/api-contracts/contracts/retired-goal-archive";
import { chatSearchIndexText } from "../../../../../apps/api/src/lib/chat-search-bigram";

export type RecoveryOutcome =
  | "unchanged"
  | "repairable"
  | "repaired"
  | "not-indexed"
  | "revoked"
  | "deleted";
export type SnapshotLoader = (key: string) => Promise<Buffer>;

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_metadata");
  return value;
}
function sequence(value: unknown): number {
  const result = typeof value === "string" ? Number(value) : value;
  if (
    typeof result !== "number" ||
    !Number.isSafeInteger(result) ||
    result < 0
  ) {
    throw new Error("invalid_sequence");
  }
  return result;
}

async function history(
  client: Client,
  threadId: string,
  loadSnapshot: SnapshotLoader,
): Promise<readonly ChatEventRow[]> {
  // A repeatable-read transaction sees the snapshot head and its PostgreSQL
  // tail at one revision even when retention concurrently deletes covered rows.
  const heads = await client.query<Record<string, unknown>>(
    `SELECT last_seq_id, terminal_seq_id, terminal_event_id, object_key
    FROM chat_event_snapshots WHERE chat_thread_id = $1 AND archive_schema_version = 7`,
    [threadId],
  );
  const head = heads.rows[0];
  const rows: ChatEventRow[] = [];
  let cursor = 0;
  if (head) {
    const key = text(head.object_key);
    if (!key.startsWith(`chat-events/${threadId}/`))
      throw new Error("invalid_snapshot_scope");
    const bytes = await loadSnapshot(key);
    const digest = /-([0-9a-f]{64})\.ndjson\.gz$/u.exec(key)?.[1];
    if (createHash("sha256").update(bytes).digest("hex") !== digest)
      throw new Error("invalid_snapshot_digest");
    const body = gunzipSync(bytes).toString("utf8");
    if (!body.endsWith("\n")) throw new Error("invalid_snapshot_lines");
    const lastSeqId = sequence(head.last_seq_id);
    for (const line of body.slice(0, -1).split("\n")) {
      const row = chatEventRowSchema.parse(JSON.parse(line));
      if (
        row.chatThreadId !== threadId ||
        row.seqId <= cursor ||
        row.seqId > lastSeqId
      )
        throw new Error("invalid_snapshot_order");
      rows.push(row);
      cursor = row.seqId;
    }
    if (
      head.terminal_seq_id !== null &&
      (rows.at(-1)?.id !== head.terminal_event_id ||
        cursor !== sequence(head.terminal_seq_id))
    )
      throw new Error("invalid_snapshot_terminal");
    cursor = lastSeqId;
  }
  for (;;) {
    const tail = await client.query<Record<string, unknown>>(
      `SELECT id, chat_thread_id AS "chatThreadId", event_type AS "eventType",
      run_id AS "runId", revokes_event_id AS "revokesEventId", context_type AS "contextType", context_id AS "contextId",
      run_event_sequence_number AS "runEventSequenceNumber", run_event_id AS "runEventId", payload,
      seq_id AS "seqId", to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
      CASE WHEN event_type = 'run.failed' THEN failure_reason END AS "failureReason"
      FROM chat_events WHERE chat_thread_id = $1 AND seq_id > $2 ORDER BY seq_id LIMIT 1000`,
      [threadId, cursor],
    );
    for (const raw of tail.rows) {
      const { failureReason, ...base } = raw;
      const row = chatEventRowSchema.parse({
        ...base,
        seqId: sequence(raw.seqId),
        ...(failureReason === null ? {} : { failureReason }),
      });
      rows.push(row);
      cursor = row.seqId;
    }
    if (tail.rows.length < 1000) return rows;
  }
}

function validateReceiptOwnership(candidate: Record<string, unknown>): void {
  if (
    candidate.goal_user_id !== candidate.user_id ||
    candidate.goal_agent_id !== candidate.agent_id ||
    candidate.goal_org_id !== candidate.org_id
  ) {
    throw new Error("invalid_receipt_ownership");
  }
}

function validateProjectionOwnership(
  existing: Record<string, unknown> | undefined,
  candidate: Record<string, unknown>,
): void {
  if (
    existing &&
    (existing.run_id !== null ||
      existing.role !== "assistant" ||
      existing.user_id !== candidate.user_id ||
      existing.org_id !== candidate.org_id ||
      existing.agent_id !== candidate.agent_id)
  ) {
    throw new Error("invalid_projection_ownership");
  }
}

async function repairProjection(
  client: Client,
  threadId: string,
  candidate: Record<string, unknown>,
  loadSnapshot: SnapshotLoader,
  migrate: boolean,
): Promise<RecoveryOutcome> {
  validateReceiptOwnership(candidate);
  const rows = await history(client, threadId, loadSnapshot);
  const row = rows.find((event) => {
    return event.id === candidate.event_id;
  });
  if (
    !row ||
    row.seqId !== sequence(candidate.seq_id) ||
    !isRetiredGoalArchiveRow(row) ||
    !row.payload?.content?.startsWith(
      `Okou Goal retired.\nGoal ID: ${text(candidate.id)}\n`,
    )
  ) {
    throw new Error("invalid_archive_receipt");
  }
  const revoked = rows.some((event) => {
    return event.revokesEventId === row.id;
  });
  const indexed = await client.query<Record<string, unknown>>(
    `SELECT run_id, user_id, org_id, agent_id, role, text, text_bigram
        FROM chat_event_search_messages WHERE chat_thread_id = $1 AND seq_id = $2`,
    [threadId, row.seqId],
  );
  const existing = indexed.rows[0];
  validateProjectionOwnership(existing, candidate);
  const content = row.payload.content;
  const bigram = chatSearchIndexText(content);
  if (revoked) {
    // Preserve the existing visibility rule, including snapshot revokers.
    if (!migrate && existing) return "repairable";
    if (migrate)
      await client.query(
        "DELETE FROM chat_event_search_messages WHERE chat_thread_id = $1 AND seq_id = $2",
        [threadId, row.seqId],
      );
    return "revoked";
  } else if (existing?.text === content && existing.text_bigram === bigram) {
    return "unchanged";
  } else if (!migrate) {
    return "repairable";
  } else {
    await client.query(
      `INSERT INTO chat_event_search_messages
          (chat_thread_id, seq_id, run_id, user_id, org_id, agent_id, role, created_at, text, text_bigram)
          VALUES ($1, $2, NULL, $3, $4, $5, 'assistant', $6, $7, $8)
          ON CONFLICT (chat_thread_id, seq_id) DO UPDATE SET text = EXCLUDED.text, text_bigram = EXCLUDED.text_bigram`,
      [
        threadId,
        row.seqId,
        text(candidate.user_id),
        text(candidate.org_id),
        text(candidate.agent_id),
        row.createdAt,
        content,
        bigram,
      ],
    );
    return "repaired";
  }
}

/** One receipt-scoped derived repair. Never changes raw history or watermarks. */
export async function recoverGoalArchiveSearch(
  client: Client,
  threadId: string,
  loadSnapshot: SnapshotLoader,
  migrate: boolean,
): Promise<RecoveryOutcome> {
  await client.query(
    migrate
      ? // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0362; new non-billing transactions are prohibited.
        "BEGIN ISOLATION LEVEL REPEATABLE READ"
      : // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0363; new non-billing transactions are prohibited.
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  try {
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const candidates = await client.query<Record<string, unknown>>(
      `SELECT goal.id, goal.retirement_archive_event_id AS event_id,
      goal.retirement_archive_seq_id AS seq_id, thread.user_id, agent.org_id, agent.id AS agent_id,
      watermark.indexed_seq_id, goal.owner_user_id AS goal_user_id, goal.agent_id AS goal_agent_id, goal.org_id AS goal_org_id
      FROM thread_goals goal JOIN chat_threads thread ON thread.id = goal.chat_thread_id
      JOIN agents agent ON agent.id = thread.agent_id
      LEFT JOIN chat_event_search_message_watermarks watermark ON watermark.chat_thread_id = thread.id
      WHERE thread.id = $1 AND goal.retirement_archive_event_id IS NOT NULL
      ${migrate ? "FOR SHARE OF thread, agent" : ""}`,
      [threadId],
    );
    const candidate = candidates.rows[0];
    let outcome: RecoveryOutcome;
    if (!candidate) {
      outcome = "deleted";
    } else if (
      candidate.indexed_seq_id === null ||
      sequence(candidate.indexed_seq_id) < sequence(candidate.seq_id)
    ) {
      // New code's normal projector still owns these rows. No history rebuild.
      outcome = "not-indexed";
    } else {
      outcome = await repairProjection(
        client,
        threadId,
        candidate,
        loadSnapshot,
        migrate,
      );
    }
    await client.query("COMMIT");
    return outcome;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
