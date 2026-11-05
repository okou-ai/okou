import { array, literal, number, object, string } from "zod";
import { planSchema, sha256 } from "./command";

export const productionTargets = [
  {
    connectorId: "1ced2d7f-66de-4c65-9cdc-fded9c8d24ed",
    orgId: "org_3DggYim3sLjz1KegUEFgLaYzwZd",
    storageId: "d5708b02-6831-4b09-9e9a-ffeae6b22fc1",
    sourceVersionId:
      "ff781d3c57e00ddc2b597f7977506205cff16ea9003790a4231c9572d162ad11",
  },
  {
    connectorId: "3d9fb37a-3c63-4594-ac60-e933875475b7",
    orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
    storageId: "82f9bf9d-2e33-44e2-ae49-b20c82bbc7d3",
    sourceVersionId:
      "1deeb25b179d18d71a9a1d1818c60022b8970a2aff717fabecd77a1f43001b59",
  },
  {
    connectorId: "f8e359ea-2df0-40de-9d1a-b476c9903459",
    orgId: "org_3AW2QiNyfbz196bcHexc1E35nOq",
    storageId: "210f914c-7145-4dc9-a66a-eca069d3736a",
    sourceVersionId:
      "67779af2b773e38960b5edfd21b778cda6bd5a3105fde961b1127109778f8ae6",
  },
] as const;

export const productionBucket = "vm0-s3-user-storages-prod";
export const productionEndpoint =
  "https://98b0b14cee451004596479a689d2071b.r2.cloudflarestorage.com";
export const productionWorkflow =
  ".github/workflows/backfill-connector-skill-bundles.yml";
export const fingerprintSchema = array(
  object({
    id: string(),
    fingerprint: string().regex(/^[a-f0-9]{32}$/u),
    xmin: string().regex(/^\d+$/u),
  }),
);

export function reviewedProductionPlan(
  bytes: Buffer,
  approvedHash: string,
  scope: { database: string; bucket: string; endpoint: string },
) {
  if (!/^[a-f0-9]{64}$/u.test(approvedHash) || sha256(bytes) !== approvedHash)
    throw new Error("ProductionPlanHashMismatch");
  const plan = planSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    !plan.complete ||
    plan.failures.length ||
    plan.rows.length !== productionTargets.length ||
    plan.scope.database !== scope.database ||
    plan.scope.bucket !== productionBucket ||
    plan.scope.bucket !== scope.bucket ||
    plan.scope.endpoint !== productionEndpoint ||
    plan.scope.endpoint !== scope.endpoint
  )
    throw new Error("ProductionPlanScopeMismatch");
  for (const target of productionTargets) {
    const matching = plan.rows.filter(({ source }) => {
      return Object.entries(target).every(([key, value]) => {
        return source[key as keyof typeof target] === value;
      });
    });
    if (matching.length !== 1) throw new Error("ProductionPlanTargetMismatch");
  }
  return plan;
}

export function reviewedPlanRun(value: unknown, runId: number, commit: string) {
  const run = object({
    id: number().int().positive(),
    event: literal("workflow_dispatch"),
    head_branch: literal("main"),
    head_sha: string().regex(/^[a-f0-9]{40}$/u),
    path: literal(productionWorkflow),
    status: literal("completed"),
    conclusion: literal("success"),
    run_attempt: literal(1),
  }).parse(value);
  if (run.id !== runId || run.head_sha !== commit)
    throw new Error("ProductionPlanRevisionMismatch");
  return run;
}
