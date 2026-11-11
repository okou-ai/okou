import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { object } from "zod";
import {
  executionImageSchema,
  databaseIdentity,
  executionTables,
  readPrivate,
  requirePrivateDirectory,
  sha256,
  writePrivate,
  type ExecutionImage,
} from "./execution-model";
import {
  bundleConfiguration,
  executionConnection,
  publishPreparedBundles,
  verifyPreparedContents,
} from "./execution-content";
import { prepareExecution } from "./execution-prepare";
import {
  compareState,
  readExecutionState,
  requireQuiescent,
  type ExecutionState,
} from "./execution-state";
import { writeExecution } from "./execution-write";
import { validateExecutionImage } from "./execution-validation";
import { plan } from "./plan";
import { parseAgentPrefixes } from "./plan-names";
import { parseSnapshot, PlanningError } from "./snapshot";

const help = `Single Agent isolated-copy rehearsal

prepare --org-id <id> --target <copy-label> --inventory <file> --plan <file>
  --expect-plan-sha256 <hash> --directory <new-private-directory>
  Read source rows/bundles and save complete before/after images; publish nothing.
apply|recover --org-id <id> --target <copy-label> --directory <directory>
  --expect-image-sha256 <hash> --rehearsal --writers-drained --migrate
  Publish one atomic database checkpoint or conditionally restore its full rows.
verify --org-id <id> --target <copy-label> --directory <directory>
  --expect-image-sha256 <hash>
  Read state and report before/after/drift; verify published bundles for after state.

DATABASE_URL_FILE must be an owner-only file. R2_ENDPOINT, R2_USER_STORAGES_BUCKET_NAME,
R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must explicitly select the copy's object store.
This is not a production cutover entry point. Copy lineage, stopped ingress/schedulers,
and #45473 acceptance remain operator prerequisites; a target label proves none of them.`;

function validateMode(
  command: string,
  values: {
    rehearsal?: boolean;
    "writers-drained"?: boolean;
    migrate?: boolean;
  },
) {
  const mutation = command === "apply" || command === "recover";
  if (
    mutation &&
    (!values.rehearsal || !values["writers-drained"] || !values.migrate)
  )
    throw new PlanningError("RehearsalWritersDrainedAndMigrateRequired");
  if (
    !mutation &&
    (values.rehearsal || values["writers-drained"] || values.migrate)
  )
    throw new PlanningError("ReadOnlyCommandDoesNotAcceptWriteFlags");
}

function readOptions() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      "org-id": { type: "string" },
      target: { type: "string" },
      directory: { type: "string" },
      inventory: { type: "string" },
      plan: { type: "string" },
      "expect-plan-sha256": { type: "string" },
      "expect-image-sha256": { type: "string" },
      rehearsal: { type: "boolean" },
      "writers-drained": { type: "boolean" },
      migrate: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  const [command] = positionals;
  const orgId = values["org-id"],
    target = values.target,
    directory = values.directory;
  if (
    positionals.length !== 1 ||
    !orgId?.trim() ||
    !target?.trim() ||
    !directory ||
    !command ||
    !["prepare", "apply", "verify", "recover"].includes(command)
  )
    throw new PlanningError(
      "ExplicitRehearsalCommandOrgTargetAndDirectoryRequired; use --help",
    );

  validateMode(command, values);
  if (command === "prepare") {
    if (
      !values.inventory ||
      !values.plan ||
      !values["expect-plan-sha256"] ||
      values["expect-image-sha256"]
    )
      throw new PlanningError("ReviewedInventoryPlanAndHashRequired");
    return {
      kind: "prepare" as const,
      orgId,
      target,
      directory,
      inventoryFile: values.inventory,
      planFile: values.plan,
      expectedPlanSha256: values["expect-plan-sha256"],
    };
  }
  if (
    !values["expect-image-sha256"] ||
    values.inventory ||
    values.plan ||
    values["expect-plan-sha256"]
  )
    throw new PlanningError("PinnedExecutionImageRequired");
  return {
    kind: "pinned" as const,
    orgId,
    target,
    directory,
    command,
    expectedHash: values["expect-image-sha256"],
  };
}

async function loadPinnedImage(
  connection: string,
  orgId: string,
  target: string,
  directory: string,
  expectedHash: string,
) {
  await requirePrivateDirectory(directory);
  const bytes = await readPrivate(join(directory, "execution.json"));
  const imageSha256 = sha256(bytes);
  if (imageSha256 !== expectedHash)
    throw new PlanningError("ExecutionImageHashMismatch");
  const image = executionImageSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (image.scope.orgId !== orgId || image.scope.target !== target)
    throw new PlanningError("ExecutionScopeMismatch");
  if (image.scope.databaseEndpoint !== databaseIdentity(connection))
    throw new PlanningError("ExecutionDatabaseEndpointMismatch");
  if (
    sha256(image.inventoryBytes) !== image.inventorySha256 ||
    sha256(image.planBytes) !== image.planSha256
  )
    throw new PlanningError("ExecutionSourceHashMismatch");
  const snapshot = parseSnapshot(JSON.parse(image.inventoryBytes));
  const prefixInput = object({ agentPrefixes: object({}).passthrough() }).parse(
    JSON.parse(image.planBytes),
  );
  const approved = plan(
    snapshot,
    orgId,
    image.inventorySha256,
    parseAgentPrefixes(prefixInput.agentPrefixes),
  );
  if (
    approved.blockers.length ||
    JSON.stringify(approved, null, 2) + "\n" !== image.planBytes
  )
    throw new PlanningError("ExecutionPlanMismatch");
  if (
    image.tables.length !== executionTables.length ||
    new Set(
      image.tables.map((table) => {
        return table.name;
      }),
    ).size !== executionTables.length
  )
    throw new PlanningError("ExecutionTableInventoryMismatch");
  validateExecutionImage(image, approved, snapshot);
  const configuration = bundleConfiguration();
  if (
    image.scope.bucket !== configuration.bucket ||
    image.scope.endpoint !== configuration.endpoint
  )
    throw new PlanningError("ExecutionObjectStoreMismatch");

  return { image, imageSha256 };
}

