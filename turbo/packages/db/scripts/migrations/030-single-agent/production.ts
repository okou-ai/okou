import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { literal, object, string } from "zod";
import { bundleConfiguration, executionConnection } from "./execution-content";
import {
  executionImageSchema,
  readPrivate,
  requirePrivateDirectory,
  sha256,
  writePrivate,
} from "./execution-model";
import { prepareExecution } from "./execution-prepare";
import { loadPinnedImage, runPinnedCommand } from "./execution-run";
import { inventory } from "./inventory";
import { plan } from "./plan";
import { parseAgentPrefixes } from "./plan-names";
import { checkPrivileges } from "./production-database";
import {
  resolveProductionTarget,
  validateProductionConnection,
  verifyLiveMembers,
} from "./production-guards";
import {
  BRANCH,
  BUCKET,
  ENDPOINT,
  PROJECT,
  commitSchema,
  productionBindingSchema,
  productionMetadataSchema,
  type ProductionBinding,
  type ProductionMetadata,
} from "./production-model";
import {
  readProductionOptions,
  type OperationOptions,
  type PlanOptions,
  type ReviewedOptions,
} from "./production-options";
import {
  openExecutionDirectory,
  packageKey,
  sealExecutionDirectory,
} from "./production-package";
import { PlanningError, parseSnapshot } from "./snapshot";

async function operatorCommit() {
  const exec = promisify(execFile);
  const options = {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    timeout: 10_000,
  };
  const revision = await exec("git", ["rev-parse", "HEAD"], options);
  const status = await exec(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    options,
  );
  if (status.stdout.trim())
    throw new PlanningError("CleanReviewedCheckoutRequired");
  return commitSchema.parse(revision.stdout.trim());
}

async function reviewedMetadata(options: ReviewedOptions, commit: string) {
  await requirePrivateDirectory(options.planDirectory);
  if (
    !isDeepStrictEqual((await readdir(options.planDirectory)).sort(), [
      "audit.json",
      "execution.enc",
      "metadata.json",
    ])
  )
    throw new PlanningError("ProductionPlanFilesRejected");
  const meta = productionMetadataSchema.parse(
    JSON.parse(
      (
        await readPrivate(join(options.planDirectory, "metadata.json"))
      ).toString("utf8"),
    ),
  );
  const audit = object({
    mode: literal("plan"),
    completed: literal(true),
    commit: commitSchema,
    imageSha256: string(),
  }).parse(
    JSON.parse(
      (await readPrivate(join(options.planDirectory, "audit.json"))).toString(
        "utf8",
      ),
    ),
  );
  if (
    meta.binding.commit !== commit ||
    audit.commit !== commit ||
    meta.binding.orgId !== options.orgId ||
    meta.planSha256 !== options.planSha256 ||
    meta.imageSha256 !== options.imageSha256 ||
    audit.imageSha256 !== meta.imageSha256
  )
    throw new PlanningError(
      "ReviewedProductionMetadataMismatch; use original clean operator checkout",
    );
  return meta;
}

async function prepareProductionPlan(
  options: PlanOptions,
  connection: string,
  clerk: string,
  binding: ProductionBinding,
  privateDirectory: string,
  execution: string,
) {
  const prefixBytes = await readPrivate(options.prefixesFile);
  const prefixes = parseAgentPrefixes(JSON.parse(prefixBytes.toString("utf8")));
  const source = await inventory(connection, options.orgId, "production");
  await verifyLiveMembers(options.orgId, source.members, clerk);
  const inventoryBytes = JSON.stringify(source, null, 2) + "\n";
  const planned = plan(source, options.orgId, sha256(inventoryBytes), prefixes);
  if (planned.blockers.length)
    throw new PlanningError("ProductionPlanHasBlockers");
  const planBytes = JSON.stringify(planned, null, 2) + "\n";
  const inventoryFile = join(privateDirectory, "inventory.json"),
    planFile = join(privateDirectory, "plan.json");
  await writePrivate(inventoryFile, inventoryBytes);
  await writePrivate(planFile, planBytes);
  const prepared = await prepareExecution({
    connection,
    orgId: options.orgId,
    target: "production",
    directory: execution,
    inventoryFile,
    planFile,
    expectedPlanSha256: sha256(planBytes),
    production: binding,
  });
  return productionMetadataSchema.parse({
    format: "single-agent-production-plan-v1",
    binding,
    createdAt: new Date().toISOString(),
    inventorySha256: sha256(inventoryBytes),
    planSha256: sha256(planBytes),
    imageSha256: prepared.sha256,
    prefixesSha256: sha256(prefixBytes),
    summary: planned.summary,
  });
}

async function openReviewedExecution(
  options: ReviewedOptions,
  meta: ProductionMetadata,
  execution: string,
  key: Buffer,
) {
  await openExecutionDirectory(
    join(options.planDirectory, "execution.enc"),
    execution,
    key,
    JSON.stringify(meta),
  );
  const bytes = await readPrivate(join(execution, "execution.json"));
  if (sha256(bytes) !== options.imageSha256)
    throw new PlanningError("ReviewedProductionImageDigestMismatch");
  const image = executionImageSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    image.purpose !== "production-cutover" ||
    !isDeepStrictEqual(image.production, meta.binding)
  )
    throw new PlanningError("ProductionImagePurposeOrBindingRejected");
  return meta;
}

