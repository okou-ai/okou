import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, parseArgs, promisify } from "node:util";
import { object, string, type infer as zInfer } from "zod";
import { bundleConfiguration } from "./execution-content";
import {
  executionImageSchema,
  readPrivate,
  sha256,
  writePrivate,
} from "./execution-model";
import { checkPrivileges } from "./production-database";
import { prepareExecution } from "./execution-prepare";
import { loadPinnedImage, runPinnedCommand } from "./execution-run";
import { inventory } from "./inventory";
import { plan } from "./plan";
import { parseAgentPrefixes } from "./plan-names";
import { PlanningError, parseSnapshot } from "./snapshot";
import {
  BRANCH,
  BUCKET,
  ENDPOINT,
  PROJECT,
  productionBindingSchema,
  productionContextSchema,
  productionMetadataSchema,
  type ProductionBinding,
  type ProductionContext,
  type ProductionMetadata,
} from "./production-model";
import {
  resolveProductionTarget,
  validateProductionContext,
  validateProductionMetadata,
  verifyLiveMembers,
  verifyProductionOrigin,
} from "./production-guards";
import {
  openBytes,
  openExecutionDirectory,
  packageKey,
  sealExecutionDirectory,
} from "./production-package";

async function reviewedMetadata(
  context: ProductionContext,
  directory: string,
  token: string,
) {
  const origin = await verifyProductionOrigin(context, token);
  if (origin.commit !== context.commit)
    throw new PlanningError("ProductionOperatorCommitMismatch");
  if (
    !isDeepStrictEqual((await readdir(directory)).sort(), [
      "audit.json",
      "execution.enc",
      "metadata.json",
    ])
  )
    throw new PlanningError("ProductionArtifactFilesRejected");
  const raw = await readFile(join(directory, "metadata.json"));
  if (raw.length > 64 * 1024)
    throw new PlanningError("ProductionMetadataTooLarge");
  const meta = productionMetadataSchema.parse(JSON.parse(raw.toString("utf8")));
  validateProductionMetadata(context, meta);
  return meta;
}

const credentialsSchema = object({
  neon: string().min(1),
  github: string().min(1),
  clerk: string(),
  key: string(),
}).strict();
type Credentials = zInfer<typeof credentialsSchema>;
type ProductionFiles = { request: string; reviewed: string; output: string };

async function prepareProductionPlan(
  context: ProductionContext,
  credentials: Credentials,
  connection: string,
  binding: ProductionBinding,
  files: ProductionFiles,
  privateDirectory: string,
  execution: string,
  key: Buffer,
) {
  const encoded = (await readPrivate(join(files.request, "prefixes.base64")))
    .toString("utf8")
    .trim();
  const encrypted = Buffer.from(encoded, "base64");
  if (encrypted.toString("base64") !== encoded)
    throw new PlanningError("InvalidEncryptedPrefixInput");
  const prefixBytes = openBytes(
    encrypted,
    key,
    "single-agent-production-prefixes-v1",
  );
  if (sha256(prefixBytes) !== context.prefixesSha256)
    throw new PlanningError("ReviewedPrefixDigestMismatch");
  const prefixes = parseAgentPrefixes(JSON.parse(prefixBytes.toString("utf8")));
  const source = await inventory(connection, context.orgId, "production");
  await verifyLiveMembers(context.orgId, source.members, credentials.clerk);
  const inventoryBytes = JSON.stringify(source, null, 2) + "\n";
  const planned = plan(source, context.orgId, sha256(inventoryBytes), prefixes);
  if (planned.blockers.length)
    throw new PlanningError("ProductionPlanHasBlockers");
  const planBytes = JSON.stringify(planned, null, 2) + "\n";
  const inventoryFile = join(privateDirectory, "inventory.json"),
    planFile = join(privateDirectory, "plan.json");
  await writePrivate(inventoryFile, inventoryBytes);
  await writePrivate(planFile, planBytes);
  const prepared = await prepareExecution({
    connection,
    orgId: context.orgId,
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
    prefixesSha256: context.prefixesSha256,
    summary: planned.summary,
  });
}

async function openReviewedExecution(
  context: ProductionContext,
  files: ProductionFiles,
  credentials: Credentials,
  execution: string,
  key: Buffer,
) {
  const meta = await reviewedMetadata(
    context,
    files.reviewed,
    credentials.github,
  );
  await openExecutionDirectory(
    join(files.reviewed, "execution.enc"),
    execution,
    key,
    JSON.stringify(meta),
  );
  const bytes = await readPrivate(join(execution, "execution.json"));
  if (sha256(bytes) !== context.imageSha256)
    throw new PlanningError("ReviewedProductionImageDigestMismatch");
  const image = executionImageSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    image.purpose !== "production-cutover" ||
    !isDeepStrictEqual(image.production, meta.binding)
  )
    throw new PlanningError("ProductionImagePurposeOrBindingRejected");
  return meta;
}

