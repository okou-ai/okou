import { parseArgs } from "node:util";
import { open, readFile } from "node:fs/promises";
import {
  array,
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import postgres from "postgres";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  prepareContentBundle,
  contentBundleKey,
  contentBundleDigest,
  readContentBundle,
  type ContentBundleFile,
} from "@okouai/core/content-bundle";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import { verifyWorkflowAttachmentBundle } from "@okouai/core/workflow-attachment-bundle";
import { workflowAttachmentsSchema } from "@okouai/api-contracts/contracts/workflow-attachments";
import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";

class BackfillError extends Error {
  constructor(
    readonly classification: string,
    readonly id?: string,
  ) {
    super(classification);
  }
}

const sourceSchema = object({
  id: uuid(),
  orgId: string(),
  xmin: string(),
  kind: zEnum(["agent", "workflow"]),
  name: string(),
  description: string().nullable(),
  instruction: string().nullable(),
  attachments: workflowAttachmentsSchema.nullable(),
  bundle: contentBundleSchema.nullable(),
});
const receiptSchema = object({
  id: uuid(),
  kind: zEnum(["agent", "workflow"]),
  xmin: string(),
  bundle: contentBundleSchema,
  fileCount: number().int().min(1).max(501),
  contentBytes: number()
    .int()
    .nonnegative()
    .max(32 * 1024 * 1024),
});
const scopeSchema = object({
  database: string(),
  bucket: string(),
  endpoint: string(),
});
const planSchema = object({
  format: literal(1),
  scope: scopeSchema,
  rows: array(receiptSchema).max(100),
});

type Source = zInfer<typeof sourceSchema>;
type Receipt = zInfer<typeof receiptSchema>;
type Plan = zInfer<typeof planSchema>;
type Result = { id: string; status: string };

function parseOptions() {
  const { values } = parseArgs({
    options: {
      migrate: { type: "boolean", default: false },
      "writers-drained": { type: "boolean", default: false },
      kind: { type: "string", default: "agent" },
      after: { type: "string" },
      limit: { type: "string", default: "50" },
      output: { type: "string" },
      "plan-file": { type: "string" },
      "expect-plan-sha256": { type: "string" },
    },
  });
  const kind = zEnum(["agent", "workflow"]).parse(values.kind);
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new BackfillError("InvalidBatchLimit");
  const after = values.after === undefined ? null : uuid().parse(values.after);
  if (!values.output) throw new BackfillError("OutputReceiptRequired");
  if (
    values.migrate &&
    (!values["writers-drained"] ||
      !values["plan-file"] ||
      !values["expect-plan-sha256"])
  )
    throw new BackfillError("ApplyRequiresReviewedPlanAndWriterDrain");
  return {
    kind,
    limit,
    after,
    output: values.output,
    migrate: values.migrate,
    planFile: values["plan-file"],
    planSha256: values["expect-plan-sha256"],
  };
}
type Options = ReturnType<typeof parseOptions>;

async function readReviewedPlan(options: Options): Promise<Plan | null> {
  if (!options.planFile) return null;
  const bytes = await readFile(options.planFile);
  if (contentBundleDigest(bytes) !== options.planSha256)
    throw new BackfillError("ReviewedPlanHashMismatch");
  const reviewed = planSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    reviewed.rows.length > options.limit ||
    options.after !== null ||
    reviewed.rows.some((row) => {
      return row.kind !== options.kind;
    })
  )
    throw new BackfillError("ReviewedPlanKindOrPaginationMismatch");
  return reviewed;
}

