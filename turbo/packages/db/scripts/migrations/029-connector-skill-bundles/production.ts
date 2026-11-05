import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";
import postgres from "postgres";
import { array, literal, number, object, string } from "zod";
import { configuration, sha256 } from "./command";
import {
  fingerprintSchema,
  productionBucket,
  productionEndpoint,
  productionTargets,
  reviewedPlanRun,
  reviewedProductionPlan,
} from "./production-plan";

const execute = promisify(execFile);
const project = "hidden-lab-39609750";
const branch = "br-late-pine-aft7prua";
const preparationCommit = "6a51f10737ae9c0e2ee40509387fbd6f04b0f095";
const receipts = resolve(required("RECEIPTS_DIRECTORY"));
const privateDirectory = resolve(required("CREDENTIAL_DIRECTORY"));
const mode = required("BACKFILL_MODE");
let phase = "dispatch";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error("MissingProductionConfiguration");
  return value;
}

async function request(url: string, token?: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("ProductionControlPlaneReadFailed");
  return response.json();
}

async function writerDrain() {
  const build = object({ commitSha: string().regex(/^[a-f0-9]{40}$/u) }).parse(
    await request("https://api.okou.ai/api/build-info"),
  );
  await execute("git", [
    "merge-base",
    "--is-ancestor",
    preparationCommit,
    build.commitSha,
  ]);
  const { deployments } = object({
    deployments: array(
      object({
        uid: string(),
        state: string(),
        aliasAssigned: number().nullable().optional(),
        meta: object({ githubCommitSha: string().regex(/^[a-f0-9]{40}$/u) }),
      }),
    ),
  }).parse(
    await request(
      "https://api.vercel.com/v6/deployments?projectId=prj_6mw0CgYjECVrJV57VJ47VN03B4UR&teamId=team_WRqI0kCoX5KcRInRWgZ1nBF0&target=production&limit=5",
      required("VERCEL_TOKEN"),
    ),
  );
  const active = deployments
    .flatMap(({ aliasAssigned, ...deployment }) => {
      if (deployment.state !== "READY" || typeof aliasAssigned !== "number")
        return [];
      return [{ ...deployment, aliasAssigned }];
    })
    .sort((a, b) => {
      return b.aliasAssigned - a.aliasAssigned;
    });
  const [current, previous] = active;
  if (
    !current?.aliasAssigned ||
    !previous ||
    current.meta.githubCommitSha !== build.commitSha
  )
    throw new Error("ProductionDeploymentNotConfirmed");
  const outgoingConfig = await execute("git", [
    "show",
    `${previous.meta.githubCommitSha}:turbo/apps/api/vite.config.ts`,
  ]);
  if (!/maxDuration:\s*300\b/u.test(outgoingConfig.stdout))
    throw new Error("OutgoingRequestBoundNotConfirmed");
  const deadline = current.aliasAssigned + 300_000;
  if (Date.now() <= deadline) throw new Error("OutgoingWritersNotDrained");
  return {
    servingCommit: build.commitSha,
    deployment: current.uid,
    previousDeployment: previous.uid,
    cutoverAt: new Date(current.aliasAssigned).toISOString(),
    drainedAt: new Date(deadline).toISOString(),
    checkedAt: new Date().toISOString(),
  };
}

