import assert from "node:assert/strict";
import {
  BRANCH,
  BUCKET,
  ENDPOINT,
  PROJECT,
  censusRowSchema,
  contextSchema,
  metadataSchema,
  resolveTarget,
  validateApply,
  validateCensus,
  verifyPlanOrigin,
  verifyReviewedPlan,
  validateRolePermissions,
} from "./production-guards";
import { inventorySchema, planSchema } from "./plan";

const context = contextSchema.parse({
  mode: "apply-guidance",
  commit: "a".repeat(40),
  runId: "200",
  runAttempt: 1,
  repository: "okou-ai/okou",
  ref: "refs/heads/main",
  actor: "fixture",
  planRunId: "100",
  planSha256: "a".repeat(64),
  writersDrained: true,
});
const readonlyPermissions = {
  role: "okou_readonly_access",
  readonly: true,
  selectUser: true,
  selectPresentation: true,
  writableUser: false,
  writablePresentation: false,
};
validateRolePermissions(readonlyPermissions, "okou_readonly_access", false);
for (const changed of [
  { readonly: false },
  { selectUser: false },
  { selectPresentation: false },
  { writableUser: true },
  { writablePresentation: true },
  { role: "foreign" },
])
  assert.throws(
    () =>
      validateRolePermissions(
        { ...readonlyPermissions, ...changed },
        "okou_readonly_access",
        false,
      ),
    /ProductionRolePrivilegesRejected/u,
  );
const host = "ep-production.us-west-2.aws.neon.tech";
const scope = {
  database: `${host}:5432/neondb`,
  bucket: BUCKET,
  endpoint: ENDPOINT,
};
const source = {
  ownerKind: "user-template",
  templateId: "11111111-1111-4111-8111-111111111111",
  orgId: "fixture",
  ownerUserId: "fixture-user",
  ownerUpdatedAt: "2026-11-09T00:00:00.000Z",
  package: {
    storageId: "22222222-2222-4222-8222-222222222222",
    versionId: "b".repeat(64),
    s3Key: `fixture/22222222-2222-4222-8222-222222222222/${"b".repeat(64)}`,
    archiveBytes: 100,
    totalBytes: 20,
    fileCount: 1,
  },
};
const inventory = inventorySchema.parse({
  format: "template-guidance-sources-v1",
  capturedAt: source.ownerUpdatedAt,
  scope,
  rows: [source],
});
const owner = {
  revision: "10",
  fingerprint: "f".repeat(32),
  orgId: "fixture",
  ownerUserId: "fixture-user",
  updatedAt: "2026-11-09 00:00:00",
  bundle: null,
};
const bundle = { sha256: "c".repeat(64), archiveBytes: 80 };
const plan = planSchema.parse({
  format: "template-guidance-backfill-v1",
  capturedAt: source.ownerUpdatedAt,
  scope,
  inventorySha256: "d".repeat(64),
  complete: true,
  rows: [
    {
      source,
      owner,
      archiveSha256: "e".repeat(64),
      manifestSha256: "f".repeat(64),
      bundle,
    },
  ],
  failures: [],
});
const meta = metadataSchema.parse({
  format: "template-guidance-production-plan-v1",
  commit: context.commit,
  runId: context.planRunId,
  runAttempt: 1,
  actor: "fixture",
  createdAt: source.ownerUpdatedAt,
  project: PROJECT,
  branch: BRANCH,
  endpointId: "ep-production",
  planSha256: context.planSha256,
  inventorySha256: plan.inventorySha256,
});
const row = censusRowSchema.parse({
  ...owner,
  id: source.templateId,
  ownerKind: source.ownerKind,
});

for (const changed of [
  { runAttempt: 2 },
  { writersDrained: false },
  { planRunId: "200" },
  { planSha256: "invalid" },
])
  assert.throws(() => {
    return validateApply({ ...context, ...changed });
  }, /ReviewedFirstAttemptApplyRequired/u);
assert.throws(() => {
  return contextSchema.parse({ ...context, ref: "refs/heads/untrusted" });
});
assert.throws(() => {
  return contextSchema.parse({ ...context, repository: "untrusted/repo" });
});

