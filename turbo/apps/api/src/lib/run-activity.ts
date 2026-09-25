import { createHash } from "node:crypto";
import type {
  RunActivityEntries,
  RunActivityEntry,
} from "@okouai/db/jsonb-contracts/run-activity-snapshot";
import type { AgentEvent } from "./event-consumer/verify";

const ACTIVITY_ENTRY_LIMIT = 16;
const ACTIVITY_BYTE_LIMIT = 16 * 1024;
const ACTIVITY_EXCERPT_LIMIT = 700;
const ACTIVITY_NAME_LIMIT = 100;
const ACTIVITY_CALL_ID_LIMIT = 160;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/**
 * Bound a projected string by code points, dropping the two code points that
 * PostgreSQL refuses inside a `jsonb` value: `U+0000` and unpaired surrogates.
 * Both are reachable from real tool output, and either one would reject the
 * whole snapshot write rather than the offending excerpt. Iterating by code
 * point also keeps truncation from splitting a surrogate pair into one.
 */
function boundedText(value: string, limit: number): string {
  return Array.from(value)
    .filter((character) => {
      // `Array.from` yields one non-empty code point per element.
      const code = character.codePointAt(0)!;
      return code !== 0 && (code < 0xd8_00 || code > 0xdf_ff);
    })
    .slice(0, limit)
    .join("");
}
export function activityExcerpt(value: string): string {
  return boundedText(value, ACTIVITY_EXCERPT_LIMIT);
}
function text(value: unknown): string {
  return typeof value === "string" ? activityExcerpt(value) : "";
}
// Accepted guest data already carries runtime masking. Select public fields only
// and additionally omit credential-shaped argument keys, including API-first data.
function boundedValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return text(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  if (depth >= 3) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((item) => {
      return boundedValue(item, depth + 1);
    });
  }
  return Object.fromEntries(
    Object.entries(record(value))
      .sort(([a], [b]) => {
        return a.localeCompare(b);
      })
      .slice(0, 16)
      .map(([key, item]) => {
        return [
          text(key),
          /secret|token|password|authorization|api[_-]?key|cookie/i.test(key)
            ? "[redacted]"
            : boundedValue(item, depth + 1),
        ];
      }),
  );
}
function excerpt(value: unknown): string {
  return typeof value === "string"
    ? text(value)
    : activityExcerpt(JSON.stringify(boundedValue(value)));
}
// Select text only: tool results may also contain images and private fields.
function publicToolResult(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      const block = record(part);
      return block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [];
    })
    .join("\n");
}
function hasPublicText(block: Record<string, unknown>): boolean {
  return (
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.trim().length > 0
  );
}
function projectEvent(event: AgentEvent): RunActivityEntry[] {
  const entries: RunActivityEntry[] = [];
  const add = (
    index: number,
    kind: RunActivityEntry["kind"],
    name: unknown,
    callId: unknown,
    value: unknown,
  ) => {
    const content = excerpt(value);
    if (content || typeof name === "string") {
      entries.push({
        sequence: event.sequenceNumber,
        index,
        kind,
        name: boundedText(text(name), ACTIVITY_NAME_LIMIT),
        callId: boundedText(text(callId), ACTIVITY_CALL_ID_LIMIT),
        excerpt: content,
      });
      if (entries.length > ACTIVITY_ENTRY_LIMIT) {
        entries.shift();
      }
    }
  };
  if (event.type === "assistant" || event.type === "user") {
    const message = record(event.message);
    if (Array.isArray(message.content)) {
      for (const [index, raw] of message.content.entries()) {
        const block = record(raw);
        if (event.type === "assistant" && hasPublicText(block)) {
          add(index, "message", "", "", block.text);
        } else if (event.type === "assistant" && block.type === "tool_use") {
          add(index, "tool", block.name, block.id, block.input);
        } else if (block.type === "tool_result") {
          const content = publicToolResult(block.content);
          add(index, "result", "", block.tool_use_id, content);
        }
      }
    }
  }
  if (["item.started", "item.updated", "item.completed"].includes(event.type)) {
    const item = record(event.item);
    if (item.type === "agent_message" && typeof item.text === "string") {
      add(0, "message", "", "", item.text);
    } else if (item.type === "command_execution") {
      add(0, "tool", "command", item.id, item.command);
    } else if (item.type === "mcp_tool_call" || item.type === "function_call") {
      add(0, "tool", item.tool ?? item.name, item.id, item.arguments);
    } else if (item.type === "function_call_output") {
      add(0, "result", item.name, item.id, item.output);
    } else if (item.type === "web_search") {
      add(0, "tool", "search", item.id, item.query);
    }
  }
  return entries;
}
// Reserve whitespace expansion used by PostgreSQL's jsonb::text representation.
function storageBytes(entries: RunActivityEntries): number {
  return Buffer.byteLength(JSON.stringify(entries, null, 1), "utf8");
}
function canonicalEntry(entry: RunActivityEntry): RunActivityEntry {
  return {
    sequence: entry.sequence,
    index: entry.index,
    kind: entry.kind,
    name: entry.name,
    callId: entry.callId,
    excerpt: entry.excerpt,
  };
}

