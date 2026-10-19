import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { Readable } from "node:stream";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Client } from "pg";
import { z } from "zod";
import {
  MAX_ARCHIVE_BYTES,
  MAX_MANIFEST_BYTES,
  hash,
  readContent,
} from "./content";

const { values } = parseArgs({
  options: {
    migrate: { type: "boolean", default: false },
    "ack-writer-drain": { type: "boolean", default: false },
    "allow-single-file": { type: "boolean", default: false },
    "org-id": { type: "string" },
    after: { type: "string" },
    limit: { type: "string", default: "100" },
    "max-ms": { type: "string", default: "60000" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "backfill.ts [--org-id ORG] [--after UUID] [--limit 100] [--max-ms 60000] [--allow-single-file] [--migrate --ack-writer-drain]",
  );
  process.exit(0);
}
function required(name: string): string {
  const value = process.env[name];
  assert.ok(value, `${name} is required`);
  return value;
}
function budget(input: string, maximum: number): number {
  const value = Number(input);
  assert.ok(
    Number.isSafeInteger(value) && value > 0 && value <= maximum,
    "invalid_budget",
  );
  return value;
}
const limit = budget(values.limit, 10_000);
const maxMs = budget(values["max-ms"], 300_000);
const after = values.after ? z.uuid().parse(values.after) : null;
assert.ok(
  !values.migrate || values["ack-writer-drain"],
  "--migrate requires verified --ack-writer-drain",
);
const sourceSchema = z.object({
  id: z.uuid(),
  org_id: z.string(),
  name: z.string(),
  row_version: z.string(),
  target_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  storage_id: z.uuid().nullable(),
  head_version_id: z.string().nullable(),
  s3_key: z.string().nullable(),
});
const client = new Client({
  connectionString: required("DATABASE_URL"),
  statement_timeout: 10_000,
  connectionTimeoutMillis: 10_000,
});
const s3 = new S3Client({
  endpoint:
    process.env.S3_ENDPOINT ??
    `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  region: process.env.S3_REGION ?? "auto",
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  },
  requestChecksumCalculation: "WHEN_REQUIRED",
  maxAttempts: 1,
});
const bucket = required("R2_USER_STORAGES_BUCKET_NAME");
const signal = AbortSignal.timeout(maxMs);
async function readObject(key: string, maxBytes: number): Promise<Buffer> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { abortSignal: signal },
  );
  const stream = response.Body;
  assert.ok(stream instanceof Readable, "missing_node_object_body");
  try {
    assert.ok(
      response.ContentLength === undefined ||
        response.ContentLength <= maxBytes,
      "object_too_large",
    );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      assert.ok(size <= maxBytes, "object_too_large");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally {
    stream.destroy();
  }
}
let exceptions = 0;
let changed = 0;
let matched = 0;
let skipped = 0;
const safeSourceReasons = [
  "missing_source",
  "object_too_large",
  "missing_node_object_body",
  "single_file_requires_review",
  "divergent_framework_files",
  "missing_instruction_files",
  "missing_archive_file",
  "content_integrity_failed",
  "invalid_archive_entry",
  "postgres_unrepresentable_text",
  "unsafe_archive_path",
] as const;
await client.connect();
try {
  const selection = await client.query(
    `SELECT a.id, a.org_id, a.name, a.xmin::text AS row_version,
      encode(sha256(convert_to(a.instructions, 'UTF8')), 'hex') AS target_hash,
      s.id AS storage_id, s.head_version_id, v.s3_key
    FROM agents a
    LEFT JOIN storages s ON s.org_id = a.org_id AND s.user_id = '__org__'
      AND s.name = 'agent-instructions@' || a.name
    LEFT JOIN storage_versions v ON v.id = s.head_version_id AND v.storage_id = s.id
    WHERE ($1::text IS NULL OR a.org_id = $1) AND ($2::uuid IS NULL OR a.id > $2)
    ORDER BY a.id LIMIT $3`,
    [values["org-id"] ?? null, after, limit + 1],
  );
  const rows = z.array(sourceSchema).parse(selection.rows);
  const page = rows.slice(0, limit);
  for (const row of page) {
    signal.throwIfAborted();
    const identity = {
      agentId: row.id,
      orgId: row.org_id,
      storageId: row.storage_id,
      versionId: row.head_version_id,
    };
    let writing = false;
    try {
      assert.ok(
        row.storage_id && row.head_version_id && row.s3_key,
        "missing_source",
      );
      const manifest = await readObject(
        `${row.s3_key}/manifest.json`,
        MAX_MANIFEST_BYTES,
      );
      const archive = await readObject(
        `${row.s3_key}/archive.tar.gz`,
        MAX_ARCHIVE_BYTES,
      );
      const { content, singleFile } = await readContent(
        manifest,
        archive,
        values["allow-single-file"],
      );
      const sourceHash = hash(content);
      const targetHash = row.target_hash;
      let status: string;
      if (targetHash === sourceHash) {
        status = "matching";
        matched++;
      } else if (!values.migrate) {
        status = "would_update";
      } else {
        writing = true;
        // Every bridge publication updates this Agent row in the same commit as HEAD.
        // xmin is an ephemeral CAS token: after a concurrent row wait, PostgreSQL
        // rechecks it against the new tuple. A stale statement-snapshot HEAD alone
        // would not fence an overlapping publication, including same-content edits.
        const result = await client.query(
          `UPDATE agents a SET instructions = $1
          WHERE a.id = $2 AND a.org_id = $3 AND a.name = $4 AND a.xmin = $5::xid
          AND EXISTS (SELECT 1 FROM storages s JOIN storage_versions v
            ON v.id = s.head_version_id AND v.storage_id = s.id
            WHERE s.id = $6 AND s.org_id = a.org_id AND s.user_id = '__org__'
              AND s.name = 'agent-instructions@' || a.name AND s.head_version_id = $7 AND v.s3_key = $8)`,
          [
            content,
            row.id,
            row.org_id,
            row.name,
            row.row_version,
            row.storage_id,
            row.head_version_id,
            row.s3_key,
          ],
        );
        if (result.rowCount === 1) {
          status = "updated";
          changed++;
        } else {
          status = "concurrent_change";
          skipped++;
        }
      }
      console.log(
        JSON.stringify({
          ...identity,
          status,
          sourceHash,
          targetHash,
          singleFile,
        }),
      );
    } catch (error) {
      if (writing)
        throw new Error("instruction_backfill_database_write_failed");
      exceptions++;
      // Provider/parser errors may contain source bytes or credentials. Report
      // only identifiers; diagnose an exceptional source in an authorized session.
      const reason =
        error instanceof Error
          ? safeSourceReasons.find((candidate) => {
              return candidate === error.message;
            })
          : undefined;
      console.log(
        JSON.stringify({
          ...identity,
          status: "source_exception",
          reason: reason ?? "unreadable_or_invalid_source",
        }),
      );
    }
  }
  const hasMore = rows.length > limit;
  console.log(
    JSON.stringify({
      summary: true,
      mode: values.migrate ? "migrate" : "dry-run",
      examined: page.length,
      changed,
      matched,
      skipped,
      exceptions,
      hasMore,
      nextAfter: page.at(-1)?.id ?? after,
    }),
  );
  if (
    exceptions ||
    skipped ||
    hasMore ||
    (!values.migrate && matched !== page.length)
  )
    process.exitCode = 2;
} finally {
  await client.end();
  s3.destroy();
}
