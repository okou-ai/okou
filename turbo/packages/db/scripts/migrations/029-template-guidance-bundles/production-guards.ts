import { isDeepStrictEqual } from "node:util";
import {
  array,
  boolean,
  enum as zEnum,
  iso,
  literal,
  number,
  object,
  string,
  uuid,
  type infer as zInfer,
} from "zod";
import {
  BackfillError,
  digestSchema,
  inventorySchema,
  ownerSchema,
  planSchema,
  type Source,
  type PlannedRow,
} from "./plan";

export const PROJECT = "hidden-lab-39609750";
export const BRANCH = "br-late-pine-aft7prua";
export const BUCKET = "vm0-s3-user-storages-prod";
export const ENDPOINT =
  "https://98b0b14cee451004596479a689d2071b.r2.cloudflarestorage.com";
export const contextSchema = object({
  mode: zEnum(["plan-guidance", "apply-guidance"]),
  commit: string().regex(/^[a-f0-9]{40}$/u),
  runId: string().regex(/^\d+$/u),
  runAttempt: number().int().positive(),
  repository: literal("okou-ai/okou"),
  ref: literal("refs/heads/main"),
  actor: string().min(1),
  planRunId: string(),
  planSha256: string(),
  writersDrained: boolean(),
}).strict();
export type Context = zInfer<typeof contextSchema>;
export const metadataSchema = object({
  format: literal("template-guidance-production-plan-v1"),
  commit: string().regex(/^[a-f0-9]{40}$/u),
  runId: string().regex(/^\d+$/u),
  runAttempt: number().int().positive(),
  actor: string(),
  createdAt: iso.datetime(),
  project: literal(PROJECT),
  branch: literal(BRANCH),
  endpointId: string(),
  planSha256: digestSchema,
  inventorySha256: digestSchema,
}).strict();
export const censusRowSchema = ownerSchema.extend({
  id: uuid(),
  ownerKind: zEnum(["user-template", "presentation-template"]),
});
export type CensusRow = zInfer<typeof censusRowSchema>;

export const rolePermissionsSchema = object({
  login: string().min(1),
  role: string(),
  readonly: boolean(),
  selectUser: boolean(),
  selectPresentation: boolean(),
  writableUser: boolean(),
  writablePresentation: boolean(),
  updateUserBundle: boolean(),
  updatePresentationBundle: boolean(),
});

export function validateRolePermissions(
  permissions: zInfer<typeof rolePermissionsSchema> | undefined,
  role: string,
  applying: boolean,
) {
  if (
    !permissions ||
    permissions.login !== role ||
    !permissions.readonly ||
    !permissions.selectUser ||
    !permissions.selectPresentation ||
    (applying &&
      (!permissions.updateUserBundle ||
        !permissions.updatePresentationBundle)) ||
    (!applying &&
      (permissions.writableUser || permissions.writablePresentation))
  )
    throw new BackfillError("ProductionRolePrivilegesRejected");
}

export function validateApply(context: Context) {
  if (
    context.mode === "apply-guidance" &&
    (context.runAttempt !== 1 ||
      !context.writersDrained ||
      !/^\d+$/u.test(context.planRunId) ||
      context.planRunId === context.runId ||
      !/^[a-f0-9]{64}$/u.test(context.planSha256))
  )
    throw new BackfillError("ReviewedFirstAttemptApplyRequired");
}

async function requestJson(fetcher: typeof fetch, url: string, token: string) {
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new BackfillError("MetadataRequestFailed");
  return response.json();
}

