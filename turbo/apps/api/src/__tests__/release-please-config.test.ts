import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type VersionedPackageJson = PackageJson & {
  version: string;
};

type ReleasePleaseConfig = {
  packages: Record<string, unknown>;
};

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")) as T;
}

function readText(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function apiRuntimeWorkspaceDependencyPaths(): string[] {
  const apiPackage = readJson<PackageJson>("turbo/apps/api/package.json");

  return Object.entries(apiPackage.dependencies ?? {})
    .filter(([name, specifier]) => {
      return name.startsWith("@okouai/") && specifier === "workspace:*";
    })
    .map(([name]) => {
      return `turbo/packages/${name.replace("@okouai/", "")}`;
    });
}

function releaseManagedWorkspaceDependencyPaths(
  packageJson: PackageJson,
  releaseConfig: ReleasePleaseConfig,
): string[] {
  return Object.entries({
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.optionalDependencies,
  })
    .filter(([name, specifier]) => {
      return name.startsWith("@okouai/") && specifier.startsWith("workspace:");
    })
    .map(([name]) => {
      return `turbo/packages/${name.replace("@okouai/", "")}`;
    })
    .filter((packagePath) => {
      return Object.hasOwn(releaseConfig.packages, packagePath);
    });
}

function workflowJobBlock(workflow: string, jobName: string): string {
  const jobStart = workflow.indexOf(`  ${jobName}:\n`);
  if (jobStart === -1) {
    throw new Error(`Missing workflow job: ${jobName}`);
  }

  const afterJobStart = workflow.slice(jobStart + `  ${jobName}:\n`.length);
  const nextJobOffset = afterJobStart.search(/\n {2}[a-zA-Z0-9_-]+:\n/);

  if (nextJobOffset === -1) {
    return workflow.slice(jobStart);
  }

  return workflow.slice(
    jobStart,
    jobStart + `  ${jobName}:\n`.length + nextJobOffset,
  );
}

describe("release-please API deployment graph", () => {
  it("keeps every release package in the manifest", () => {
    const releaseConfig = readJson<ReleasePleaseConfig>(
      "release-please-config.json",
    );
    const manifest = readJson<Record<string, string>>(
      ".release-please-manifest.json",
    );

    for (const packagePath of Object.keys(releaseConfig.packages)) {
      expect(manifest).toHaveProperty(packagePath);
    }
  });

  it("keeps CLI build identity release-managed", () => {
    const releaseConfig = readJson<ReleasePleaseConfig>(
      "release-please-config.json",
    );
    const manifest = readJson<Record<string, string>>(
      ".release-please-manifest.json",
    );
    const cliPackage = readJson<VersionedPackageJson>(
      "turbo/apps/cli/package.json",
    );

    expect(releaseConfig.packages["turbo/apps/cli"]).toStrictEqual({
      "release-type": "node",
      component: "cli",
    });
    expect(manifest["turbo/apps/cli"]).toBe(cliPackage.version);
  });

  it("release-manages the standalone App Worker deployment source", () => {
    const releaseConfig = readJson<ReleasePleaseConfig>(
      "release-please-config.json",
    );
    const manifest = readJson<Record<string, string>>(
      ".release-please-manifest.json",
    );
    const exclusions = readJson<Record<string, string>>(
      ".github/release-please-workspace-exclusions.json",
    );
    const appWorkerPackage = readJson<VersionedPackageJson>(
      "turbo/apps/app-worker/package.json",
    );
    const releaseWorkflow = readText(".github/workflows/release-please.yml");
    const releaseJob = workflowJobBlock(releaseWorkflow, "release-please");
    const promoteAppWorkerProductionJob = workflowJobBlock(
      releaseWorkflow,
      "promote-app-worker-production",
    );
    const updateRollbackDashboardJob = workflowJobBlock(
      releaseWorkflow,
      "update-rollback-dashboard",
    );
    const githubExpressionStart = String.fromCodePoint(36, 123, 123);

    expect(releaseConfig.packages["turbo/apps/app-worker"]).toStrictEqual({
      "release-type": "node",
    });
    expect(manifest["turbo/apps/app-worker"]).toBe(appWorkerPackage.version);
    expect(exclusions).not.toHaveProperty("turbo/apps/app-worker");
    expect(releaseJob).toContain(
      `app_worker_release_created: ${githubExpressionStart} steps.release.outputs['turbo/apps/app-worker--release_created'] }}`,
    );
    expect(releaseJob).toContain(
      `app_worker_version: ${githubExpressionStart} steps.release.outputs['turbo/apps/app-worker--version'] }}`,
    );
    expect(releaseJob).toContain(
      `app_deploy_required: ${githubExpressionStart} steps.app-release.outputs.required }}`,
    );
    expect(releaseJob).toContain(
      "steps.release.outputs['turbo/apps/app-worker--sha']",
    );
    expect(releaseJob).toContain(
      "steps.release.outputs['turbo/apps/app-worker--tag_name']",
    );
    expect(promoteAppWorkerProductionJob).toContain(
      "needs.release-please.outputs.app_deploy_required == 'true'",
    );
    expect(promoteAppWorkerProductionJob).not.toContain("continue-on-error");
    expect(promoteAppWorkerProductionJob).toContain(
      "needs: [release-please, builds-complete, promote-api-production]",
    );
    expect(promoteAppWorkerProductionJob).toContain(
      "needs.builds-complete.result == 'success'",
    );
    expect(promoteAppWorkerProductionJob).toContain(
      "needs.promote-api-production.result == 'success'",
    );
    expect(promoteAppWorkerProductionJob).toContain("app.okou.ai");
    expect(updateRollbackDashboardJob).toContain(
      "needs.release-please.outputs.app_deploy_required != 'true'",
    );
    expect(updateRollbackDashboardJob).toContain(
      "promote-app-worker-production",
    );
    expect(updateRollbackDashboardJob).toContain(
      "needs.promote-app-worker-production.result == 'success'",
    );
  });

  it("uses the release-managed connectors version as catalog validator identity", () => {
    const releaseConfig = readJson<ReleasePleaseConfig>(
      "release-please-config.json",
    );
    const manifest = readJson<Record<string, string>>(
      ".release-please-manifest.json",
    );
    const connectorsPackage = readJson<VersionedPackageJson>(
      "turbo/packages/connectors/package.json",
    );
    const releaseWorkflow = readText(".github/workflows/release-please.yml");

    expect(releaseConfig.packages["turbo/packages/connectors"]).toStrictEqual({
      "release-type": "node",
      "skip-changelog": true,
    });
    expect(manifest["turbo/packages/connectors"]).toBe(
      connectorsPackage.version,
    );
    expect(
      releaseManagedWorkspaceDependencyPaths(connectorsPackage, releaseConfig),
    ).toStrictEqual([]);
    expect(releaseConfig.packages).not.toHaveProperty(
      "turbo/packages/connector-catalog-validation",
    );
    expect(manifest).not.toHaveProperty(
      "turbo/packages/connector-catalog-validation",
    );
    expect(releaseWorkflow).not.toContain("connector-catalog-validation");
  });

  it("tracks every API runtime workspace dependency", () => {
    const releaseConfig = readJson<ReleasePleaseConfig>(
      "release-please-config.json",
    );
    const manifest = readJson<Record<string, string>>(
      ".release-please-manifest.json",
    );

    for (const packagePath of apiRuntimeWorkspaceDependencyPaths()) {
      expect(releaseConfig.packages).toHaveProperty(packagePath);
      expect(manifest).toHaveProperty(packagePath);
    }
  });

  it("builds and deploys API for every release", () => {
    const workflow = readText(".github/workflows/release-please.yml");
    const promoteApiProductionJob = workflowJobBlock(
      workflow,
      "promote-api-production",
    );
    const promoteApiProductionHeader = promoteApiProductionJob.slice(
      0,
      promoteApiProductionJob.indexOf("    steps:\n"),
    );

    expect(promoteApiProductionHeader).toContain(
      "needs: [release-please, builds-complete]",
    );
    expect(promoteApiProductionJob).toContain("always() &&");
    expect(promoteApiProductionJob).toContain(
      "needs.release-please.outputs.releases_created == 'true'",
    );
    expect(promoteApiProductionJob).not.toContain("api_deploy_required");
    expect(promoteApiProductionHeader).not.toContain("api_release_created");

    const deployApiSchemaJob = workflowJobBlock(workflow, "deploy-api-schema");
    expect(deployApiSchemaJob).toContain(
      "needs: [release-please, promote-api-production]",
    );
  });

  it("builds the API before migrations and deploys it afterward", () => {
    const workflow = readText(".github/workflows/release-please.yml");
    const promoteApiProductionJob = workflowJobBlock(
      workflow,
      "promote-api-production",
    );
    const buildStep = promoteApiProductionJob.indexOf(
      "- name: Build API Production Artifact",
    );
    const productionEnvironmentStep = promoteApiProductionJob.indexOf(
      "- name: Resolve API production environment",
    );
    const schemaUploadStep = promoteApiProductionJob.indexOf(
      "- name: Upload Runtime API Schema Artifact",
    );
    const buildStepEnd = promoteApiProductionJob.indexOf(
      "- name: Install neonctl",
    );
    const migrationSmokeStep = promoteApiProductionJob.indexOf(
      "- name: Run Production Migration Smoke Test",
    );
    const migrationStep = promoteApiProductionJob.indexOf(
      "- name: Run Production Migrations",
    );
    const deploymentToolchainStep = promoteApiProductionJob.indexOf(
      "- name: Initialize API deployment toolchain",
    );
    const deploymentStep = promoteApiProductionJob.indexOf(
      "- name: Deploy API Production",
    );

    expect(promoteApiProductionJob).toContain(
      "needs.release-please.outputs.api_release_created == 'true'",
    );
    expect(
      promoteApiProductionJob.match(/\.\/\.github\/actions\/toolchain-init/g),
    ).toHaveLength(1);
    expect(
      promoteApiProductionJob.match(/\.\/\.github\/actions\/vercel-setup/g),
    ).toHaveLength(1);
    expect(
      promoteApiProductionJob.match(/\.\/\.github\/actions\/vercel-deploy/g),
    ).toHaveLength(1);
    expect(
      promoteApiProductionJob.match(/pnpm --dir turbo\/apps\/api build/g),
    ).toHaveLength(1);
    expect(schemaUploadStep).toBeGreaterThan(-1);
    expect(buildStep).toBeGreaterThan(-1);
    expect(buildStep).toBeGreaterThan(schemaUploadStep);
    expect(
      promoteApiProductionJob.slice(schemaUploadStep, buildStep),
    ).toContain("overwrite: true");
    expect(buildStepEnd).toBeGreaterThan(buildStep);
    expect(
      promoteApiProductionJob.slice(buildStep, buildStepEnd),
    ).not.toContain("secrets.");
    expect(deploymentToolchainStep).toBeGreaterThan(-1);
    expect(productionEnvironmentStep).toBeGreaterThan(buildStep);
    expect(deploymentToolchainStep).toBeGreaterThan(buildStep);
    expect(migrationSmokeStep).toBeGreaterThan(buildStep);
    expect(migrationStep).toBeGreaterThan(-1);
    expect(migrationStep).toBeGreaterThan(deploymentToolchainStep);
    expect(migrationStep).toBeGreaterThan(migrationSmokeStep);
    expect(deploymentStep).toBeGreaterThan(migrationStep);
    expect(promoteApiProductionJob).toContain('prebuilt: "true"');
    expect(promoteApiProductionJob).toContain('skip-setup: "true"');
  });

  it("reconciles the connector catalog immediately after API deployment", () => {
    const workflow = readText(".github/workflows/release-please.yml");
    const promoteApiProductionJob = workflowJobBlock(
      workflow,
      "promote-api-production",
    );
    const deployStep = promoteApiProductionJob.indexOf(
      "- name: Deploy API Production",
    );
    const reconcileStep = promoteApiProductionJob.indexOf(
      "- name: Reconcile production connector catalog (best effort)",
    );
    const finishStep = promoteApiProductionJob.indexOf(
      "- name: Finish GitHub Deployment",
    );

    expect(deployStep).toBeGreaterThan(-1);
    expect(reconcileStep).toBeGreaterThan(deployStep);
    expect(finishStep).toBeGreaterThan(reconcileStep);
    expect(promoteApiProductionJob).not.toContain(
      "- name: Verify production App and API domains",
    );
    expect(promoteApiProductionJob).not.toContain(
      "- name: Check staged API health",
    );
    expect(promoteApiProductionJob).not.toContain(
      "- name: Promote API Production",
    );

    const deployBlock = promoteApiProductionJob.slice(
      deployStep,
      reconcileStep,
    );
    expect(deployBlock).not.toContain('skip-domain: "true"');
    expect(deployBlock.match(/- name:/g)).toHaveLength(1);
    expect(promoteApiProductionJob).not.toContain(
      "uses: ./.github/actions/vercel-promote",
    );

    const reconcileBlock = promoteApiProductionJob.slice(
      reconcileStep,
      finishStep,
    );
    expect(reconcileBlock).toContain("shell: bash");
    expect(reconcileBlock).toContain(
      `API_DEPLOYMENT_URL: \${{ steps.deploy.outputs.url }}`,
    );
    expect(reconcileBlock).toContain(
      "vercel curl /api/cron/sync-connector-catalog",
    );
    expect(reconcileBlock).toContain('--deployment "$API_DEPLOYMENT_URL"');
    expect(reconcileBlock).toContain(
      `--header "Authorization: Bearer \${CRON_SECRET}"`,
    );
    expect(reconcileBlock).not.toContain("for attempt in");
    expect(reconcileBlock).not.toContain("sleep ");
    expect(reconcileBlock).not.toContain("exit 1");
    expect(reconcileBlock).toContain("::warning::");
    expect(reconcileBlock).toContain("the scheduled cron will retry");
    expect(reconcileBlock).toContain("--max-time 120");
    expect(reconcileBlock).toContain("hasActive: (.active != null)");
    expect(reconcileBlock).toContain(
      "lastAttemptOutcome: .lastAttempt.outcome",
    );
    expect(reconcileBlock).toContain("stale: .filtering.stale");
    expect(reconcileBlock).toContain(
      "filteredAuthMethodCount: (.filtering.filteredAuthMethods | length)",
    );
    expect(reconcileBlock).not.toContain("capabilityDigest:");
    expect(reconcileBlock).not.toContain("catalogVersion:");
    expect(reconcileBlock).not.toContain("catalogDigest:");
    expect(reconcileBlock).toContain('.state == "current"');
    expect(reconcileBlock).toContain(".active != null");
    expect(reconcileBlock).toContain(".filtering.stale == false");
  });

  it("keeps Vercel setup enabled for other deployment callers", () => {
    const action = readText(".github/actions/vercel-deploy/action.yml");
    const skipSetupInputStart = action.indexOf("  skip-setup:\n");
    const runsStart = action.indexOf("\nruns:\n");

    expect(skipSetupInputStart).toBeGreaterThan(-1);
    expect(runsStart).toBeGreaterThan(skipSetupInputStart);
    expect(action.slice(skipSetupInputStart, runsStart)).toContain(
      'default: "false"',
    );
    expect(action).toContain(`if: \${{ inputs.skip-setup != 'true' }}`);
  });

  it("keeps Vercel setup enabled for other promotion callers", () => {
    const action = readText(".github/actions/vercel-promote/action.yml");
    const skipSetupInputStart = action.indexOf("  skip-setup:\n");
    const outputsStart = action.indexOf("\noutputs:\n");

    expect(skipSetupInputStart).toBeGreaterThan(-1);
    expect(outputsStart).toBeGreaterThan(skipSetupInputStart);
    expect(action.slice(skipSetupInputStart, outputsStart)).toContain(
      'default: "false"',
    );
    expect(action).toContain(`if: \${{ inputs.skip-setup != 'true' }}`);
  });

  it("promotes App after the API production lifecycle", () => {
    const workflow = readText(".github/workflows/release-please.yml");
    const promoteAppWorkerProductionJob = workflowJobBlock(
      workflow,
      "promote-app-worker-production",
    );

    expect(promoteAppWorkerProductionJob).toContain(
      "needs: [release-please, builds-complete, promote-api-production]",
    );
    expect(promoteAppWorkerProductionJob).toContain(
      "needs.promote-api-production.result == 'success'",
    );
  });
});
