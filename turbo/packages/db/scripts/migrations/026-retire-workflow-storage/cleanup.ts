import { randomUUID } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { Client } from "pg";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  array,
  number,
  object,
  record,
  string,
  uuid,
  unknown as zUnknown,
  enum as zEnum,
} from "zod";
import {
  HANDLER_VERSION,
  JOB_KIND,
  RetirementError,
  checksum,
  cleanupPrefixes,
  hash,
  jobInput,
  observationSchema,
  planSchema,
  validatePlan,
  workflowBaseline,
  workflowChanges,
  type Ready,
  type Plan,
  type TargetJob,
  type Observation,
  type Baseline,
} from "./schema";
import {
  inventoryQuery,
  referenceQuery,
  remainingQuery,
  retireQuery,
} from "./queries";

const checkpointSchema = object({
  pages: number().int().nonnegative().default(0),
}).strict();
const jobsSchema = array(
  object({
    id: uuid(),
    kind: string(),
    handler_version: number().int(),
    user_id: string(),
    org_id: string(),
    input: record(string(), zUnknown()),
    checkpoint: checkpointSchema,
    status: zEnum(["pending", "running", "completed", "failed", "cancelled"]),
    failure_count: number().int().nonnegative(),
  }),
);
type Job = ReturnType<typeof jobsSchema.parse>[number];
const jobSelection = `SELECT id,kind,handler_version,user_id,org_id,input,checkpoint,status,failure_count
  FROM background_jobs WHERE id=ANY($1::uuid[]) ORDER BY id`;
const reasonsSchema = array(object({ reasons: array(string()) }));
const remainingSchema = array(
  object({ storages: number().int(), versions: number().int() }),
);