export async function resolveTarget(
  mode: Context["mode"],
  token: string,
  fetcher: typeof fetch = fetch,
) {
  const base = `https://console.neon.tech/api/v2/projects/${PROJECT}`;
  const branch = object({
    branch: object({
      id: literal(BRANCH),
      default: literal(true),
      protected: literal(true),
      current_state: literal("ready"),
    }),
  }).parse(await requestJson(fetcher, `${base}/branches/${BRANCH}`, token));
  const endpoints = object({
    endpoints: array(
      object({
        id: string(),
        branch_id: string(),
        type: string(),
        host: string(),
      }),
    ),
  }).parse(await requestJson(fetcher, `${base}/endpoints`, token)).endpoints;
  const targets = endpoints.filter((e) => {
    return e.branch_id === branch.branch.id && e.type === "read_write";
  });
  if (targets.length !== 1)
    throw new BackfillError("ProductionEndpointNotUnique");
  const endpoint = targets[0]!;
  const role = mode === "plan-guidance" ? "RO" : "neondb_owner";
  const query = new URLSearchParams({
    branch_id: BRANCH,
    endpoint_id: endpoint.id,
    database_name: "neondb",
    role_name: role,
    pooled: "false",
  });
  const { uri } = object({ uri: string() }).parse(
    await requestJson(fetcher, `${base}/connection_uri?${query}`, token),
  );
  const address = new URL(uri);
  if (!address.password)
    throw new BackfillError("ProductionConnectionPasswordRequired");
  if (
    address.hostname !== endpoint.host ||
    (address.port && address.port !== "5432")
  )
    throw new BackfillError("ProductionConnectionEndpointRejected");
  if (decodeURIComponent(address.username) !== role)
    throw new BackfillError("ProductionConnectionRoleRejected");
  if (
    !["postgres:", "postgresql:"].includes(address.protocol) ||
    address.pathname !== "/neondb" ||
    address.hash ||
    [...address.searchParams.keys()].some((k) => {
      return !["sslmode", "channel_binding"].includes(k);
    })
  )
    throw new BackfillError("ProductionConnectionRejected");
  address.searchParams.set("sslmode", "verify-full");
  return {
    connection: address.toString(),
    endpointId: endpoint.id,
    role,
    scope: {
      database: `${address.hostname}:5432/neondb`,
      bucket: BUCKET,
      endpoint: ENDPOINT,
    },
  };
}

export async function verifyPlanOrigin(
  context: Context,
  token: string,
  fetcher: typeof fetch = fetch,
) {
  validateApply(context);
  const base = `https://api.github.com/repos/${context.repository}`;
  const run = object({
    id: number().int(),
    head_sha: string(),
    head_branch: string(),
    event: string(),
    status: string(),
    conclusion: string().nullable(),
    run_attempt: number().int().positive(),
    path: string(),
    display_title: string(),
  }).parse(
    await requestJson(
      fetcher,
      `${base}/actions/runs/${context.planRunId}`,
      token,
    ),
  );
  if (
    String(run.id) !== context.planRunId ||
    run.head_sha !== context.commit ||
    run.head_branch !== "main" ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.path !== ".github/workflows/copy-presentation-templates.yml" ||
    !run.display_title.startsWith("plan-guidance production")
  )
    throw new BackfillError("PlanRunProvenanceRejected");
  return {
    runAttempt: run.run_attempt,
    artifactName: `template-guidance-plan-${context.planRunId}-${run.run_attempt}`,
  };
}

export function validateCensus(
  owners: readonly CensusRow[],
  sources: readonly Source[],
  planned?: readonly PlannedRow[],
) {
  const key = (kind: string, id: string) => {
    return `${kind}/${id}`;
  };
  const selected = new Set(
    sources.map((s) => {
      return key(s.ownerKind, s.templateId);
    }),
  );
  if (
    owners.length > 100 ||
    owners.some((o) => {
      return o.bundle === null && !selected.has(key(o.ownerKind, o.id));
    })
  )
    throw new BackfillError("IncompleteNullOwnerInventory");
  for (const [index, source] of sources.entries()) {
    const owner = owners.find((o) => {
      return o.ownerKind === source.ownerKind && o.id === source.templateId;
    });
    if (
      !owner ||
      owner.orgId !== source.orgId ||
      owner.ownerUserId !== source.ownerUserId
    )
      throw new BackfillError("ProductionOwnerScopeChanged");
    const row = planned?.[index];
    if (
      row &&
      (owner.fingerprint !== row.owner.fingerprint ||
        (owner.bundle === null
          ? owner.revision !== row.owner.revision
          : !isDeepStrictEqual(owner.bundle, row.bundle)))
    )
      throw new BackfillError("ProductionOwnerPlanChanged");
  }
}

export function verifyReviewedPlan(
  context: Context,
  meta: zInfer<typeof metadataSchema>,
  plan: zInfer<typeof planSchema>,
  inventory: zInfer<typeof inventorySchema>,
  planHash: string,
  inventoryHash: string,
  runAttempt: number,
) {
  if (
    meta.commit !== context.commit ||
    meta.runId !== context.planRunId ||
    meta.runAttempt !== runAttempt ||
    meta.planSha256 !== context.planSha256 ||
    planHash !== context.planSha256 ||
    meta.inventorySha256 !== inventoryHash ||
    plan.inventorySha256 !== inventoryHash ||
    !plan.complete ||
    plan.failures.length ||
    !plan.rows.length ||
    !isDeepStrictEqual(plan.scope, inventory.scope) ||
    !isDeepStrictEqual(
      plan.rows.map((r) => {
        return r.source;
      }),
      inventory.rows,
    )
  )
    throw new BackfillError("ReviewedProductionPlanRejected");
}
