import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { z } from "zod";

import { safeJsonParse } from "../utils";

/**
 * Chat Event V8 transition code: adjacent Snapshot upgrades for immutable R2
 * objects written by an older API. Every V7 thread keeps its V7 pointer until
 * the cron (or a read-time refresh) publishes a V8 pointer beside it.
 *
 * Removed in the V8 plan's PR-3 once every Snapshot pointer is V8 (all
 * chat_event_snapshots.archive_schema_version = 8) and pre-V8 APIs have left
 * the production rollback window.
 */
export const PREVIOUS_CHAT_EVENT_SNAPSHOT_SCHEMA_VERSION = 7;

/** Snapshot versions a V8 API may read; see the transition note above. */
export const READABLE_CHAT_EVENT_SNAPSHOT_SCHEMA_VERSIONS = [
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
  PREVIOUS_CHAT_EVENT_SNAPSHOT_SCHEMA_VERSION,
] as const;

/** Lenient stored-row shape; the current strict schema validates the result. */
const storedSnapshotRowSchema = z.looseObject({
  id: z.string(),
  chatThreadId: z.string(),
  seqId: z.number().int(),
  eventType: z.string(),
  contextType: z.string().nullable(),
  contextId: z.string().nullable(),
});

type StoredSnapshotRow = z.infer<typeof storedSnapshotRowSchema>;

/** Row types that V8 deleted; their V7 rows have no V8 representation. */
function isV7DeletedEventType(eventType: string): boolean {
  switch (eventType) {
    case "input.goal":
    case "goal.open":
    case "goal.close":
    case "run.queued":
    case "run.dequeued":
    case "output.thinking":
    case "browser.open":
    case "browser.close": {
      return true;
    }
    default: {
      return false;
    }
  }
}

const goalUserMessagePartSchema = z.looseObject({
  type: z.literal("goal"),
  goalBrief: z.string(),
});

const userMessagePartsPayloadSchema = z.looseObject({
  userMessage: z.looseObject({ parts: z.array(z.unknown()) }),
});

function isV7InputRow(eventType: string): boolean {
  return eventType.startsWith("input.") || eventType === "control.revoke";
}

/** Replace every stored Goal part with a text part carrying its brief. */
function upgradeV7GoalParts(payload: unknown): unknown {
  const parsed = userMessagePartsPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return payload;
  }
  const { userMessage } = parsed.data;
  return {
    ...parsed.data,
    userMessage: {
      ...userMessage,
      parts: userMessage.parts.map((part) => {
        const goal = goalUserMessagePartSchema.safeParse(part);
        return goal.success
          ? { type: "text", text: goal.data.goalBrief }
          : part;
      }),
    },
  };
}

function upgradeV7Context(
  row: StoredSnapshotRow,
): Pick<ChatEventRow, "contextType" | "contextId"> | null {
  // V7 allowed a rejection without a context; V8 requires one on every input.
  if (row.contextType === null && row.eventType === "input.rejected") {
    return { contextType: "web", contextId: null };
  }
  switch (row.contextType) {
    case "goal": {
      return isV7InputRow(row.eventType)
        ? { contextType: "automation", contextId: null }
        : { contextType: null, contextId: null };
    }
    case "github": {
      return { contextType: "web", contextId: null };
    }
    default: {
      return null;
    }
  }
}

/**
 * V7 -> V8, identical to the hot-table rules of migration 1286: delete the
 * eight retired event types; Goal input rows become automation input with a
 * null context ID; other Goal rows lose their context; GitHub rows and
 * context-less rejections become web rows; Goal userMessage parts become text
 * parts. Every other row, including
 * the migration-1094 "Okou Goal retired." notices, is unchanged.
 */
function upgradeV7SnapshotRow(
  row: StoredSnapshotRow,
): StoredSnapshotRow | null {
  if (isV7DeletedEventType(row.eventType)) {
    return null;
  }
  const context = upgradeV7Context(row);
  return {
    ...row,
    ...context,
    payload: upgradeV7GoalParts(row.payload),
  };
}

/**
 * Every schema bump that can preserve historical data registers its adjacent
 * Snapshot upgrade here before the new version ships.
 */
function adjacentSnapshotUpgrade(
  sourceVersion: number,
):
  | ((rows: readonly StoredSnapshotRow[]) => readonly StoredSnapshotRow[])
  | undefined {
  switch (sourceVersion) {
    case 7: {
      return (rows) => {
        return rows.flatMap((row) => {
          const upgraded = upgradeV7SnapshotRow(row);
          return upgraded === null ? [] : [upgraded];
        });
      };
    }
    default: {
      return undefined;
    }
  }
}

function decodeStoredSnapshotRows(body: Buffer): readonly StoredSnapshotRow[] {
  const text = body.toString("utf8");
  if (text.length === 0) {
    return [];
  }
  if (!text.endsWith("\n")) {
    throw new Error("Chat Event snapshot must be newline-delimited JSON");
  }
  return text
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      const parsed = safeJsonParse(line);
      if (parsed === undefined) {
        throw new Error("Chat Event snapshot contains invalid JSON");
      }
      return storedSnapshotRowSchema.parse(parsed);
    });
}

function encodeChatEventSnapshotBody(rows: readonly ChatEventRow[]): Buffer {
  return Buffer.from(
    rows
      .map((row) => {
        return `${JSON.stringify(row)}\n`;
      })
      .join(""),
  );
}

/**
 * Upgrade an older stored Snapshot prefix to the current row contract. The
 * source rows are parsed only leniently; the result must satisfy the current
 * strict row schema. Callers keep the source pointer's physical coverage and
 * append PostgreSQL rows after it, which are already current.
 */
export function upgradeChatEventSnapshotBody(
  body: Buffer,
  sourceVersion: number,
): {
  readonly body: Buffer;
  readonly rows: readonly ChatEventRow[];
  /** Last stored row before the upgrade; it pairs with the source pointer. */
  readonly sourceTerminal: {
    readonly id: string | null;
    readonly seqId: number;
  };
} {
  if (sourceVersion > CURRENT_CHAT_EVENT_SCHEMA_VERSION) {
    throw new Error("Chat Event Snapshot is newer than this API");
  }
  let rows = decodeStoredSnapshotRows(body);
  const storedTerminal = rows.at(-1);
  const sourceTerminal = {
    id: storedTerminal?.id ?? null,
    seqId: storedTerminal?.seqId ?? 0,
  };
  for (
    let version = sourceVersion;
    version < CURRENT_CHAT_EVENT_SCHEMA_VERSION;
    version += 1
  ) {
    const upgrade = adjacentSnapshotUpgrade(version);
    if (upgrade === undefined) {
      throw new Error(
        `Missing Chat Event Snapshot upgrade from V${version.toString()} to V${(version + 1).toString()}`,
      );
    }
    rows = upgrade(rows);
  }
  const current = rows.map((row) => {
    return chatEventRowSchema.parse(row);
  });
  return {
    body:
      sourceVersion === CURRENT_CHAT_EVENT_SCHEMA_VERSION
        ? body
        : encodeChatEventSnapshotBody(current),
    rows: current,
    sourceTerminal,
  };
}