function options() {
  const { values } = parseArgs({
    options: {
      migrate: { type: "boolean", default: false },
      "process-jobs": { type: "boolean", default: false },
      audit: { type: "boolean", default: false },
      "ack-consumer-retirement": { type: "boolean", default: false },
      "plan-file": { type: "string" },
      "expect-plan-sha256": { type: "string" },
      output: { type: "string" },
      after: { type: "string" },
      "storage-id": { type: "string" },
      limit: { type: "string", default: "100" },
      "max-pages": { type: "string", default: "8" },
      "max-ms": { type: "string", default: "180000" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return null;
  if (
    [values.migrate, values["process-jobs"], values.audit].filter(Boolean)
      .length > 1
  )
    throw new RetirementError("ChooseOneMode");
  const reviewed = values.migrate || values["process-jobs"] || values.audit;
  if (reviewed && (!values["plan-file"] || !values["expect-plan-sha256"]))
    throw new RetirementError("ReviewedPlanAndChecksumRequired");
  if (!reviewed && (values["plan-file"] || values["expect-plan-sha256"]))
    throw new RetirementError("PlanRequiresExplicitMode");
  if (
    (values.migrate || values["process-jobs"]) &&
    !values["ack-consumer-retirement"]
  )
    throw new RetirementError("ConsumerRetirementAcknowledgementRequired");
  if (reviewed && (values.after || values["storage-id"]))
    throw new RetirementError("ReviewedPlanOwnsSelection");
  if (!values.output) throw new RetirementError("PrivateOutputFileRequired");
  return {
    ...values,
    output: values.output,
    reviewed,
    limit: number().int().min(1).max(100).parse(Number(values.limit)),
    maxPages: number().int().min(1).max(100).parse(Number(values["max-pages"])),
    maxMs: number().int().min(1000).max(300000).parse(Number(values["max-ms"])),
    after: values.after === undefined ? null : uuid().parse(values.after),
    storageId:
      values["storage-id"] === undefined
        ? null
        : uuid().parse(values["storage-id"]),
  };
}

async function privateFile(path: string, maxBytes: number): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > maxBytes)
    throw new RetirementError("PrivateRegularFileRequired");
  return await readFile(path, "utf8");
}

function verifyJobs(bucket: string, row: Ready, jobs: Job[]): void {
  for (const job of jobs) {
    const captured = row.jobs.find((candidate) => {
      return candidate.id === job.id;
    });
    if (
      !captured ||
      job.kind !== JOB_KIND ||
      job.handler_version !== HANDLER_VERSION ||
      job.user_id !== "__org__" ||
      job.org_id !== row.source.orgId ||
      !isDeepStrictEqual(job.input, jobInput(bucket, row.source, captured))
    )
      throw new RetirementError("CleanupJobIdentityMismatch");
  }
}

function failed(error: unknown): string {
  return error instanceof RetirementError
    ? error.classification
    : "OperationFailed";
}

function r2Endpoint(configuredEndpoint: string): string {
  const endpointUrl = new URL(configuredEndpoint);
  const localEndpoint =
    endpointUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(endpointUrl.hostname);
  if (
    (!localEndpoint &&
      (endpointUrl.protocol !== "https:" ||
        !endpointUrl.hostname.endsWith(".r2.cloudflarestorage.com"))) ||
    endpointUrl.username ||
    endpointUrl.password ||
    endpointUrl.search ||
    endpointUrl.hash ||
    endpointUrl.pathname !== "/"
  )
    throw new RetirementError("SecureR2AccountEndpointRequired");
  return endpointUrl.origin;
}

function r2Client(endpoint: string): S3Client {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey)
    throw new RetirementError("R2ConfigurationRequired");
  return new S3Client({
    endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
  });
}

async function configuration(args: NonNullable<ReturnType<typeof options>>) {
  const bucket = process.env.R2_USER_STORAGES_BUCKET_NAME;
  const credential = process.env.DATABASE_URL_FILE;
  const configuredEndpoint = process.env.R2_ENDPOINT;
  if (!bucket || !credential || !configuredEndpoint)
    throw new RetirementError("DatabaseFileBucketAndEndpointRequired");
  const endpoint = r2Endpoint(configuredEndpoint);
  const connection = (await privateFile(credential, 64 * 1024)).trim();
  const address = new URL(connection);
  if (
    !["postgres:", "postgresql:"].includes(address.protocol) ||
    !address.hostname ||
    address.pathname.length < 2 ||
    address.searchParams.has("host") ||
    address.searchParams.has("port") ||
    address.searchParams.getAll("options").length > 1
  )
    throw new RetirementError("ExplicitDatabaseEndpointRequired");
  const databaseOptions =
    address.searchParams.get("options") || process.env.PGOPTIONS || null;
  let plan: Plan | undefined;
  if (args.reviewed) {
    const bytes = await privateFile(
      string().parse(args["plan-file"]),
      32 * 1024 * 1024,
    );
    if (checksum(bytes) !== hash.parse(args["expect-plan-sha256"]))
      throw new RetirementError("ReviewedPlanChecksumMismatch");
    plan = planSchema.parse(JSON.parse(bytes));
    validatePlan(plan);
  }
  return { bucket, endpoint, connection, databaseOptions, plan };
}

function verifyScope(
  plan: Plan | undefined,
  scope: Pick<Plan, "bucket" | "endpoint" | "databaseScope">,
): void {
  if (!plan) return;
  if (plan.bucket !== scope.bucket)
    throw new RetirementError("ReviewedBucketMismatch");
  if (
    plan.endpoint !== scope.endpoint ||
    plan.databaseScope !== scope.databaseScope
  )
    throw new RetirementError("ReviewedDatabaseOrR2AccountMismatch");
}

type Remaining = ReturnType<typeof remainingSchema.parse>[number];

async function main(): Promise<void> {
  const parsed = options();
  if (!parsed) {
    console.log(`cleanup.ts --output FILE [--after UUID | --storage-id UUID] [--limit 100]
  --migrate --plan-file FILE --expect-plan-sha256 HASH --ack-consumer-retirement --output RECEIPT.jsonl
  --process-jobs --plan-file FILE --expect-plan-sha256 HASH --ack-consumer-retirement --output RECEIPT.jsonl [--max-pages 8]
  --audit --plan-file FILE --expect-plan-sha256 HASH --output AUDIT.jsonl
Default: database-only, read-only review plan. See the adjacent README before any write.`);
    return;
  }
  const args = parsed;
  const { bucket, endpoint, connection, databaseOptions, plan } =
    await configuration(args);
  const client = new Client({
    connectionString: connection,
    application_name: JOB_KIND,
    connectionTimeoutMillis: 10000,
    statement_timeout: 10000,
    query_timeout: 12000,
  });
  // pg resolves defaults (including PGPORT) before connecting. Bind the actual
  // destination, decoded database name and effective routing options, not URL labels.
  const databaseScope = checksum(
    JSON.stringify([
      client.host,
      String(client.port),
      string().parse(client.database),
      databaseOptions,
    ]),
  );
  verifyScope(plan, { bucket, endpoint, databaseScope });
  // Refuse a reused receipt path before opening any production write boundary.
  const receiptFile = await open(args.output, "wx", 0o600);
  let s3: S3Client | undefined;
  const started = Date.now();
  let incomplete = false;
  let pages = 0;
  const expired = () => {
    return Date.now() - started >= args.maxMs;
  };
  const emit = async (value: object) => {
    const line = JSON.stringify(value);
    await receiptFile.write(`${line}\n`);
    await receiptFile.sync();
    console.log(line);
  };
  // Helpers stay inside this invocation. Database handles never cross a helper
  // boundary or escape the command; shared modules only build pure SQL/values.
  async function capturePlan(observation: Observation, baseline: Baseline[]) {
    const ready: Ready[] = [];
    const blocked: Plan["blocked"] = [];
    let last = args.after;
    let examined = 0;
    for (const source of observation.sources) {
      if (expired()) {
        incomplete = true;
        break;
      }
      last = source.id;
      examined++;
      try {
        const prefixes = cleanupPrefixes(source);
        const guards = reasonsSchema.parse(
          (await client.query(referenceQuery(source, prefixes, false))).rows,
        )[0];
        if (!guards) throw new RetirementError("ReferenceObservationMissing");
        if (guards.reasons.length)
          blocked.push({ id: source.id, reasons: guards.reasons });
        else
          ready.push({
            source,
            jobs: prefixes.map((prefix) => {
              return { id: randomUUID(), prefix };
            }),
          });
      } catch (error) {
        if (!(error instanceof RetirementError)) throw error;
        blocked.push({ id: source.id, reasons: [error.classification] });
      }
    }
    const review = planSchema.parse({
      format: 1,
      kind: JOB_KIND,
      bucket,
      endpoint,
      databaseScope,
      capturedAt: observation.capturedAt,
      inventory: observation.inventory,
      workflows: baseline,
      ready,
      blocked,
      nextAfter:
        incomplete || observation.sources.length === args.limit ? last : null,
    });
    validatePlan(review);
    const contents = `${JSON.stringify(review, null, 2)}\n`;
    await receiptFile.write(contents);
    await receiptFile.sync();
    console.log(
      JSON.stringify({
        status: incomplete
          ? "incomplete"
          : blocked.length
            ? "blocked"
            : "review_ready",
        examined,
        ready: ready.length,
        blocked: blocked.length,
        plannedJobs: ready.reduce((sum, row) => {
          return sum + row.jobs.length;
        }, 0),
        inventory: observation.inventory,
        nextAfter: review.nextAfter,
        planSha256: checksum(contents),
        output: args.output,
      }),
    );
    if (incomplete || blocked.length) process.exitCode = 2;
  }
  async function readJobs(row: Ready): Promise<Job[]> {
    const jobs = jobsSchema.parse(
      (
        await client.query(jobSelection, [
          row.jobs.map((job) => {
            return job.id;
          }),
        ])
      ).rows,
    );
    verifyJobs(bucket, row, jobs);
    return jobs;
  }
  async function retireRow(row: Ready, remaining: Remaining, jobs: Job[]) {
    if (
      remaining.storages === 0 &&
      remaining.versions === 0 &&
      jobs.length === row.jobs.length
    ) {
      await emit({
        storageId: row.source.id,
        status: "already_retired",
        jobs: row.jobs,
      });
      return;
    }
    if (remaining.storages === 0)
      throw new RetirementError("MissingDurableRetirementReceipt");
    // Reuse the reviewed IDs after a lost reply, without resetting job progress.
    const retired = array(object({ id: uuid() })).parse(
      (await client.query(retireQuery(bucket, row))).rows,
    );
    if (retired.length !== row.jobs.length) {
      incomplete = true;
      await emit({ storageId: row.source.id, status: "changed_or_referenced" });
    } else
      await emit({
        storageId: row.source.id,
        status: "retirement_queued",
        jobs: row.jobs,
      });
  }
  async function auditRow(row: Ready, remaining: Remaining, jobs: Job[]) {
    const complete =
      remaining.storages === 0 &&
      remaining.versions === 0 &&
      jobs.length === row.jobs.length &&
      jobs.every((job) => {
        return job.status === "completed";
      });
    incomplete ||= !complete;
    await emit({
      storageId: row.source.id,
      status: complete ? "verified" : "incomplete",
      remaining,
      jobs: jobs.map((job) => {
        return {
          id: job.id,
          status: job.status,
          failureCount: job.failure_count,
          pages: job.checkpoint.pages,
        };
      }),
    });
  }
  async function requireUnreferenced(row: Ready, target: TargetJob) {
    const observed = reasonsSchema.parse(
      (await client.query(referenceQuery(row.source, [target.prefix], true)))
        .rows,
    )[0];
    if (!observed || observed.reasons.length)
      throw new RetirementError("CleanupTargetIsReferenced");
  }
  async function deletePage(row: Ready, target: TargetJob): Promise<boolean> {
    if (!s3) throw new RetirementError("R2ClientRequired");
    await requireUnreferenced(row, target);
    const prefix = `${target.prefix}/`;
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1000,
      }),
      { abortSignal: AbortSignal.timeout(10000) },
    );
    const keys = (page.Contents ?? []).map((entry) => {
      return entry.Key;
    });
    if (
      typeof page.IsTruncated !== "boolean" ||
      keys.length > 1000 ||
      (page.KeyCount !== undefined && page.KeyCount !== keys.length) ||
      keys.some((key) => {
        return key === undefined || !key.startsWith(prefix);
      }) ||
      new Set(keys).size !== keys.length ||
      (page.IsTruncated && keys.length === 0)
    )
      throw new RetirementError("InvalidBoundedR2Listing");
    const checkedKeys = array(string().min(1)).parse(keys);
    await requireUnreferenced(row, target);
    if (checkedKeys.length) {
      const deleted = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: checkedKeys.map((Key) => {
              return { Key };
            }),
            Quiet: true,
          },
        }),
        { abortSignal: AbortSignal.timeout(10000) },
      );
      if (deleted.Errors?.length)
        throw new RetirementError("R2RejectedObjectDeletion");
    }
    // Relist from the beginning after deletion. Only a final empty page
    // certifies completion, including partial deletion and lost-reply recovery.
    return !page.IsTruncated && checkedKeys.length === 0;
  }
  async function processTarget(row: Ready, target: TargetJob, initial: Job) {
    let job = initial;
    while (job.status !== "completed" && pages < args.maxPages && !expired()) {
      const leaseId = randomUUID();
      // Existing background_jobs lease protocol; no second coordination state.
      const claimed = array(
        object({ id: uuid(), checkpoint: checkpointSchema }),
      ).parse(
        (
          await client.query(
            `UPDATE background_jobs SET status='running',lease_id=$2::uuid,
          lease_expires_at=timezone('UTC',clock_timestamp())+interval '60 seconds',updated_at=timezone('UTC',clock_timestamp())
        WHERE id=$1::uuid AND kind=$3 AND handler_version=1 AND user_id='__org__' AND org_id=$4 AND input=$5::jsonb
          AND available_at<=timezone('UTC',clock_timestamp())
          AND (status='pending' OR(status='running' AND lease_expires_at<=timezone('UTC',clock_timestamp())))
        RETURNING id,checkpoint`,
            [
              target.id,
              leaseId,
              JOB_KIND,
              row.source.orgId,
              JSON.stringify(jobInput(bucket, row.source, target)),
            ],
          )
        ).rows,
      );
      if (claimed.length !== 1) {
        incomplete = true;
        break;
      }
      const prior = claimed[0];
      if (!prior) throw new RetirementError("ClaimReceiptMissing");
      let complete = false;
      let attemptError: string | null = null;
      try {
        complete = await deletePage(row, target);
      } catch (error) {
        attemptError = failed(error);
      }
      const saved = await client.query(
        `UPDATE background_jobs SET status=$3,checkpoint=$4::jsonb,
          failure_count=failure_count+$5,last_error=$6,lease_id=NULL,lease_expires_at=NULL,
          completed_at=CASE WHEN $3='completed' THEN timezone('UTC',clock_timestamp()) ELSE NULL END,
          available_at=timezone('UTC',clock_timestamp()),updated_at=timezone('UTC',clock_timestamp())
        WHERE id=$1::uuid AND kind=$7 AND lease_id=$2::uuid AND status='running'
          AND lease_expires_at>timezone('UTC',clock_timestamp())`,
        [
          target.id,
          leaseId,
          complete ? "completed" : "pending",
          JSON.stringify({
            pages: prior.checkpoint.pages + (attemptError === null ? 1 : 0),
          }),
          attemptError === null ? 0 : 1,
          attemptError,
          JOB_KIND,
        ],
      );
      if (saved.rowCount !== 1)
        throw new RetirementError("CleanupLeaseLostReconcileBeforeContinuing");
      pages++;
      await emit({
        storageId: row.source.id,
        jobId: target.id,
        prefix: target.prefix,
        status:
          attemptError === null
            ? complete
              ? "completed"
              : "page_completed"
            : "attempt_failed",
        classification: attemptError,
      });
      if (attemptError !== null)
        throw new RetirementError("CleanupAttemptFailedNoAutomaticRetry");
      const observed = (await readJobs(row)).find((candidate) => {
        return candidate.id === target.id;
      });
      if (!observed) throw new RetirementError("CleanupJobMissing");
      job = observed;
    }
    incomplete ||= job.status !== "completed";
  }
  async function processRow(row: Ready, remaining: Remaining, jobs: Job[]) {
    if (
      remaining.storages !== 0 ||
      remaining.versions !== 0 ||
      jobs.length !== row.jobs.length
    )
      throw new RetirementError("RetiredSourceAndExactJobsRequired");
    for (const target of row.jobs) {
      const job = jobs.find((candidate) => {
        return candidate.id === target.id;
      });
      if (!job) throw new RetirementError("CleanupJobMissing");
      await processTarget(row, target, job);
    }
  }
  try {
    await client.connect();
    await client.query("SET TIME ZONE 'UTC'");
    await client.query("SET search_path=public");
    if (!args.migrate && !args["process-jobs"])
      await client.query("SET default_transaction_read_only=on");
    // The hash/attachment census can exceed 2 MB. Allow bounded result
    // reception while retaining the server SQL and other query deadlines.
    const inventoryRead = {
      ...inventoryQuery(
        args.after,
        args.reviewed ? 0 : args.limit,
        args.storageId,
      ),
      query_timeout: 120000,
    };
    const observation = observationSchema.parse(
      (await client.query(inventoryRead)).rows[0]?.observation,
    );
    const baseline = workflowBaseline(observation);
    if (!plan) {
      await capturePlan(observation, baseline);
      return;
    }
    if (args["process-jobs"]) s3 = r2Client(endpoint);
    const preservationChanges = workflowChanges(plan.workflows, baseline);
    for (const row of plan.ready) {
      if (expired()) {
        incomplete = true;
        break;
      }
      const remaining = remainingSchema.parse(
        (await client.query(remainingQuery(row.source))).rows,
      )[0];
      if (!remaining) throw new RetirementError("StorageObservationMissing");
      const jobs = await readJobs(row);
      if (args.migrate) await retireRow(row, remaining, jobs);
      else if (args.audit) await auditRow(row, remaining, jobs);
      else await processRow(row, remaining, jobs);
    }
    incomplete ||= plan.blocked.length !== 0;
    if (args.audit) incomplete ||= preservationChanges.length !== 0;
    await emit({
      status: incomplete ? "incomplete" : "batch_complete",
      pages,
      observedAt: observation.capturedAt,
      inventory: observation.inventory,
      globalInventoryEmpty: Object.values(observation.inventory).every(
        (value) => {
          return value === 0;
        },
      ),
      workflowChanges: preservationChanges,
      preservationReviewRequired: preservationChanges.length !== 0,
      note: "Natural Workflow edits, creations and deletions require review; they are not automatically cleanup corruption. Audit every reviewed plan and require an empty global inventory before final acceptance.",
    });
    if (incomplete) process.exitCode = 2;
  } finally {
    s3?.destroy();
    await client.end();
    await receiptFile.close();
  }
}

main().catch((error: unknown) => {
  // Driver/provider/validation messages can contain credentials or source data.
  // Never print them or blindly retry an uncertain database/provider effect.
  console.error(
    JSON.stringify({ status: "failed", classification: failed(error) }),
  );
  process.exitCode = 1;
});
