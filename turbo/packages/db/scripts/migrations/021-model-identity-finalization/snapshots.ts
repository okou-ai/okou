#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { S3Client } from "@aws-sdk/client-s3";
import { Client } from "pg";
import { z } from "zod";
import { backfill } from "../020-canonical-model-selections/backfill";

const ownerSchema = z.object({
  user_id: z.string().nullable(),
  org_id: z.string().nullable(),
  thread_id: z.uuid().nullable(),
  cursor: z.string(),
  supported: z.boolean(),
});
function requiredEnv(name: string) {
  const value = process.env[name];
  assert(value, `missing_configuration:${name}`);
  return value;
}
function decodeThreadCursor(kind: "threads" | "events", after: string | null) {
  if (after === null) return null;
  if (kind === "events") {
    z.uuid().parse(after);
    return null;
  }
  return z.tuple([z.string(), z.string()]).parse(JSON.parse(after));
}
async function main() {
  const { values } = parseArgs({
    options: {
      kind: { type: "string" },
      after: { type: "string" },
      limit: { type: "string", default: "100" },
      migrate: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "snapshots.ts --kind threads|events [--after <cursor>] [--limit 100] [--migrate]\nBounded inventory page, read-only by default. Save nextCursor and repeat; restart from the beginning to reconcile conflicts. Old objects are never deleted.",
    );
  } else {
    const kind = z.enum(["threads", "events"]).parse(values.kind);
    const limit = z.coerce.number().int().min(1).max(1000).parse(values.limit);
    const after = values.after ?? null;
    const threadAfter = decodeThreadCursor(kind, after);
    const db = new Client({
      connectionString: requiredEnv("DATABASE_URL"),
      statement_timeout: 10_000,
    });
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
      const result =
        kind === "events"
          ? await db.query(
              `SELECT t.user_id, a.org_id, s.chat_thread_id::text AS thread_id,
          s.chat_thread_id::text AS cursor, s.archive_schema_version = 8 AS supported
        FROM chat_event_snapshots s LEFT JOIN chat_threads t ON t.id = s.chat_thread_id
        LEFT JOIN agents a ON a.id = t.agent_id
        WHERE ($1::uuid IS NULL OR s.chat_thread_id > $1::uuid) ORDER BY s.chat_thread_id LIMIT $2`,
              [after, limit],
            )
          : await db.query(
              `SELECT user_id, org_id, NULL::text AS thread_id,
          json_build_array(user_id,org_id)::text AS cursor, true AS supported FROM chat_thread_snapshots
        WHERE ($1::text IS NULL OR (user_id,org_id) > ($1::text,$2::text)) ORDER BY user_id,org_id LIMIT $3`,
              [threadAfter?.[0] ?? null, threadAfter?.[1] ?? null, limit],
            );
      const page = z.array(ownerSchema).parse(result.rows);
      const total = {
        scanned: page.length,
        heads: 0,
        changedRows: 0,
        published: 0,
        conflicts: 0,
        unresolvedOwner: 0,
        unsupportedVersion: 0,
        nextCursor: page.at(-1)?.cursor ?? null,
      };
      for (const owner of page) {
        if (!owner.supported) {
          total.unsupportedVersion++;
          continue;
        }
        if (owner.user_id === null || owner.org_id === null) {
          total.unresolvedOwner++;
          continue;
        }
        const report = await backfill(
          {
            userId: owner.user_id,
            orgId: owner.org_id,
            threadId: owner.thread_id ?? undefined,
            migrate: values.migrate,
          },
          db,
          s3,
          requiredEnv("R2_USER_STORAGES_BUCKET_NAME"),
        );
        total.heads += report.heads;
        total.changedRows += report.changedRows;
        total.published += report.published;
        total.conflicts += report.conflicts;
      }
      console.log(JSON.stringify(total));
      if (
        total.conflicts ||
        total.unresolvedOwner ||
        total.unsupportedVersion ||
        total.heads !== total.scanned
      )
        process.exitCode = 2;
    } finally {
      await db.end();
      s3.destroy();
    }
  }
}
try {
  await main();
} catch (error) {
  // Provider/SQL errors can contain URLs or row details; keep CLI failures aggregate-only.
  const failure = z
    .object({ code: z.string().regex(/^[0-9A-Z]{5}$/u) })
    .safeParse(error);
  console.error(
    JSON.stringify({
      error: "snapshot_identity_operation_failed",
      sqlState: failure.success ? failure.data.code : null,
    }),
  );
  process.exitCode = 1;
}