export function mergeActivity(
  entries: RunActivityEntries,
  events: readonly AgentEvent[],
): RunActivityEntries {
  const byId = new Map(
    entries.map((entry) => {
      return [`${entry.sequence}:${entry.index}`, canonicalEntry(entry)];
    }),
  );
  for (const event of events) {
    for (const entry of projectEvent(event)) {
      const key = `${entry.sequence}:${entry.index}`;
      const prior = byId.get(key);
      // Conflicting duplicates converge deterministically without arrival-order rollback.
      if (!prior || JSON.stringify(entry) < JSON.stringify(prior)) {
        byId.set(key, entry);
      }
      if (byId.size > ACTIVITY_ENTRY_LIMIT) {
        const oldest = [...byId.values()].sort((a, b) => {
          return a.sequence - b.sequence || a.index - b.index;
        })[0]!;
        byId.delete(`${oldest.sequence}:${oldest.index}`);
      }
    }
  }
  const merged = [...byId.values()]
    .sort((a, b) => {
      return a.sequence - b.sequence || a.index - b.index;
    })
    .slice(-ACTIVITY_ENTRY_LIMIT);
  while (storageBytes(merged) > ACTIVITY_BYTE_LIMIT) {
    merged.shift();
  }
  return merged;
}
export function activityRevision(entries: RunActivityEntries): string {
  return createHash("sha256")
    .update(JSON.stringify(entries.map(canonicalEntry)))
    .digest("hex");
}
function activityPhrase(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const line = value.trim();
  if (
    !line ||
    Array.from(line).some((character) => {
      return (
        character.charCodeAt(0) < 32 ||
        character === "\u2028" ||
        character === "\u2029"
      );
    }) ||
    /^(?:[#>*-]|\d+[.)]\s|["'`“])|[`*_]|\[[^\]]+\]\(/u.test(line)
  ) {
    return null;
  }
  return [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line),
  ]
    .slice(0, 60)
    .map((part) => {
      return part.segment;
    })
    .join("")
    .trimEnd();
}

export function activityPhrases(value: string | null): string[] | null {
  if (value === null) {
    return null;
  }
  const lines = value
    .trim()
    .split(/\r?\n/u)
    .filter((line) => {
      return line.trim();
    });
  if (lines.length === 0 || lines.length > 4) {
    return null;
  }
  const phrases = lines.map(activityPhrase);
  if (
    phrases.some((phrase) => {
      return phrase === null;
    })
  ) {
    return null;
  }
  return [
    ...new Set(
      phrases.filter((phrase) => {
        return phrase !== null;
      }),
    ),
  ];
}
