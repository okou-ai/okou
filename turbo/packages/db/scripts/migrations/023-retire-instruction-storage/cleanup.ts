import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { z } from "zod";

const { values } = parseArgs({
  options: {
    migrate: { type: "boolean", default: false },
    "ack-consumer-retirement": { type: "boolean", default: false },
    manifest: { type: "string" },
    after: { type: "string" },
    limit: { type: "string", default: "100" },
    "max-ms": { type: "string", default: "60000" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "cleanup.ts [--after UUID] [--limit 100] [--max-ms 60000] [--manifest FILE --migrate --ack-consumer-retirement]",
  );
  process.exit(0);
}
const limit = z.coerce.number().int().min(1).max(100).parse(values.limit);
const maxMs = z.coerce
  .number()
  .int()
  .min(1000)
  .max(300000)
  .parse(values["max-ms"]);
const after = z.uuid().optional().parse(values.after);
assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
assert.ok(
  process.env.R2_USER_STORAGES_BUCKET_NAME,
  "R2_USER_STORAGES_BUCKET_NAME is required",
);
const bucket = process.env.R2_USER_STORAGES_BUCKET_NAME;
if (values.migrate) {
  assert.ok(
    values.manifest && values["ack-consumer-retirement"],
    "Writes require a reviewed manifest and --ack-consumer-retirement",
  );
}
const storageSchema = z
  .object({
    id: z.uuid(),
    orgId: z.string().min(1),
    name: z.string().startsWith("agent-instructions@"),
    prefix: z
      .string()
      .min(1)
      .refine((value) => {
        const parts = value.split("/");
        return (
          parts.length >= 2 &&
          parts.every((part) => {
            return part !== "" && part !== "." && part !== "..";
          })
        );
      }, "Storage cleanup requires a non-root captured prefix"),
    head: z.string().nullable(),
    xmin: z.string(),
    versions: z.array(z.string()),
  })
  .strict();
const tokenSchema = z
  .object({
    orgId: z.string(),
    agentId: z.uuid(),
    xmin: z.string(),
  })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal(1),
    bucket: z.string().min(1),
    storages: z.array(storageSchema).max(100),
    tokens: z.array(tokenSchema).max(100),
    nextAfter: z.uuid().nullable(),
  })
  .strict();
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  application_name: "retire-instruction-storage",
  connectionTimeoutMillis: 10000,
  statement_timeout: 10000,
  query_timeout: 12000,
});
const started = Date.now();
let incomplete = false;
try {
  await client.connect();
  // Reject unmigrated content rather than repairing it during deletion.
  const { rows } = await client.query(
    "SELECT count(*)::int AS count FROM agents WHERE instructions IS NULL",
  );
  assert.equal(
    z.object({ count: z.number() }).parse(rows[0]).count,
    0,
    "Unmigrated instructions remain",
  );
  if (!values.migrate) {
    const storages = z.array(storageSchema).parse(
      (
        await client.query(
          `
      SELECT s.id, s.org_id AS "orgId", s.name, s.s3_prefix AS prefix,
        s.head_version_id AS head, s.xmin::text AS xmin,
        ARRAY(SELECT v.id::text FROM storage_versions v WHERE v.storage_id=s.id ORDER BY v.id) AS versions
      FROM storages s WHERE s.user_id='__org__' AND starts_with(s.name, 'agent-instructions@')
        AND ($1::uuid IS NULL OR s.id > $1::uuid) ORDER BY s.id LIMIT $2`,
          [after ?? null, limit],
        )
      ).rows,
    );
    const tokens = z.array(tokenSchema).parse(
      (
        await client.query(
          `
      SELECT org_id AS "orgId", agent_id AS "agentId", xmin::text AS xmin
      FROM storage_publication_tokens WHERE subject='@agent' AND publication_key='agent-instructions'
      ORDER BY org_id, agent_id LIMIT $1`,
          [limit],
        )
      ).rows,
    );
    console.log(
      JSON.stringify(
        manifestSchema.parse({
          format: 1,
          bucket,
          storages,
          tokens,
          nextAfter: storages.length === limit ? storages.at(-1)?.id : null,
        }),
        null,
        2,
      ),
    );
  } else {
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(values.manifest ?? "", "utf8")),
    );
    assert.equal(
      manifest.bucket,
      bucket,
      "Manifest bucket differs from the configured bucket",
    );
    for (const storage of manifest.storages) {
      if (Date.now() - started >= maxMs) {
        incomplete = true;
        break;
      }
      // Prefixes are captured from the owning row, never inferred from names.
      // Deleted rows and the existing durable cleanup job commit together.
      const result = await client.query(
        `
        WITH removed AS (
          DELETE FROM storages s WHERE s.id=$1::uuid AND s.org_id=$2 AND s.user_id='__org__'
            AND s.name=$3 AND s.s3_prefix=$4 AND s.xmin::text=$5
            AND s.head_version_id IS NOT DISTINCT FROM $6::varchar
            AND starts_with(s.name, 'agent-instructions@') AND length(s.name)>19
            AND s.s3_prefix NOT IN ('', '/', '.', '..')
            AND s.s3_prefix NOT LIKE '%//%' AND s.s3_prefix NOT LIKE '%/../%'
            AND position('/' IN s.s3_prefix)>0 AND s.s3_prefix NOT LIKE '%/'
            AND ARRAY(SELECT v.id::text FROM storage_versions v WHERE v.storage_id=s.id ORDER BY v.id)=$7::text[]
            AND NOT EXISTS (SELECT 1 FROM storage_versions v WHERE v.storage_id=s.id
              AND NOT starts_with(v.s3_key, s.s3_prefix || '/'))
            AND NOT EXISTS (SELECT 1 FROM storage_versions v WHERE v.storage_id<>s.id
              AND starts_with(v.s3_key, s.s3_prefix || '/'))
            AND NOT EXISTS (SELECT 1 FROM storages other WHERE other.id<>s.id AND (
              other.s3_prefix=s.s3_prefix OR starts_with(other.s3_prefix, s.s3_prefix || '/')
              OR starts_with(s.s3_prefix, other.s3_prefix || '/')))
            AND NOT EXISTS (SELECT 1 FROM export_jobs e WHERE starts_with(e.s3_key, s.s3_prefix || '/'))
            AND NOT EXISTS (SELECT 1 FROM runner_job_queue q,
              LATERAL jsonb_array_elements(COALESCE(q.execution_context->'storageMounts', '[]'::jsonb)) m
              WHERE m->>'storageId'=s.id::text OR m->>'versionId'=ANY($7::text[]))
            AND NOT EXISTS (SELECT 1 FROM agent_runs r,
              LATERAL jsonb_array_elements(COALESCE(r.storage_mounts, '[]'::jsonb)) m
              WHERE (r.status IN ('pending', 'running') OR EXISTS (
                SELECT 1 FROM active_agent_runs a WHERE a.run_id=r.id))
              AND (m->>'storageId'=s.id::text OR m->>'version'=ANY($7::text[])))
          RETURNING s.id, s.org_id, s.s3_prefix
        )
        INSERT INTO background_jobs (id, kind, handler_version, user_id, org_id, input)
        SELECT gen_random_uuid(), 'storage-object-cleanup', 1, '__org__', org_id,
          jsonb_build_object('bucket', $8::text, 'target', jsonb_build_object('kind', 'prefix', 'value', s3_prefix))
        FROM removed RETURNING id`,
        [
          storage.id,
          storage.orgId,
          storage.name,
          storage.prefix,
          storage.xmin,
          storage.head,
          storage.versions,
          bucket,
        ],
      );
      const deleted = result.rows.length === 1;
      incomplete ||= !deleted;
      console.log(
        JSON.stringify({
          storageId: storage.id,
          prefix: storage.prefix,
          status: deleted ? "cleanup_queued" : "changed_or_referenced",
          jobId: deleted
            ? z.object({ id: z.uuid() }).parse(result.rows[0]).id
            : null,
        }),
      );
    }
    for (const token of manifest.tokens) {
      if (Date.now() - started >= maxMs) {
        incomplete = true;
        break;
      }
      const removed = await client.query(
        `DELETE FROM storage_publication_tokens WHERE org_id=$1 AND agent_id=$2::uuid
        AND subject='@agent' AND publication_key='agent-instructions' AND xmin::text=$3`,
        [token.orgId, token.agentId, token.xmin],
      );
      incomplete ||= removed.rowCount !== 1;
      console.log(
        JSON.stringify({
          agentId: token.agentId,
          orgId: token.orgId,
          status:
            removed.rowCount === 1
              ? "instruction_token_removed"
              : "token_changed_or_missing",
        }),
      );
    }
    console.log(
      JSON.stringify({
        status: incomplete ? "incomplete" : "batch_complete",
        nextAfter: manifest.nextAfter,
        note: "R2 deletion is performed by the existing storage-object-cleanup worker",
      }),
    );
  }
} finally {
  await client.end();
}
if (incomplete) process.exitCode = 2;
