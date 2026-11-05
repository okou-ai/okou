import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import {
  array,
  boolean,
  literal,
  number,
  object,
  string,
  uuid,
  type infer as zInfer,
} from "zod";
import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";

export class BackfillError extends Error {
  constructor(readonly classification: string) {
    super(classification);
  }
}
export const sha256 = (bytes: Uint8Array | string) => {
  return createHash("sha256").update(bytes).digest("hex");
};
const digest = string().regex(/^[a-f0-9]{64}$/u);
const xid = string().regex(/^\d+$/u);
export const sourceSchema = object({
  connectorId: uuid(),
  orgId: string().min(1),
  ownerXmin: xid,
  sourceVersionId: digest,
  storageId: uuid(),
  storageXmin: xid,
  versionXmin: xid,
  s3Key: string().min(1),
  archiveBytes: number()
    .int()
    .positive()
    .max(32 * 1024 * 1024),
  contentBytes: number()
    .int()
    .nonnegative()
    .max(32 * 1024 * 1024),
  fileCount: literal(1),
  bundle: contentBundleSchema.nullable(),
  bundleSource: digest.nullable(),
});
export type Source = zInfer<typeof sourceSchema>;
const scopeSchema = object({
  database: string(),
  bucket: string(),
  endpoint: string(),
});
const planRowSchema = object({
  source: sourceSchema,
  target: contentBundleSchema,
});
export type PlanRow = zInfer<typeof planRowSchema>;
export const planSchema = object({
  format: literal("connector-skill-backfill-v1"),
  mode: literal("read-only"),
  capturedAt: string(),
  scope: scopeSchema,
  complete: boolean(),
  rows: array(planRowSchema).max(100),
  failures: array(object({ connectorId: uuid(), classification: string() })),
});

export async function input() {
  const { values } = parseArgs({
    options: {
      "connector-id": { type: "string", multiple: true },
      output: { type: "string" },
      migrate: { type: "boolean", default: false },
      plan: { type: "string" },
      "approve-plan-sha256": { type: "string" },
      "writers-drained": { type: "boolean", default: false },
    },
  });
  if (!values.output) throw new BackfillError("OutputRequired");
  if (values.migrate) {
    if (
      !values.plan ||
      !values["approve-plan-sha256"] ||
      !values["writers-drained"] ||
      values["connector-id"]
    )
      throw new BackfillError("ApplyRequiresReviewedPlanAndWriterDrain");
    const bytes = await readFile(values.plan);
    if (sha256(bytes) !== values["approve-plan-sha256"])
      throw new BackfillError("ReviewedPlanHashMismatch");
    const reviewed = planSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (!reviewed.complete || reviewed.failures.length)
      throw new BackfillError("IncompletePlanRejected");
    const ids = reviewed.rows.map((row) => {
      return row.source.connectorId;
    });
    if (new Set(ids).size !== ids.length)
      throw new BackfillError("DuplicateConnectorIdentity");
    return { output: values.output, reviewed, ids, planSha256: sha256(bytes) };
  }
  if (values.plan || values["approve-plan-sha256"] || values["writers-drained"])
    throw new BackfillError("UseConnectorIdsOrReviewedPlan");
  const ids = array(uuid())
    .min(1)
    .max(100)
    .parse(values["connector-id"])
    .map((id) => {
      return id.toLowerCase();
    });
  if (new Set(ids).size !== ids.length)
    throw new BackfillError("DuplicateConnectorIdentity");
  return { output: values.output, reviewed: null, ids, planSha256: null };
}

function readEndpoint() {
  const endpointValue =
    process.env.R2_ENDPOINT ??
    (process.env.R2_ACCOUNT_ID
      ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : undefined);
  if (!endpointValue) throw new BackfillError("MissingR2Endpoint");
  const endpoint = new URL(endpointValue);
  const native =
    endpoint.protocol === "https:" &&
    endpoint.hostname.endsWith(".r2.cloudflarestorage.com");
  const local =
    endpoint.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(endpoint.hostname);
  if (
    (!native && !local) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  )
    throw new BackfillError("InvalidR2Endpoint");
  return endpoint;
}

export async function configuration(expected?: zInfer<typeof scopeSchema>) {
  const connection = process.env.DATABASE_URL_FILE
    ? (await readFile(process.env.DATABASE_URL_FILE, "utf8")).trim()
    : process.env.DATABASE_URL;
  const bucket = process.env.R2_USER_STORAGES_BUCKET_NAME;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!connection || !bucket || !accessKeyId || !secretAccessKey)
    throw new BackfillError("MissingOperatorConfiguration");
  const address = new URL(connection);
  if (
    !["postgres:", "postgresql:"].includes(address.protocol) ||
    address.searchParams.has("host") ||
    address.searchParams.has("port")
  )
    throw new BackfillError("NonCanonicalDatabaseAddress");
  const endpoint = readEndpoint();
  const scope = {
    database: `${address.hostname}:${address.port || "5432"}${address.pathname}`,
    bucket,
    endpoint: endpoint.origin,
  };
  if (expected && JSON.stringify(scope) !== JSON.stringify(expected))
    throw new BackfillError("ReviewedScopeMismatch");
  return {
    connection,
    bucket,
    endpoint: endpoint.origin,
    credentials: { accessKeyId, secretAccessKey },
    scope,
  };
}

export function classification(error: unknown): string {
  return error instanceof BackfillError
    ? error.classification
    : "ConnectorSkillBackfillFailed";
}