async function runPinnedCommand(
  connection: string,
  orgId: string,
  directory: string,
  command: string,
  image: ExecutionImage,
  imageSha256: string,
) {
  const state = await readExecutionState(
    connection,
    orgId,
    image.automationIds,
    image.runIds,
  );
  if (state.database !== image.scope.database)
    throw new PlanningError("ExecutionDatabaseMismatch");
  requireQuiescent(state);
  const before = compareState(state, image.tables, "before");
  const after = compareState(state, image.tables, "after");
  if (command === "verify") {
    if (!before && !after) throw new PlanningError("ExecutionStateDrift");
    if (after)
      await publishPreparedBundles(
        join(directory, "bundles"),
        image.bundles,
        false,
      );
    console.log(
      JSON.stringify({
        command,
        imageSha256,
        state: after ? "after" : "before",
      }),
    );
    return;
  }
  if (!before && !after) throw new PlanningError("ExecutionStateDrift");

  await mutateCheckpoint({
    connection,
    orgId,
    directory,
    command,
    image,
    imageSha256,
    state,
    before,
    after,
  });
}

async function mutateCheckpoint(args: {
  connection: string;
  orgId: string;
  directory: string;
  command: string;
  image: ExecutionImage;
  imageSha256: string;
  state: ExecutionState;
  before: boolean;
  after: boolean;
}) {
  const {
    connection,
    orgId,
    directory,
    command,
    image,
    imageSha256,
    state,
    before,
    after,
  } = args;
  const recover = command === "recover";
  const attempt = randomUUID();
  const receipt = async (stage: string, fields: object) => {
    await writePrivate(
      join(directory, `${attempt}-${stage}.json`),
      JSON.stringify(
        {
          format: "single-agent-attempt-v1",
          command,
          imageSha256,
          scope: image.scope,
          stage,
          ...fields,
        },
        null,
        2,
      ) + "\n",
    );
  };
  await receipt("started", { observedState: after ? "after" : "before" });
  if (recover ? before : after) {
    if (after)
      await publishPreparedBundles(
        join(directory, "bundles"),
        image.bundles,
        false,
      );
    await receipt("complete", {
      status: recover ? "already-recovered" : "already-applied",
    });
    console.log(
      JSON.stringify({
        command,
        imageSha256,
        status: recover ? "already-recovered" : "already-applied",
      }),
    );
    return;
  }
  if (!recover && !compareState(state, image.tables, "before", true))
    throw new PlanningError("ExecutionSourceRevisionDrift");
  if (!recover) {
    await verifyPreparedContents(join(directory, "bundles"), image);
    await publishPreparedBundles(
      join(directory, "bundles"),
      image.bundles,
      true,
    );
    await receipt("published", {
      bundles: image.bundles.map((bundle) => {
        return bundle.sha256;
      }),
    });
  }
  // The before image is durable before uploads or SQL. Missing completion is uncertain,
  // resolved from authoritative rows by the next verify/apply/recover invocation.
  await writeExecution(connection, image, recover);
  const verified = await readExecutionState(
    connection,
    orgId,
    image.automationIds,
    image.runIds,
  );
  if (!compareState(verified, image.tables, recover ? "before" : "after"))
    throw new PlanningError("ExecutionVerificationFailedKeepRecoveryImage");
  await receipt("complete", { status: recover ? "recovered" : "applied" });
  console.log(
    JSON.stringify({
      command,
      imageSha256,
      status: recover ? "recovered" : "applied",
    }),
  );
}

async function main() {
  const options = readOptions();
  if (!options) return;
  const connection = await executionConnection();
  if (options.kind === "prepare") {
    console.log(
      JSON.stringify(await prepareExecution({ ...options, connection })),
    );
    return;
  }
  const { image, imageSha256 } = await loadPinnedImage(
    connection,
    options.orgId,
    options.target,
    options.directory,
    options.expectedHash,
  );
  await runPinnedCommand(
    connection,
    options.orgId,
    options.directory,
    options.command,
    image,
    imageSha256,
  );
}

await main().catch((error: unknown) => {
  console.error(
    error instanceof PlanningError
      ? error.message
      : error instanceof Error
        ? error.name
        : "ExecutionFailed",
  );
  process.exitCode = 1;
});
