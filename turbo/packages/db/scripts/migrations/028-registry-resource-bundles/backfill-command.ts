import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { configuration, InventoryError, readEndpoint } from "./source";
import {
  inventorySchema,
  planSchema,
  sha256,
  validateRows,
} from "./backfill-plan";

function options() {
  const { values } = parseArgs({
    options: {
      inventory: { type: "string" },
      output: { type: "string" },
      apply: { type: "boolean", default: false },
      plan: { type: "string" },
      "approve-plan-sha256": { type: "string" },
    },
  });
  if (!values.output) throw new InventoryError("OutputFileRequired");
  if (
    values.apply
      ? !values.plan || !values["approve-plan-sha256"] || values.inventory
      : !values.inventory || values.plan || values["approve-plan-sha256"]
  ) {
    throw new InventoryError("UseInventoryOrExplicitReviewedPlan");
  }
  return values;
}

export async function readInput() {
  const selected = options();
  const bytes = await readFile(
    selected.apply ? selected.plan! : selected.inventory!,
  );
  if (selected.apply && sha256(bytes) !== selected["approve-plan-sha256"]) {
    throw new InventoryError("ReviewedPlanHashMismatch");
  }
  const input: unknown = JSON.parse(bytes.toString("utf8"));
  const reviewed = selected.apply ? planSchema.parse(input) : null;
  const inventory = selected.apply ? null : inventorySchema.parse(input);
  if (
    reviewed &&
    (!reviewed.complete || !reviewed.rows.length || reviewed.failures.length)
  ) {
    throw new InventoryError("IncompletePlanRejected");
  }
  const rows = reviewed?.rows ?? inventory!.rows;
  validateRows(rows);
  return { selected, bytes, reviewed, inventory, rows };
}

export async function backfillConfiguration(
  expectedScope: { database: string; bucket: string; endpoint: string },
  apply: boolean,
) {
  const config = await configuration();
  const targetBucket = process.env.REGISTRY_ARCHIVES_BUCKET_NAME;
  const accessKeyId = process.env.REGISTRY_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.REGISTRY_R2_SECRET_ACCESS_KEY;
  if (!targetBucket || !accessKeyId || !secretAccessKey)
    throw new InventoryError("MissingTargetConfiguration");
  const targetEndpoint = readEndpoint(
    process.env.REGISTRY_R2_ENDPOINT ?? config.endpoint.toString(),
  );
  const scope = {
    ...config.scope,
    targetBucket,
    targetEndpoint: targetEndpoint.origin,
  };
  if (
    apply
      ? JSON.stringify(scope) !== JSON.stringify(expectedScope)
      : JSON.stringify(config.scope) !== JSON.stringify(expectedScope)
  ) {
    throw new InventoryError("ReviewedScopeMismatch");
  }
  return {
    ...config,
    scope,
    targetBucket,
    targetEndpoint,
    targetCredentials: { accessKeyId, secretAccessKey },
  };
}