async function productionConnection() {
  if (
    required("NEON_PROJECT_ID") !== project ||
    required("R2_ENDPOINT") !== productionEndpoint ||
    required("R2_USER_STORAGES_BUCKET_NAME") !== productionBucket
  )
    throw new Error("ProductionEnvironmentMismatch");
  const base = `https://console.neon.tech/api/v2/projects/${project}`;
  const token = required("NEON_API_KEY");
  phase = "verify-production-branch";
  object({
    branch: object({
      id: literal(branch),
      name: literal("production"),
      default: literal(true),
      protected: literal(true),
    }),
  }).parse(await request(`${base}/branches/${branch}`, token));
  phase = "verify-production-endpoint";
  const { endpoints } = object({
    endpoints: array(
      object({
        id: string(),
        branch_id: string(),
        host: string(),
        type: string(),
      }),
    ),
  }).parse(await request(`${base}/endpoints`, token));
  const writers = endpoints.filter((endpoint) => {
    return endpoint.branch_id === branch && endpoint.type === "read_write";
  });
  const [endpoint] = writers;
  if (writers.length !== 1 || !endpoint)
    throw new Error("ProductionEndpointNotUnique");
  const parameters = new URLSearchParams({
    branch_id: branch,
    endpoint_id: endpoint.id,
    database_name: "neondb",
    role_name: "neondb_owner",
    pooled: "false",
  });
  phase = "resolve-protected-connection";
  const { uri } = object({ uri: string() }).parse(
    await request(`${base}/connection_uri?${parameters}`, token),
  );
  const address = new URL(uri);
  if (
    address.protocol !== "postgresql:" ||
    address.hostname !== endpoint.host ||
    (address.port && address.port !== "5432") ||
    address.pathname !== "/neondb" ||
    decodeURIComponent(address.username) !== "neondb_owner" ||
    !address.password ||
    address.searchParams.has("host") ||
    address.searchParams.has("port")
  )
    throw new Error("ProductionConnectionMismatch");
  address.searchParams.set("sslmode", "verify-full");
  const file = join(privateDirectory, "database-url");
  await writeFile(file, address.toString(), { mode: 0o600, flag: "wx" });
  process.env.DATABASE_URL_FILE = file;
  return configuration();
}