async function executeReviewed(
  options: ReviewedOptions,
  connection: string,
  clerk: string,
  execution: string,
) {
  const { image, imageSha256 } = await loadPinnedImage(
    connection,
    options.orgId,
    "production",
    execution,
    options.imageSha256,
    "production-cutover",
  );
  if (image.planSha256 !== options.planSha256)
    throw new PlanningError("ReviewedProductionPlanDigestMismatch");
  await verifyLiveMembers(
    options.orgId,
    parseSnapshot(JSON.parse(image.inventoryBytes)).members,
    clerk,
  );
  await runPinnedCommand(
    connection,
    options.orgId,
    execution,
    options.mode,
    image,
    imageSha256,
  );
}

const errorCode = (error: unknown) => {
  return error instanceof PlanningError
    ? error.message
    : error instanceof Error
      ? error.name
      : "ProductionFailed";
};

async function retainEncryptedResult(
  options: OperationOptions,
  commit: string,
  execution: string,
  key: Buffer,
  meta: ProductionMetadata | undefined,
  completed: boolean,
  failure: unknown,
) {
  let packagingFailure: unknown;
  try {
    if (meta) {
      await sealExecutionDirectory(
        execution,
        join(options.directory, "execution.enc"),
        key,
        JSON.stringify(meta),
      );
      await writePrivate(
        join(options.directory, "metadata.json"),
        JSON.stringify(meta, null, 2) + "\n",
      );
    }
  } catch (error) {
    packagingFailure = error;
  }
  await writePrivate(
    join(options.directory, "audit.json"),
    JSON.stringify(
      {
        mode: options.mode,
        orgId: options.orgId,
        commit,
        completed,
        errorCode: failure ? errorCode(failure) : undefined,
        packagingError: packagingFailure
          ? errorCode(packagingFailure)
          : undefined,
        imageSha256: meta?.imageSha256,
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  return packagingFailure;
}

async function runProduction(
  options: OperationOptions,
  connection: string,
  clerk: string,
  commit: string,
  endpointId: string,
  key: Buffer,
  reviewed: ProductionMetadata | undefined,
) {
  await mkdir(options.directory, { mode: 0o700 });
  const privateDirectory = await mkdtemp(join(options.directory, "private-"));
  const execution = join(privateDirectory, "execution");
  let meta: ProductionMetadata | undefined,
    failure: unknown,
    packagingFailure: unknown;
  let completed = false;
  try {
    if (options.mode === "plan") {
      const binding = productionBindingSchema.parse({
        projectId: PROJECT,
        branchId: BRANCH,
        endpointId,
        commit,
        planId: randomUUID(),
        orgId: options.orgId,
      });
      meta = await prepareProductionPlan(
        options,
        connection,
        clerk,
        binding,
        privateDirectory,
        execution,
      );
      console.log(JSON.stringify({ mode: "plan", ...meta }));
    } else {
      if (!reviewed)
        throw new PlanningError("ReviewedProductionMetadataRequired");
      meta = await openReviewedExecution(options, reviewed, execution, key);
      if (meta.binding.endpointId !== endpointId)
        throw new PlanningError("ProductionEndpointChanged");
      await executeReviewed(options, connection, clerk, execution);
    }
    completed = true;
  } catch (error) {
    failure = error;
  }
  try {
    // Keep source data encrypted in the durable directory, even after a failed apply.
    packagingFailure = await retainEncryptedResult(
      options,
      commit,
      execution,
      key,
      meta,
      completed,
      failure,
    );
  } catch (error) {
    packagingFailure = error;
  } finally {
    await rm(privateDirectory, { recursive: true, force: true });
  }
  if (failure) throw failure;
  if (packagingFailure) throw packagingFailure;
}

async function main() {
  const options = readProductionOptions();
  if (!options) return;
  const neon = string().min(1).parse(process.env.NEON_API_KEY);
  const target = await resolveProductionTarget(neon);
  if (options.mode === "target") {
    console.log(
      JSON.stringify({
        mode: "target",
        orgId: options.orgId,
        endpointId: target.endpointId,
        scope: target.scope,
        minimumCu: target.capacity.autoscaling_limit_min_cu,
      }),
    );
    return;
  }
  const commit = await operatorCommit();
  const clerk = string().min(1).parse(process.env.CLERK_SECRET_KEY);
  const key = packageKey(
    (await readPrivate(options.keyFile)).toString("utf8").trim(),
  );
  const config = bundleConfiguration();
  if (config.bucket !== BUCKET || config.endpoint !== ENDPOINT)
    throw new PlanningError("ProductionObjectStoreRejected");
  const reviewed =
    options.mode === "plan"
      ? undefined
      : await reviewedMetadata(options, commit);
  const writable = options.mode === "apply" || options.mode === "recover";
  const { connection, role } = validateProductionConnection(
    await executionConnection(),
    target.capacity.host,
    writable,
  );
  await checkPrivileges(connection, role, writable);
  await runProduction(
    options,
    connection,
    clerk,
    commit,
    target.endpointId,
    key,
    reviewed,
  );
}

await main().catch((error: unknown) => {
  console.error(errorCode(error));
  process.exitCode = 1;
});
