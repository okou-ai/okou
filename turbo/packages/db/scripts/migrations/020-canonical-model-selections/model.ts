import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { chatThreadSnapshotArchiveSchema } from "@okouai/api-contracts/contracts/chat-threads";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";

const AUTO_KEYS = new Set(["auto", "okou-1.0", "okou-1.0-pro", "okou-1.0-max"]);
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const settingsSchema = z.record(z.string(), z.unknown());
const projectionSchema = z.looseObject({
  selectedModel: z.string().nullable().optional(),
  modelSettings: settingsSchema.optional(),
});
const archiveSchema = z.looseObject({ chatThreads: z.array(projectionSchema) });
const payloadSchema = z.looseObject({
  userMessage: z
    .looseObject({
      version: z.literal(1),
      parts: z.array(z.looseObject({ type: z.string() })),
    })
    .optional(),
});

export function sha256(body: Buffer | string): string {
  return createHash("sha256").update(body).digest("hex");
}
export function scopePrefix(user: string, org: string): string {
  return `chat-thread-snapshots/v1/${sha256(`${user}\0${org}`)}/`;
}
function settings(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => {
      return !AUTO_KEYS.has(key) && !key.startsWith("@preset/");
    }),
  );
}
export function migrateThreadSnapshot(compressed: Buffer) {
  const raw: unknown = JSON.parse(
    gunzipSync(compressed, { maxOutputLength: MAX_BODY_BYTES }).toString(
      "utf8",
    ),
  );
  assert(
    chatThreadSnapshotArchiveSchema.safeParse(raw).success,
    "invalid_thread_snapshot_contract",
  );
  const archive = archiveSchema.parse(raw);
  let changed = 0;
  const chatThreads = archive.chatThreads.map((thread) => {
    const model = thread.selectedModel;
    const auto = model === null || model === undefined || AUTO_KEYS.has(model);
    const normalized = {
      ...thread,
      selectedModel: auto ? "auto" : model,
      ...(auto ? { serviceTier: null } : {}),
      ...(thread.modelSettings === undefined
        ? {}
        : { modelSettings: settings(thread.modelSettings) }),
    };
    if (JSON.stringify(thread) !== JSON.stringify(normalized)) changed++;
    return normalized;
  });
  return {
    changed,
    body: changed
      ? gzipSync(Buffer.from(JSON.stringify({ ...archive, chatThreads })))
      : compressed,
  };
}
export function migrateEventSnapshot(
  compressed: Buffer,
  threadId: string,
  lastSeq: number,
  terminalId: string | null,
  terminalSeq: number,
) {
  const text = gunzipSync(compressed, {
    maxOutputLength: MAX_BODY_BYTES,
  }).toString("utf8");
  assert(text === "" || text.endsWith("\n"), "invalid_event_snapshot_framing");
  const lines = text === "" ? [] : text.slice(0, -1).split("\n");
  let previousSeq = 0;
  let lastId: string | null = null;
  let changed = 0;
  const result = lines.map((line) => {
    const raw: unknown = JSON.parse(line);
    const parsed = chatEventRowSchema.safeParse(raw);
    assert(parsed.success, "invalid_event_snapshot_contract");
    const row = parsed.data;
    assert(
      row.chatThreadId === threadId &&
        row.seqId > previousSeq &&
        row.seqId <= lastSeq,
      "invalid_event_snapshot_scope_or_order",
    );
    previousSeq = row.seqId;
    lastId = row.id;
    if (row.payload?.userMessage === undefined) return line;
    const payload = payloadSchema.parse(row.payload);
    assert(payload.userMessage, "missing_user_message");
    let migrated = false;
    const parts = payload.userMessage.parts.map((part) => {
      if (part.type !== "model" || part.selectedModel !== "okou-1.0")
        return part;
      const { serviceTier: _serviceTier, ...rest } = part;
      migrated = true;
      return { ...rest, selectedModel: "auto" };
    });
    if (!migrated) return line;
    changed++;
    return JSON.stringify({
      ...row,
      payload: { ...payload, userMessage: { ...payload.userMessage, parts } },
    });
  });
  assert(
    previousSeq === terminalSeq && lastId === terminalId,
    "invalid_event_snapshot_terminal_cursor",
  );
  return {
    changed,
    body: changed
      ? gzipSync(Buffer.from(result.length ? `${result.join("\n")}\n` : ""))
      : compressed,
  };
}
