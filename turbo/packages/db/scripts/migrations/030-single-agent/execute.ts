import { parseArgs } from "node:util";
import { executionConnection } from "./execution-content";
import { prepareExecution } from "./execution-prepare";
import { loadPinnedImage, runPinnedCommand } from "./execution-run";
import { PlanningError } from "./snapshot";

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