async function executeProduction(
  context: ProductionContext,
  files: ProductionFiles,
  credentials: Credentials,
  privateDirectory: string,
  execution: string,
  key: Buffer | undefined,
  meta: ProductionMetadata | undefined,
) {
  const target = await resolveProductionTarget(context.mode, credentials.neon);
  if (context.mode === "target") {
    await writePrivate(
      join(files.output, "audit.json"),
      JSON.stringify(
        { context, scope: target.scope, capacity: target.capacity },
        null,
        2,
      ) + "\n",
    );
    console.log(
      JSON.stringify({
        mode: "target",
        endpointId: target.endpointId,
        minimumCu: target.capacity.autoscaling_limit_min_cu,
      }),
    );
    return undefined;
  }
  const binding = productionBindingSchema.parse({
    projectId: PROJECT,
    branchId: BRANCH,
    endpointId: target.endpointId,
    commit: context.commit,
    planRunId: context.mode === "plan" ? context.runId : context.planRunId,
    orgId: context.orgId,
  });
  if (!target.connection || !target.role)
    throw new PlanningError("ExplicitProductionConnectionRequired");
  if (meta && !isDeepStrictEqual(meta.binding, binding))
    throw new PlanningError("ProductionEndpointOrCommitChanged");
  await checkPrivileges(
    target.connection,
    target.role,
    context.mode === "apply" || context.mode === "recover",
  );
  if (!credentials.clerk)
    throw new PlanningError("LiveProductionMembershipAuthorityRequired");
  if (context.mode === "plan") {
    const planned = await prepareProductionPlan(
      context,
      credentials,
      target.connection,
      binding,
      files,
      privateDirectory,
      execution,
      key!,
    );
    console.log(JSON.stringify({ mode: "plan", ...planned }));
    return planned;
  } else {
    const { image, imageSha256 } = await loadPinnedImage(
      target.connection,
      context.orgId,
      "production",
      execution,
      context.imageSha256,
      "production-cutover",
    );
    if (image.planSha256 !== context.planSha256)
      throw new PlanningError("ReviewedProductionPlanDigestMismatch");
    const snapshot = parseSnapshot(JSON.parse(image.inventoryBytes));
    await verifyLiveMembers(context.orgId, snapshot.members, credentials.clerk);
    await runPinnedCommand(
      target.connection,
      context.orgId,
      execution,
      context.mode,
      image,
      imageSha256,
    );
  }

  return meta;
}

const errorCode = (error: unknown) => {
  return error instanceof PlanningError
    ? error.message
    : error instanceof Error
      ? error.name
      : "ProductionFailed";
};

async function retainEncryptedResult(
  context: ProductionContext,
  files: ProductionFiles,
  execution: string,
  key: Buffer | undefined,
  meta: ProductionMetadata | undefined,
  completed: boolean,
  failure: unknown,
) {
  let packagingFailure: unknown;
  try {
    if (meta && key) {
      await sealExecutionDirectory(
        execution,
        join(files.output, "execution.enc"),
        key,
        JSON.stringify(meta),
      );
      await writePrivate(
        join(files.output, "metadata.json"),
        JSON.stringify(meta, null, 2) + "\n",
      );
    }
  } catch (error) {
    packagingFailure = error;
  }
  if (context.mode !== "target")
    await writePrivate(
      join(files.output, "audit.json"),
      JSON.stringify(
        {
          context,
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
  context: ProductionContext,
  files: ProductionFiles,
  credentials: Credentials,
) {
  const key =
    context.mode === "target" ? undefined : packageKey(credentials.key);
  await mkdir(files.output, { mode: 0o700 });
  const privateDirectory = await mkdtemp(join(files.request, "private-"));
  const execution = join(privateDirectory, "execution");
  let meta: ProductionMetadata | undefined,
    failure: unknown,
    packagingFailure: unknown;
  let completed = false;
  try {
    const config = bundleConfiguration();
    if (config.bucket !== BUCKET || config.endpoint !== ENDPOINT)
      throw new PlanningError("ProductionObjectStoreRejected");
    if (!["target", "plan"].includes(context.mode))
      meta = await openReviewedExecution(
        context,
        files,
        credentials,
        execution,
        key!,
      );
    meta = await executeProduction(
      context,
      files,
      credentials,
      privateDirectory,
      execution,
      key,
      meta,
    );
    completed = true;
  } catch (error) {
    failure = error;
  }
  try {
    // Never publish plaintext recovery rows or packages as workflow artifacts.
    packagingFailure = await retainEncryptedResult(
      context,
      files,
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
  const { values } = parseArgs({
    options: {
      operation: { type: "string" },
      context: { type: "string" },
      credentials: { type: "string" },
      request: { type: "string" },
      reviewed: { type: "string" },
      output: { type: "string" },
      "github-output": { type: "string" },
    },
  });
  if (!values.context || !values.credentials)
    throw new PlanningError("ProductionContextAndCredentialsRequired");
  const context = productionContextSchema.parse(
    JSON.parse((await readPrivate(values.context)).toString("utf8")),
  );
  validateProductionContext(context);
  const revision = await promisify(execFile)("git", ["rev-parse", "HEAD"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    timeout: 10_000,
  });
  if (revision.stdout.trim() !== context.commit)
    throw new PlanningError("ProductionCheckoutCommitMismatch");
  const credentials = credentialsSchema.parse(
    JSON.parse((await readPrivate(values.credentials)).toString("utf8")),
  );
  if (values.operation === "verify-origin") {
    if (!values["github-output"] || ["target", "plan"].includes(context.mode))
      throw new PlanningError("ProductionOriginArgumentsRequired");
    const origin = await verifyProductionOrigin(context, credentials.github);
    await writePrivate(
      join(dirname(values.context), "bound-context.json"),
      JSON.stringify({ ...context, commit: origin.commit }) + "\n",
    );
    await appendFile(
      values["github-output"],
      `artifact-name=${origin.artifactName}\noperator-commit=${origin.commit}\n`,
    );
    return;
  }
  if (
    values.operation !== "run" ||
    !values.output ||
    !values.request ||
    !values.reviewed
  )
    throw new PlanningError("ProductionRunArgumentsRequired");
  await runProduction(
    context,
    {
      request: values.request,
      reviewed: values.reviewed,
      output: values.output,
    },
    credentials,
  );
}

await main().catch((error: unknown) => {
  console.error(errorCode(error));
  process.exitCode = 1;
});
