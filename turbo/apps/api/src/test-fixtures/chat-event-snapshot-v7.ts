import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { chatEventSequences } from "@okouai/db/schema/chat-event-sequence";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";

import { nowDate } from "../lib/time";
import { writeDb$ } from "../signals/external/db";
import { PREVIOUS_CHAT_EVENT_SNAPSHOT_SCHEMA_VERSION } from "../signals/services/chat-event-snapshot-upgrade.service";

/**
 * Chat Event V8 transition fixture: a V7 Snapshot pointer written by a pre-V8
 * API. Removed with the V7 -> V8 Snapshot upgrade in PR-3 once every Snapshot
 * pointer is V8.
 */
export interface V7ChatEventSnapshotFixture {
  readonly objectKey: string;
  readonly body: Buffer;
  readonly rows: readonly (Readonly<Record<string, unknown>> & {
    readonly id: string;
    readonly seqId: number;
  })[];
  readonly lastSeqId: number;
}

/**
 * Reserves sequence positions after the thread's current rows, assigns them to
 * the given V7 row templates, and points a V7 Snapshot at the resulting NDJSON
 * body. The caller stores `body` under `objectKey` in the fake R2.
 */
export const seedV7ChatEventSnapshot$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly rows: readonly Readonly<Record<string, unknown>>[];
    },
    signal: AbortSignal,
  ): Promise<V7ChatEventSnapshotFixture> => {
    const database = set(writeDb$);
    const reserved = args.rows.length + 1;
    const [sequence] = await database
      .insert(chatEventSequences)
      .values({ chatThreadId: args.chatThreadId, lastSeqId: reserved })
      .onConflictDoUpdate({
        target: chatEventSequences.chatThreadId,
        set: {
          lastSeqId: sql`${chatEventSequences.lastSeqId} + ${reserved}`,
        },
      })
      .returning({ lastSeqId: chatEventSequences.lastSeqId });
    signal.throwIfAborted();
    if (sequence === undefined) {
      throw new Error("Expected a reserved V7 snapshot sequence range");
    }
    const firstSeqId = sequence.lastSeqId - reserved + 1;
    const rows = args.rows.map((template, index) => {
      return {
        id: randomUUID(),
        chatThreadId: args.chatThreadId,
        runId: null,
        revokesEventId: null,
        contextType: null,
        contextId: null,
        runEventSequenceNumber: null,
        runEventId: null,
        seqId: firstSeqId + index,
        createdAt: nowDate().toISOString(),
        payload: null,
        ...template,
      };
    });
    const terminal = rows.at(-1);
    if (terminal === undefined) {
      throw new Error("Expected V7 snapshot fixture rows");
    }
    const body = gzipSync(
      Buffer.from(
        rows
          .map((row) => {
            return `${JSON.stringify(row)}\n`;
          })
          .join(""),
      ),
    );
    const lastSeqId = sequence.lastSeqId;
    const objectKey = `chat-events/${args.chatThreadId}/${lastSeqId.toString()}-r1-${createHash("sha256").update(body).digest("hex")}.ndjson.gz`;
    await database.insert(chatEventSnapshots).values({
      chatThreadId: args.chatThreadId,
      lastSeqId,
      // The unused final reservation stands in for a reclaimed physical row.
      lastEventId: randomUUID(),
      terminalEventId: terminal.id,
      terminalSeqId: terminal.seqId,
      archiveSchemaVersion: PREVIOUS_CHAT_EVENT_SNAPSHOT_SCHEMA_VERSION,
      objectKey,
    });
    signal.throwIfAborted();
    return { objectKey, body, rows, lastSeqId };
  },
);

/** V7 rows covering every V7 -> V8 rewrite rule, ending in a deleted row. */
export function v7SnapshotUpgradeTemplates(): {
  readonly templates: readonly Readonly<Record<string, unknown>>[];
  /** Expected V8 rows, matched by template index. */
  readonly expected: readonly {
    readonly index: number;
    readonly fields: Readonly<Record<string, unknown>>;
  }[];
} {
  const goalId = randomUUID();
  const notice = `Okou Goal retired.\nGoal ID: ${goalId}\nOriginal recorded status: paused\nThe recorded status is preserved; retirement does not mark the objective complete.\n\nFull original objective:\nShip the weekly report`;
  const templates = [
    {
      eventType: "input.prompt",
      contextType: "goal",
      contextId: goalId,
      payload: {
        userMessage: {
          version: 1,
          parts: [{ type: "goal", goalBrief: "Ship the weekly report" }],
        },
      },
    },
    {
      eventType: "input.goal",
      contextType: "goal",
      contextId: goalId,
      payload: {
        userMessage: {
          version: 1,
          parts: [{ type: "goal", goalBrief: "Ship the weekly report" }],
        },
      },
    },
    {
      eventType: "output.message",
      contextType: "goal",
      contextId: goalId,
      payload: { content: "Goal progress" },
    },
    { eventType: "output.thinking", payload: { content: "reasoning" } },
    {
      eventType: "input.prompt",
      contextType: "github",
      contextId: randomUUID(),
      payload: {
        userMessage: { version: 1, parts: [{ type: "text", text: "Review" }] },
      },
    },
    { eventType: "output.message", payload: { content: notice } },
    { eventType: "browser.close" },
  ];
  return {
    templates,
    expected: [
      {
        index: 0,
        fields: {
          eventType: "input.prompt",
          contextType: "automation",
          contextId: null,
          payload: {
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "Ship the weekly report" }],
            },
          },
        },
      },
      {
        index: 2,
        fields: {
          eventType: "output.message",
          contextType: null,
          contextId: null,
          payload: { content: "Goal progress" },
        },
      },
      {
        index: 4,
        fields: {
          eventType: "input.prompt",
          contextType: "web",
          contextId: null,
        },
      },
      {
        index: 5,
        fields: {
          eventType: "output.message",
          contextType: null,
          payload: { content: notice },
        },
      },
    ],
  };
}