async function main() {
  if (
    !["plan", "apply"].includes(mode) ||
    required("GITHUB_REF") !== "refs/heads/main" ||
    required("GITHUB_REPOSITORY") !== "okou-ai/okou" ||
    required("GITHUB_RUN_ATTEMPT") !== "1"
  )
    throw new Error("ProductionDispatchRejected");
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  phase = "verify-writer-drain";
  const drain = await writerDrain();
  await writeFile(
    join(receipts, "writer-drain.json"),
    JSON.stringify(drain, null, 2),
  );
  const config = await productionConnection();
  const sql = postgres(config.connection, {
    max: 1,
    onnotice() {},
    connection: { default_transaction_read_only: true, timezone: "UTC" },
  });
  const ids: string[] = productionTargets.map((target) => {
    return target.connectorId;
  });
  const snapshot = async (name: string) => {
    const rows = fingerprintSchema.parse(
      await sql`
      SELECT c.id, md5((to_jsonb(c) - 'skill_content_bundle'
        - 'skill_content_bundle_source_version_id')::text) AS fingerprint,
        c.xmin::text AS xmin
      FROM org_custom_connectors c WHERE c.id IN ${sql(ids)} ORDER BY c.id`,
    );
    if (
      rows.length !== ids.length ||
      rows.some((row) => {
        return !ids.includes(row.id);
      })
    )
      throw new Error("ProductionOwnerInventoryMismatch");
    await writeFile(join(receipts, name), JSON.stringify(rows, null, 2));
    return rows;
  };
  const environment = {
    PATH: required("PATH"),
    TZ: "UTC",
    DATABASE_URL_FILE: required("DATABASE_URL_FILE"),
    R2_ENDPOINT: config.endpoint,
    R2_USER_STORAGES_BUCKET_NAME: config.bucket,
    R2_ACCESS_KEY_ID: config.credentials.accessKeyId,
    R2_SECRET_ACCESS_KEY: config.credentials.secretAccessKey,
  };
  const operator = async (arguments_: string[]) => {
    const { stdout } = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/migrations/029-connector-skill-bundles/backfill.ts",
        ...arguments_,
      ],
      { env: environment, timeout: 600_000, maxBuffer: 1024 * 1024 },
    );
    const result = object({
      complete: literal(true),
      verified: literal(3),
      failed: literal(0),
    }).parse(JSON.parse(stdout.trim()));
    return result;
  };
  try {
    phase = "snapshot-owners";
    const before = await snapshot("owners-before.json");
    const planFile = join(receipts, "plan.json");
    if (mode === "plan") {
      phase = "read-only-plan";
      await operator([
        ...ids.flatMap((id) => {
          return ["--connector-id", id];
        }),
        "--output",
        planFile,
      ]);
      const bytes = await readFile(planFile);
      const hash = sha256(bytes);
      reviewedProductionPlan(bytes, hash, config.scope);
      if (!isDeepStrictEqual(before, await snapshot("owners-after.json")))
        throw new Error("ReadOnlyPlanChangedOwners");
      await writeFile(
        join(receipts, "plan-context.json"),
        JSON.stringify({
          sourceCommit: required("GITHUB_SHA"),
          servingCommit: drain.servingCommit,
        }),
      );
      await appendFile(
        required("GITHUB_STEP_SUMMARY"),
        `Read-only plan for exactly 3 approved owners.\n\nPlan SHA-256: \`${hash}\`\n`,
      );
    } else {
      phase = "verify-reviewed-plan";
      const runId = Number(required("PLAN_RUN_ID"));
      if (!Number.isSafeInteger(runId) || runId <= 0)
        throw new Error("InvalidPlanRun");
      reviewedPlanRun(
        await request(
          `https://api.github.com/repos/okou-ai/okou/actions/runs/${runId}`,
          required("GITHUB_TOKEN"),
        ),
        runId,
        required("GITHUB_SHA"),
      );
      const inputDirectory = resolve(required("PLAN_DIRECTORY"));
      const context = object({
        sourceCommit: string(),
        servingCommit: string(),
      }).parse(
        JSON.parse(
          await readFile(join(inputDirectory, "plan-context.json"), "utf8"),
        ),
      );
      if (
        context.sourceCommit !== required("GITHUB_SHA") ||
        context.servingCommit !== drain.servingCommit
      )
        throw new Error("ProductionPlanContextChanged");
      const bytes = await readFile(join(inputDirectory, "plan.json"));
      const hash = required("PLAN_SHA256");
      reviewedProductionPlan(bytes, hash, config.scope);
      await writeFile(planFile, bytes, { flag: "wx" });
      const arguments_ = [
        "--migrate",
        "--writers-drained",
        "--plan",
        planFile,
        "--approve-plan-sha256",
        hash,
      ];
      phase = "apply-reviewed-plan";
      try {
        await operator([
          ...arguments_,
          "--output",
          join(receipts, "apply.jsonl"),
        ]);
      } finally {
        await snapshot("owners-after-apply.json");
      }
      const after = await snapshot("owners-verified.json");
      if (
        !isDeepStrictEqual(
          before.map(({ id, fingerprint }) => {
            return { id, fingerprint };
          }),
          after.map(({ id, fingerprint }) => {
            return { id, fingerprint };
          }),
        )
      )
        throw new Error("UnapprovedOwnerFieldsChanged");
      phase = "verify-idempotence";
      await operator([
        ...arguments_,
        "--output",
        join(receipts, "idempotence.jsonl"),
      ]);
      if (!isDeepStrictEqual(after, await snapshot("owners-after-rerun.json")))
        throw new Error("IdempotenceChangedOwners");
      await appendFile(
        required("GITHUB_STEP_SUMMARY"),
        `Applied plan \`${hash}\` from run ${runId}; 3/3 verified.\n\n` +
          "Other owner fields preserved; successful rerun preserved xmin.\n",
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

try {
  await main();
} catch {
  console.error(
    `Controlled production backfill stopped at ${phase}. Inspect metadata receipts before any further execution.`,
  );
  process.exitCode = 1;
} finally {
  await rm(privateDirectory, { recursive: true, force: true });
}