function readEndpoint(): URL {
  if (!process.env.R2_ENDPOINT && !process.env.R2_ACCOUNT_ID)
    throw new BackfillError("MissingR2Endpoint");
  const endpoint = new URL(
    process.env.R2_ENDPOINT ??
      `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  );
  const nativeR2 =
    endpoint.protocol === "https:" &&
    endpoint.hostname.endsWith(".r2.cloudflarestorage.com");
  const localPeer =
    endpoint.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(endpoint.hostname);
  if (
    (!nativeR2 && !localPeer) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  )
    throw new BackfillError("InvalidR2Endpoint");
  return endpoint;
}

async function readConfiguration(reviewed: Plan | null) {
  const connection = process.env.DATABASE_URL_FILE
    ? (await readFile(process.env.DATABASE_URL_FILE, "utf8")).trim()
    : process.env.DATABASE_URL;
  const bucket = process.env.R2_USER_STORAGES_BUCKET_NAME;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!connection || !bucket || !accessKeyId || !secretAccessKey)
    throw new BackfillError("MissingOperatorConfiguration");
  const endpoint = readEndpoint();
  const address = new URL(connection);
  if (address.searchParams.has("host") || address.searchParams.has("port"))
    throw new BackfillError("NonCanonicalDatabaseAddress");
  const scope = {
    database: `${address.hostname}:${address.port || "5432"}${address.pathname}`,
    bucket,
    endpoint: endpoint.origin,
  };
  if (reviewed && JSON.stringify(reviewed.scope) !== JSON.stringify(scope))
    throw new BackfillError("ReviewedPlanScopeMismatch");
  return {
    connection,
    bucket,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    scope,
  };
}

async function readAttachments(
  row: Source,
  client: S3Client,
  bucket: string,
  signal: AbortSignal,
) {
  const descriptor = row.attachments;
  if (descriptor === null)
    throw new BackfillError("UnconvertedWorkflowAttachments", row.id);
  if (descriptor.kind === "empty") return [];
  if (
    !descriptor.objectKey.startsWith(
      `workflow-attachments/${row.orgId}/${row.id}/`,
    )
  )
    throw new BackfillError("ForeignAttachmentOwner", row.id);
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: descriptor.objectKey }),
    { abortSignal: signal },
  );
  if (!response.Body) throw new BackfillError("MissingAttachmentBody", row.id);
  if (
    response.ContentLength !== undefined &&
    response.ContentLength > 32 * 1024 * 1024
  )
    throw new BackfillError("AttachmentArchiveTooLarge", row.id);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.Body.transformToWebStream()) {
    bytes += chunk.length;
    if (bytes > 32 * 1024 * 1024)
      throw new BackfillError("AttachmentArchiveTooLarge", row.id);
    chunks.push(chunk);
  }
  return verifyWorkflowAttachmentBundle(Buffer.concat(chunks), descriptor);
}

async function prepareSource(
  row: Source,
  client: S3Client,
  bucket: string,
  signal: AbortSignal,
) {
  const files: ContentBundleFile[] = [];
  if (row.kind === "agent") {
    if (row.instruction === null) {
      throw new BackfillError("MissingAgentInstructions", row.id);
    }
    files.push({
      path: "instructions.md",
      content: Buffer.from(row.instruction, "utf8"),
    });
  } else {
    files.push({
      path: "SKILL.md",
      content: Buffer.from(synthesizeWorkflowSkillMd(row), "utf8"),
    });
    files.push(...(await readAttachments(row, client, bucket, signal)));
  }
  const prepared = await prepareContentBundle(files);
  readContentBundle(prepared.archive, prepared.descriptor);
  const receipt: Receipt = {
    id: row.id,
    kind: row.kind,
    xmin: row.xmin,
    bundle: prepared.descriptor,
    fileCount: files.length,
    contentBytes: files.reduce((bytes, file) => {
      return bytes + file.content.length;
    }, 0),
  };
  return { ...prepared, receipt };
}

async function uploadBundle(
  client: S3Client,
  bucket: string,
  prepared: Awaited<ReturnType<typeof prepareSource>>,
  signal: AbortSignal,
) {
  // Shared hash objects are retained, including an uncertain/losing publication.
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: contentBundleKey(prepared.descriptor.sha256),
      Body: prepared.archive,
      ContentType: "application/gzip",
    }),
    { abortSignal: signal },
  );
}

function pageSummary(
  options: Options,
  reviewed: Plan | null,
  rows: readonly Source[],
  results: readonly Result[],
) {
  return {
    mode: options.migrate ? "apply" : "dry-run",
    results,
    nextAfter: rows.at(-1)?.id ?? null,
    reviewed: reviewed?.rows.length ?? 0,
  };
}

async function main() {
  const options = parseOptions();
  const reviewed = await readReviewedPlan(options);
  const configuration = await readConfiguration(reviewed);
  // Reserve the receipt before any remote or database mutation.
  const output = await open(options.output, "wx", 0o600);
  const db = postgres(configuration.connection, { max: 1, prepare: false });
  const client = new S3Client({
    region: "auto",
    endpoint: configuration.endpoint.origin,
    forcePathStyle: true,
    credentials: configuration.credentials,
  });
  const signal = AbortSignal.timeout(15 * 60_000);
  const receipts: Receipt[] = [];
  const results: Result[] = [];
  try {
    const ids =
      reviewed?.rows.map((row) => {
        return row.id;
      }) ?? null;
    const { after, limit } = options;
    const rows = array(sourceSchema).parse(
      options.kind === "agent"
        ? await db`SELECT id, org_id AS "orgId", xmin::text, 'agent' AS kind, name, NULL::text AS description, instructions AS instruction,
          NULL::jsonb AS attachments, instructions_bundle AS bundle FROM agents
          WHERE (${after}::uuid IS NULL OR id > ${after}::uuid) AND (${ids}::uuid[] IS NULL OR id = ANY(${ids}::uuid[])) ORDER BY id LIMIT ${limit}`
        : await db`SELECT id, org_id AS "orgId", xmin::text, 'workflow' AS kind, name, description, instruction, attachments, content_bundle AS bundle
          FROM workflows WHERE official_definition_name IS NULL AND (${after}::uuid IS NULL OR id > ${after}::uuid)
          AND (${ids}::uuid[] IS NULL OR id = ANY(${ids}::uuid[])) ORDER BY id LIMIT ${limit}`,
    );
    for (const expected of reviewed?.rows ?? []) {
      if (
        !rows.some((row) => {
          return row.id === expected.id;
        })
      )
        results.push({ id: expected.id, status: "source-missing" });
    }
    for (const row of rows) {
      const expected = reviewed?.rows.find((item) => {
        return item.id === row.id && item.kind === row.kind;
      });
      if (options.migrate && (!expected || expected.xmin !== row.xmin)) {
        results.push({ id: row.id, status: "source-changed" });
        continue;
      }
      const prepared = await prepareSource(
        row,
        client,
        configuration.bucket,
        signal,
      );
      if (
        expected &&
        JSON.stringify(expected.bundle) !== JSON.stringify(prepared.descriptor)
      )
        throw new BackfillError("SourceContentChanged", row.id);
      receipts.push(prepared.receipt);
      let status = "planned";
      if (options.migrate) {
        await uploadBundle(client, configuration.bucket, prepared, signal);
        const bundle = db.json(prepared.descriptor);
        const updated =
          row.kind === "agent"
            ? await db`UPDATE agents SET instructions_bundle = ${bundle} WHERE id = ${row.id} AND org_id = ${row.orgId} AND xmin::text = ${row.xmin} RETURNING id`
            : await db`UPDATE workflows SET content_bundle = ${bundle} WHERE id = ${row.id} AND org_id = ${row.orgId} AND official_definition_name IS NULL AND xmin::text = ${row.xmin} RETURNING id`;
        status = updated.length === 1 ? "published" : "source-changed";
      }
      results.push({ id: row.id, status });
    }
    await output.writeFile(
      JSON.stringify(
        { format: 1, scope: configuration.scope, rows: receipts },
        null,
        2,
      ) + "\n",
    );
    console.log(JSON.stringify(pageSummary(options, reviewed, rows, results)));
  } finally {
    client.destroy();
    await Promise.all([output.close(), db.end()]);
  }
}
await main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      status: "failed",
      classification:
        error instanceof BackfillError
          ? error.classification
          : error instanceof Error
            ? error.name
            : "UnknownError",
      id: error instanceof BackfillError ? error.id : undefined,
    }),
  );
  process.exitCode = 1;
});
