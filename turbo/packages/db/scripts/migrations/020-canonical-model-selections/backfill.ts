#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Client } from "pg";
import { z } from "zod";
import {
  migrateEventSnapshot,
  migrateThreadSnapshot,
  scopePrefix,
  sha256,
} from "./model";

const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
const headSchema = z.object({
  object_key: z.string(),
  cursor: z
    .string()
    .regex(/^[0-9]+$/u)
    .nullable(),
  updated_at: z.string().optional(),
  id: z.string().uuid().optional(),
  last_event_id: z.string().uuid().optional(),
  latest_event_id: z.string().uuid().nullable().optional(),
  terminal_event_id: z.string().uuid().nullable().optional(),
  terminal_seq_id: z
    .string()
    .regex(/^[0-9]+$/u)
    .optional(),
});
function requiredEnv(name: string): string {
  const value = process.env[name];
  assert(value, `missing_configuration:${name}`);
  return value;
}
function sequence(value: string | null): number {
  const n = Number(value ?? "0");
  assert(Number.isSafeInteger(n) && n >= 0, "unsafe_snapshot_cursor");
  return n;
}
async function readObject(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<Buffer> {
  const result = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  assert(
    result.Body &&
      result.ContentLength !== undefined &&
      result.ContentLength <= MAX_COMPRESSED_BYTES,
    "invalid_or_oversize_snapshot",
  );
  const body = Buffer.from(await result.Body.transformToByteArray());
  assert(
    body.length === result.ContentLength && body.length <= MAX_COMPRESSED_BYTES,
    "snapshot_size_changed",
  );
  return body;
}
export async function backfill(
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly threadId?: string;
    readonly migrate: boolean;
  },
  db: Client,
  s3: S3Client,
  bucket: string,
) {
  // An event head's owner is proven through its thread and agent, not its key.
  // Agentless/deleted ownership cannot authorize an external rewrite.
  const query = args.threadId
    ? await db.query(
        `SELECT snapshot.id, snapshot.object_key, snapshot.last_seq_id::text AS cursor,
        snapshot.last_event_id, snapshot.terminal_event_id, snapshot.terminal_seq_id::text
      FROM chat_event_snapshots AS snapshot
      JOIN chat_threads AS thread ON thread.id = snapshot.chat_thread_id
      JOIN agents AS agent ON agent.id = thread.agent_id
      WHERE snapshot.chat_thread_id = $1 AND snapshot.archive_schema_version = 8
        AND thread.user_id = $2 AND agent.org_id = $3`,
        [args.threadId, args.userId, args.orgId],
      )
    : await db.query(
        `SELECT object_key, latest_event_seq_id::text AS cursor, updated_at::text, latest_event_id
      FROM chat_thread_snapshots WHERE user_id = $1 AND org_id = $2`,
        [args.userId, args.orgId],
      );
  assert(query.rows.length <= 1, "ambiguous_snapshot_head");
  if (!query.rows.length)
    return { heads: 0, changedRows: 0, published: 0, conflicts: 0 };
  const head = headSchema.parse(query.rows[0]);
  const cursor = sequence(head.cursor);
  const prefix = args.threadId
    ? `chat-events/${args.threadId}/`
    : scopePrefix(args.userId, args.orgId);
  assert(head.object_key.startsWith(prefix), "snapshot_owner_mismatch");
  const suffix = head.object_key.slice(prefix.length);
  const pattern = args.threadId
    ? /^([0-9]+)(?:-r1)?-([0-9a-f]{64})\.ndjson\.gz$/u
    : /^([0-9]+)-([0-9a-f]{64})\.json\.gz$/u;
  const match = pattern.exec(suffix);
  assert(match?.[1] === String(cursor), "snapshot_key_cursor_mismatch");
  const original = await readObject(s3, bucket, head.object_key);
  assert(sha256(original) === match[2], "snapshot_content_hash_mismatch");
  let result;
  if (args.threadId) {
    assert(
      head.terminal_event_id !== undefined &&
        head.terminal_seq_id !== undefined,
      "missing_terminal_cursor",
    );
    result = migrateEventSnapshot(
      original,
      args.threadId,
      cursor,
      head.terminal_event_id,
      sequence(head.terminal_seq_id),
    );
  } else {
    result = migrateThreadSnapshot(original);
  }
  if (!result.changed || !args.migrate)
    return {
      heads: 1,
      changedRows: result.changed,
      published: 0,
      conflicts: 0,
    };
  const key = args.threadId
    ? `${prefix}${cursor}-r1-${sha256(result.body)}.ndjson.gz`
    : `${prefix}${cursor}-${sha256(result.body)}.json.gz`;
  assert(
    result.body.length <= MAX_COMPRESSED_BYTES,
    "oversize_migrated_snapshot",
  );
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: result.body,
        ContentType: args.threadId
          ? "application/x-ndjson"
          : "application/json",
        ContentEncoding: "gzip",
        IfNoneMatch: "*",
      }),
    );
  } catch (error) {
    if (!(error instanceof Error && error.name === "PreconditionFailed"))
      throw error;
    assert(
      (await readObject(s3, bucket, key)).equals(result.body),
      "snapshot_destination_conflict",
    );
  }
  // Uploaded content is immutable. A failed/stale CAS leaves a harmless object;
  // rerun reads the current head and reconciles it. Never delete either version.
  const published = args.threadId
    ? await db.query(
        `UPDATE chat_event_snapshots AS snapshot SET object_key = $1
        WHERE id = $2 AND object_key = $3 AND last_seq_id = $4 AND last_event_id = $5
          AND terminal_event_id IS NOT DISTINCT FROM $6::uuid AND terminal_seq_id = $7
          AND archive_schema_version = 8 AND EXISTS (
            SELECT 1 FROM chat_threads AS thread JOIN agents AS agent ON agent.id = thread.agent_id
            WHERE thread.id = snapshot.chat_thread_id AND thread.user_id = $8 AND agent.org_id = $9
          ) RETURNING id`,
        [
          key,
          head.id,
          head.object_key,
          head.cursor,
          head.last_event_id,
          head.terminal_event_id,
          head.terminal_seq_id,
          args.userId,
          args.orgId,
        ],
      )
    : await db.query(
        `UPDATE chat_thread_snapshots SET object_key = $1, updated_at = now()
        WHERE user_id = $2 AND org_id = $3 AND object_key = $4
          AND latest_event_seq_id IS NOT DISTINCT FROM $5::bigint AND updated_at = $6::timestamp
          AND latest_event_id IS NOT DISTINCT FROM $7::uuid
        RETURNING user_id`,
        [
          key,
          args.userId,
          args.orgId,
          head.object_key,
          head.cursor,
          head.updated_at,
          head.latest_event_id,
        ],
      );
  return {
    heads: 1,
    changedRows: result.changed,
    published: published.rowCount ?? 0,
    conflicts: published.rowCount === 0 ? 1 : 0,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "user-id": { type: "string" },
      "org-id": { type: "string" },
      "thread-id": { type: "string" },
      migrate: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "backfill.ts --user-id <owner> --org-id <org> [--thread-id <event-thread>] [--migrate]\nOne owned head per invocation; read-only dry-run by default. No native-history writes.",
    );
    return;
  }
  assert(values["user-id"] && values["org-id"], "user-id_and_org-id_required");
  if (values["thread-id"]) z.uuid().parse(values["thread-id"]);
  const db = new Client({ connectionString: requiredEnv("DATABASE_URL") });
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${requiredEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
  try {
    await db.connect();
    const report = await backfill(
      {
        userId: values["user-id"],
        orgId: values["org-id"],
        threadId: values["thread-id"],
        migrate: values.migrate,
      },
      db,
      s3,
      requiredEnv("R2_USER_STORAGES_BUCKET_NAME"),
    );
    console.log(JSON.stringify(report));
    if (report.conflicts) process.exitCode = 2;
  } finally {
    await db.end();
    s3.destroy();
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
