import { workflowNameSchema } from "@okouai/api-contracts/contracts/workflows";
import { parseArgs } from "node:util";
import { open, readFile } from "node:fs/promises";
import {
  array,
  literal,
  number,
  coerce,
  object,
  string,
  tuple,
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
} from "@okouai/core/content-bundle";
import {
  officialWorkflowDefinitionRevisionPayloadSchema,
  officialWorkflowCatalogReleasePayloadSchema,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  officialWorkflowExecutionFiles,
  verifyOfficialWorkflowArtifact,
} from "@okouai/core/official-workflow-artifact";
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
  definitionName: string(),
  revision: string(),
  xmin: string(),
  payload: officialWorkflowDefinitionRevisionPayloadSchema,
  storageId: string().nullable(),
  storageVersion: string().nullable(),
  storageName: string().nullable(),
  s3Key: string().nullable(),
  archiveSize: coerce.number().int().nullable(),
  bundle: contentBundleSchema.nullable(),
});
const receiptSchema = object({
  id: string(),
  xmin: string(),
  sourceHash: string().regex(/^[a-f0-9]{64}$/u),
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
      after: { type: "string" },
      limit: { type: "string", default: "50" },
      output: { type: "string" },
      "plan-file": { type: "string" },
      "expect-plan-sha256": { type: "string" },
    },
  });
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new BackfillError("InvalidBatchLimit");
  const after =
    values.after === undefined
      ? null
      : tuple([workflowNameSchema, string().regex(/^[0-9a-f]{64}$/u)]).parse(
          values.after.split("/"),
        );
  if (!values.output) throw new BackfillError("OutputReceiptRequired");
  if (
    values.migrate &&
    (!values["writers-drained"] ||
      !values["plan-file"] ||
      !values["expect-plan-sha256"])
  )
    throw new BackfillError("ApplyRequiresReviewedPlanAndWriterDrain");
  return {
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
  if (reviewed.rows.length > options.limit || options.after !== null)
    throw new BackfillError("ReviewedPlanPaginationMismatch");
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isJsonObject(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => {
        return left < right ? -1 : left > right ? 1 : 0;
      })
      .map(([key, item]) => {
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new BackfillError("UnsupportedSourceValue");
  return result;
}

async function readObject(
  client: S3Client,
  bucket: string,
  key: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { abortSignal: signal },
  );
  if (
    !response.Body ||
    (response.ContentLength !== undefined &&
      response.ContentLength > 32 * 1024 * 1024)
  )
    throw new BackfillError("InvalidArchiveLength");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.Body.transformToWebStream()) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new BackfillError("ArchiveTooLarge");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sourceId(row: Source): string {
  return `${row.definitionName}/${row.revision}`;
}

async function prepareSource(
  row: Source,
  client: S3Client,
  bucket: string,
  signal: AbortSignal,
) {
  const id = sourceId(row);
  if (
    row.payload.name !== row.definitionName ||
    row.payload.revision !== row.revision
  )
    throw new BackfillError("SourceIdentityMismatch", id);
  if (
    row.storageId !== null ||
    row.storageVersion !== null ||
    row.storageName !== null
  ) {
    if (
      !row.storageId ||
      !row.storageVersion ||
      !row.s3Key ||
      row.archiveSize === null ||
      row.storageName !== `official-workflow@${row.definitionName}`
    )
      throw new BackfillError("LegacyArtifactMissing", id);
    const archive = await readObject(
      client,
      bucket,
      `${row.s3Key}/archive.tar.gz`,
      signal,
    );
    if (archive.length !== row.archiveSize)
      throw new BackfillError("LegacyArchiveLengthMismatch", id);
    verifyOfficialWorkflowArtifact(archive, row.payload, {
      storageId: row.storageId,
      storageVersion: row.storageVersion,
      definitionManifest: `${canonicalJson(row.payload)}\n`,
    });
  } else if (!row.bundle)
    throw new BackfillError("MissingDeliveryReference", id);
  const files = officialWorkflowExecutionFiles(row.payload).map((file) => {
    return {
      path: file.path,
      content: Buffer.from(file.content, "utf8"),
    };
  });
  const prepared = await prepareContentBundle(files);
  readContentBundle(prepared.archive, prepared.descriptor);
  if (
    row.bundle &&
    canonicalJson(row.bundle) !== canonicalJson(prepared.descriptor)
  )
    throw new BackfillError("ConflictingBundle", id);
  if (row.bundle)
    readContentBundle(
      await readObject(
        client,
        bucket,
        contentBundleKey(row.bundle.sha256),
        signal,
      ),
      row.bundle,
    );
  const receipt: Receipt = {
    id,
    xmin: row.xmin,
    sourceHash: contentBundleDigest(
      Buffer.from(
        canonicalJson({
          payload: row.payload,
          storageId: row.storageId,
          storageName: row.storageName,
          storageVersion: row.storageVersion,
          s3Key: row.s3Key,
          archiveSize: row.archiveSize,
        }),
      ),
    ),
    bundle: prepared.descriptor,
    fileCount: files.length,
    contentBytes: files.reduce((total, file) => {
      return total + Buffer.byteLength(file.content);
    }, 0),
  };
  return { ...prepared, receipt };
}

async function main() {
  const options = parseOptions();
  const reviewed = await readReviewedPlan(options);
  const configuration = await readConfiguration(reviewed);
  const output = await open(options.output, "wx", 0o600);
  const db = postgres(configuration.connection, {
    max: 1,
    prepare: false,
    connection: { statement_timeout: 30000, lock_timeout: 1000 },
  });
  const client = new S3Client({
    region: "auto",
    endpoint: configuration.endpoint.origin,
    forcePathStyle: true,
    credentials: configuration.credentials,
  });
  const signal = AbortSignal.timeout(15 * 60_000);
  const receipts: Receipt[] = [];
  const results: Result[] = [];
  let inFlight: string | undefined;
  const saveProgress = async () => {
    const bytes = Buffer.from(
      JSON.stringify(
        { format: 1, scope: configuration.scope, rows: receipts, results },
        null,
        2,
      ) + "\n",
    );
    let written = 0;
    while (written < bytes.length) {
      const result = await output.write(
        bytes,
        written,
        bytes.length - written,
        written,
      );
      if (result.bytesWritten === 0)
        throw new BackfillError("ReceiptWriteIncomplete");
      written += result.bytesWritten;
    }
    await output.truncate(bytes.length);
    await output.sync();
  };
  try {
    // Every accepted-catalog reference must still resolve to an immutable row.
    const catalogs =
      await db`SELECT r.payload FROM official_workflow_catalog_state s JOIN official_workflow_catalog_releases r ON r.id = s.accepted_release_id WHERE s.authority = 'official'`;
    for (const row of catalogs) {
      if (
        row.payload !== null &&
        typeof row.payload === "object" &&
        "schemaVersion" in row.payload &&
        row.payload.schemaVersion === 1
      )
        continue;
      const parsed = officialWorkflowCatalogReleasePayloadSchema.parse(
        row.payload,
      );
      for (const definition of parsed.definitions) {
        const matches =
          await db`SELECT 1 FROM official_workflow_definition_revisions WHERE definition_name = ${definition.name} AND revision = ${definition.revision}`;
        if (matches.length !== 1)
          throw new BackfillError(
            "AcceptedRevisionMissing",
            `${definition.name}/${definition.revision}`,
          );
      }
    }
    const ids =
      reviewed?.rows.map((row) => {
        return row.id;
      }) ?? null;
    const [afterName, afterRevision] = options.after ?? ([null, null] as const);
    const rows = array(sourceSchema).parse(
      await db`SELECT d.definition_name AS "definitionName", d.revision, d.xmin::text, d.payload,
      d.storage_name AS "storageName", d.storage_id AS "storageId", d.storage_version AS "storageVersion", v.s3_key AS "s3Key", v.archive_size AS "archiveSize", d.content_bundle AS bundle
      FROM official_workflow_definition_revisions d
      LEFT JOIN storages s ON s.id = d.storage_id AND s.name = d.storage_name AND s.org_id = '__system__' AND s.user_id = '__org__'
      LEFT JOIN storage_versions v ON v.id = d.storage_version AND v.storage_id = s.id
      WHERE d.payload->'schemaVersion' IS DISTINCT FROM '1'::jsonb
      AND (${afterName}::text IS NULL OR (d.definition_name, d.revision) > (${afterName}::text, ${afterRevision}::text))
      AND (${ids}::text[] IS NULL OR d.definition_name || '/' || d.revision = ANY(${ids}::text[]))
      ORDER BY d.definition_name, d.revision LIMIT ${options.limit}`,
    );
    for (const expected of reviewed?.rows ?? [])
      if (
        !rows.some((row) => {
          return sourceId(row) === expected.id;
        })
      )
        results.push({ id: expected.id, status: "source-missing" });
    await saveProgress();
    const processRow = async (row: Source) => {
      const id = sourceId(row);
      inFlight = id;
      const expected = reviewed?.rows.find((item) => {
        return item.id === id;
      });
      const prepared = await prepareSource(
        row,
        client,
        configuration.bucket,
        signal,
      );
      if (
        expected &&
        (expected.sourceHash !== prepared.receipt.sourceHash ||
          canonicalJson(expected.bundle) !== canonicalJson(prepared.descriptor))
      )
        throw new BackfillError("ReviewedSourceChanged", id);
      receipts.push(prepared.receipt);
      let status = row.bundle ? "verified" : "planned";
      if (options.migrate && !row.bundle) {
        if (!expected || row.xmin !== expected.xmin) {
          results.push({ id, status: "source-changed" });
          await saveProgress();
          inFlight = undefined;
          return;
        }
        await client.send(
          new PutObjectCommand({
            Bucket: configuration.bucket,
            Key: contentBundleKey(prepared.descriptor.sha256),
            Body: prepared.archive,
            ContentType: "application/gzip",
          }),
          { abortSignal: signal },
        );
        readContentBundle(
          await readObject(
            client,
            configuration.bucket,
            contentBundleKey(prepared.descriptor.sha256),
            signal,
          ),
          prepared.descriptor,
        );
        const bundle = db.json(prepared.descriptor);
        const updated =
          await db`UPDATE official_workflow_definition_revisions SET content_bundle = ${bundle}
          WHERE definition_name = ${row.definitionName} AND revision = ${row.revision} AND xmin::text = ${row.xmin} AND content_bundle IS NULL RETURNING revision`;
        status = updated.length === 1 ? "published" : "source-changed";
      }
      results.push({ id, status });
      await saveProgress();
      inFlight = undefined;
    };
    for (const row of rows) await processRow(row);
    const last = rows.at(-1);
    console.log(
      JSON.stringify({
        mode: options.migrate ? "apply" : "dry-run",
        results,
        nextAfter: last ? sourceId(last) : null,
      }),
    );
  } catch (error) {
    results.push({ id: inFlight ?? "catalog", status: "failed-or-uncertain" });
    await saveProgress();
    throw error;
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