function neonPeer(
  change:
    | "none"
    | "unprotected"
    | "foreign-uri"
    | "multiple"
    | "query-override" = "none",
): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://console.neon.tech");
    const base = `/api/v2/projects/${PROJECT}`;
    if (url.pathname === `${base}/branches/${BRANCH}`)
      return Response.json({
        branch: {
          id: BRANCH,
          default: true,
          protected: change !== "unprotected",
          current_state: "ready",
        },
      });
    if (url.pathname === `${base}/endpoints`)
      return Response.json({
        endpoints: Array.from(
          { length: change === "multiple" ? 2 : 1 },
          (_, i) => {
            return {
              id: `ep-production${i || ""}`,
              branch_id: BRANCH,
              type: "read_write",
              host,
            };
          },
        ),
      });
    assert.equal(url.pathname, `${base}/connection_uri`);
    assert.equal(url.searchParams.get("branch_id"), BRANCH);
    assert.equal(url.searchParams.get("endpoint_id"), "ep-production");
    assert.equal(url.searchParams.get("database_name"), "neondb");
    assert.equal(url.searchParams.get("pooled"), "false");
    const role = url.searchParams.get("role_name");
    return Response.json({
      uri: `postgresql://${role}:fixture-password@${change === "foreign-uri" ? "ep-untrusted.neon.tech" : host}/neondb?sslmode=require${change === "query-override" ? "&host=untrusted" : ""}`,
    });
  };
}
for (const mode of ["plan-guidance", "apply-guidance"] as const) {
  const target = await resolveTarget(mode, "fixture", neonPeer());
  assert.deepEqual(target.scope, scope);
  assert.equal(
    new URL(target.connection).searchParams.get("sslmode"),
    "verify-full",
  );
  assert.equal(
    target.role,
    mode === "plan-guidance" ? "okou_readonly_access" : "neondb_owner",
  );
}
for (const changed of [
  "unprotected",
  "foreign-uri",
  "multiple",
  "query-override",
] as const)
  await assert.rejects(
    resolveTarget("apply-guidance", "fixture", neonPeer(changed)),
  );

const run = {
  id: 100,
  head_sha: context.commit,
  head_branch: "main",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
  run_attempt: 1,
  path: ".github/workflows/copy-presentation-templates.yml",
  display_title: "plan-guidance production presentation templates by @fixture",
};
const githubPeer = (changes: object): typeof fetch => {
  return async (input) => {
    assert.equal(
      String(input),
      "https://api.github.com/repos/okou-ai/okou/actions/runs/100",
    );
    return Response.json({ ...run, ...changes });
  };
};
assert.deepEqual(await verifyPlanOrigin(context, "fixture", githubPeer({})), {
  runAttempt: 1,
  artifactName: "template-guidance-plan-100-1",
});
for (const changed of [
  { head_sha: "b".repeat(40) },
  { head_branch: "feature" },
  { conclusion: "failure" },
  { status: "in_progress" },
  { event: "pull_request" },
  { path: "different.yml" },
  { display_title: "apply-guidance production" },
])
  await assert.rejects(
    verifyPlanOrigin(context, "fixture", githubPeer(changed)),
    /PlanRunProvenanceRejected/u,
  );

validateCensus([row], inventory.rows, plan.rows);
validateCensus([{ ...row, bundle, revision: "11" }], inventory.rows, plan.rows);
for (const changed of [
  { fingerprint: "0".repeat(32) },
  { revision: "11" },
  { orgId: "foreign" },
  { bundle: { ...bundle, sha256: "0".repeat(64) } },
])
  assert.throws(() => {
    return validateCensus([{ ...row, ...changed }], inventory.rows, plan.rows);
  });
assert.throws(() => {
  return validateCensus([], inventory.rows, plan.rows);
}, /ProductionOwnerScopeChanged/u);
assert.throws(() => {
  return validateCensus(
    [row, { ...row, id: "33333333-3333-4333-8333-333333333333" }],
    inventory.rows,
    plan.rows,
  );
}, /IncompleteNullOwnerInventory/u);
verifyReviewedPlan(
  context,
  meta,
  plan,
  inventory,
  context.planSha256,
  plan.inventorySha256,
  1,
);
for (const changed of [
  { commit: "b".repeat(40) },
  { runId: "untrusted" },
  { runAttempt: 2 },
  { planSha256: "b".repeat(64) },
  { inventorySha256: "b".repeat(64) },
])
  assert.throws(() => {
    return verifyReviewedPlan(
      context,
      { ...meta, ...changed },
      plan,
      inventory,
      context.planSha256,
      plan.inventorySha256,
      1,
    );
  }, /ReviewedProductionPlanRejected/u);
assert.throws(() => {
  return verifyReviewedPlan(
    context,
    meta,
    { ...plan, complete: false },
    inventory,
    context.planSha256,
    plan.inventorySha256,
    1,
  );
}, /ReviewedProductionPlanRejected/u);
assert.throws(() => {
  return verifyReviewedPlan(
    context,
    meta,
    plan,
    inventory,
    "b".repeat(64),
    plan.inventorySha256,
    1,
  );
}, /ReviewedProductionPlanRejected/u);
console.log(
  "PASS: production target/TLS, main run provenance, exact reviewed hashes, first-attempt apply, complete owner census, conflicts and identical publication reconciliation",
);
