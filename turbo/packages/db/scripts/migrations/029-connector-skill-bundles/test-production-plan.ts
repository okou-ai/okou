import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256 } from "./command";
import {
  productionBucket,
  productionEndpoint,
  productionTargets,
  productionWorkflow,
  reviewedPlanRun,
  reviewedProductionPlan,
} from "./production-plan";

const scope = {
  database: "verified-production-endpoint:5432/neondb",
  bucket: productionBucket,
  endpoint: productionEndpoint,
};
const plan = {
  format: "connector-skill-backfill-v1",
  mode: "read-only",
  capturedAt: new Date().toISOString(),
  scope,
  complete: true,
  failures: [],
  rows: productionTargets.map((target) => {
    return {
      source: {
        ...target,
        ownerXmin: "1",
        storageXmin: "2",
        versionXmin: "3",
        s3Key: "fixture/" + target.sourceVersionId,
        archiveBytes: 100,
        contentBytes: 50,
        fileCount: 1,
        bundle: null,
        bundleSource: null,
      },
      target: { sha256: "a".repeat(64), archiveBytes: 100 },
    };
  }),
};
function inspect(value: object, hash?: string) {
  const bytes = Buffer.from(JSON.stringify(value));
  return reviewedProductionPlan(bytes, hash ?? sha256(bytes), scope);
}

await test("the reviewed plan admits exactly the approved production owners", () => {
  assert.equal(inspect(plan).rows.length, 3);
  assert.throws(() => {
    return inspect(plan, "0".repeat(64));
  }, /HashMismatch/u);
  assert.throws(() => {
    return inspect({ ...plan, complete: false });
  }, /ScopeMismatch/u);
  assert.throws(() => {
    return inspect({ ...plan, rows: [...plan.rows, plan.rows[0]] });
  }, /ScopeMismatch/u);
  for (const field of [
    "connectorId",
    "orgId",
    "storageId",
    "sourceVersionId",
  ] as const) {
    const rows = plan.rows.map((row, index) => {
      return index === 0
        ? {
            ...row,
            source: { ...row.source, [field]: plan.rows[1]!.source[field] },
          }
        : row;
    });
    assert.throws(() => {
      return inspect({ ...plan, rows });
    }, /TargetMismatch/u);
  }
});

await test("a valid plan for another database or object store is not production approval", () => {
  for (const field of ["database", "bucket", "endpoint"] as const) {
    assert.throws(() => {
      return inspect({
        ...plan,
        scope: { ...scope, [field]: "another-scope" },
      });
    }, /ScopeMismatch/u);
  }
});

await test("apply requires a successful unreplayed main-branch plan from the same commit", () => {
  const commit = "a".repeat(40);
  const run = {
    id: 123,
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: commit,
    path: productionWorkflow,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
  };
  assert.equal(reviewedPlanRun(run, 123, commit).id, 123);
  for (const replacement of [
    { head_branch: "unreviewed" },
    { head_sha: "b".repeat(40) },
    { path: ".github/workflows/another-workflow.yml" },
    { conclusion: "failure" },
    { run_attempt: 2 },
  ])
    assert.throws(() => {
      return reviewedPlanRun({ ...run, ...replacement }, 123, commit);
    });
});

await test("the production command rejects unsafe dispatches and removes its private directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "connector-production-gate-"));
  try {
    for (const rejected of [
      { GITHUB_REF: "refs/heads/unreviewed" },
      { GITHUB_REPOSITORY: "another/repository" },
      { GITHUB_RUN_ATTEMPT: "2" },
      { BACKFILL_MODE: "copy" },
    ]) {
      const privateDirectory = join(root, "private");
      await mkdir(privateDirectory);
      await writeFile(join(privateDirectory, "fixture"), "private fixture");
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/migrations/029-connector-skill-bundles/production.ts",
        ],
        {
          env: {
            PATH: process.env.PATH,
            CREDENTIAL_DIRECTORY: privateDirectory,
            RECEIPTS_DIRECTORY: join(root, "receipts"),
            BACKFILL_MODE: "apply",
            GITHUB_REF: "refs/heads/main",
            GITHUB_REPOSITORY: "okou-ai/okou",
            GITHUB_RUN_ATTEMPT: "1",
            ...rejected,
          },
          timeout: 10_000,
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /stopped at dispatch/u);
      await assert.rejects(access(privateDirectory));
      await assert.rejects(access(join(root, "receipts")));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
