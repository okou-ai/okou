import { randomUUID } from "node:crypto";
import { join } from "node:path";
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
  publishPreparedBundles,
  verifyPreparedContents,
} from "./execution-content";
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

export async function loadPinnedImage(
  connection: string,
  orgId: string,
  target: string,
  directory: string,
  expectedHash: string,
  purpose: ExecutionImage["purpose"] = "isolated-copy-rehearsal",
) {
  await requirePrivateDirectory(directory);
  const bytes = await readPrivate(join(directory, "execution.json"));
  const imageSha256 = sha256(bytes);
  if (imageSha256 !== expectedHash)
    throw new PlanningError("ExecutionImageHashMismatch");
  const image = executionImageSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (image.purpose !== purpose)
    throw new PlanningError("ExecutionPurposeMismatch");
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

export async function runPinnedCommand(
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
          purpose: image.purpose,
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
