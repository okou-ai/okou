import { appendFile } from "node:fs/promises";

import {
  cleanupCurrentClerkTestGeneration,
  cleanupCurrentClerkTestRun,
  cleanupRecordedClerkTestResources,
  createUser,
  prepareOrganizationProvisioner,
  runnerTestAccounts,
  type ClerkTestRole,
  type RunnerTestAccounts,
} from "./lib/clerk-api";

// Retained workflow attempts can still own roles no longer provisioned here.
const RUNNER_CLEANUP_ROLES = [
  "runner",
  "runner-real-codex",
  "runner-real-claude",
  "runner-mock-claude",
  "runner-real-codex-built-in",
] as const satisfies readonly ClerkTestRole[];

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "prepare":
      await prepareRunnerAccounts(
        runnerTestAccounts(),
        requiredEnvironmentVariable("JOB_REF"),
      );
      break;
    case "cleanup-generation":
      await cleanupRunnerAccountGeneration();
      break;
    case "cleanup-run":
      await cleanupRunnerAccountRun();
      break;
    case "cleanup-recorded-generation":
    case "cleanup-recorded-run":
      requiredEnvironmentVariable("JOB_REF");
      await cleanupRecordedClerkTestResources(
        RUNNER_CLEANUP_ROLES,
        command === "cleanup-recorded-run" ? "run" : "generation",
      );
      break;
    default:
      throw new Error(
        "Usage: runner-account.ts <prepare|cleanup-generation|cleanup-run|cleanup-recorded-generation|cleanup-recorded-run>",
      );
  }
}

async function prepareRunnerAccounts(
  runnerAccounts: RunnerTestAccounts,
  jobRef: string,
): Promise<void> {
  try {
    const createOrganization = await prepareOrganizationProvisioner();
    const codexUserId = await createUser(runnerAccounts.codex);
    const codexOrganizationId = await createOrganization(
      `e2e-runner-real-codex-${jobRef}`,
      codexUserId,
      "runner-real-codex",
    );
    const mockClaudeUserId = await createUser(runnerAccounts.mockClaude);
    const mockClaudeOrganizationId = await createOrganization(
      `e2e-runner-mock-claude-${jobRef}`,
      mockClaudeUserId,
      "runner-mock-claude",
    );
    const codexBuiltInUserId = await createUser(runnerAccounts.codexBuiltIn);
    const codexBuiltInOrganizationId = await createOrganization(
      `e2e-runner-real-codex-built-in-${jobRef}`,
      codexBuiltInUserId,
      "runner-real-codex-built-in",
    );

    await appendFile(
      requiredEnvironmentVariable("GITHUB_OUTPUT"),
      [
        `codex-organization-id=${codexOrganizationId}`,
        `mock-claude-organization-id=${mockClaudeOrganizationId}`,
        `codex-built-in-organization-id=${codexBuiltInOrganizationId}`,
        `codex-email=${runnerAccounts.codex}`,
        `mock-claude-email=${runnerAccounts.mockClaude}`,
        `codex-built-in-email=${runnerAccounts.codexBuiltIn}`,
        "",
      ].join("\n"),
      "utf8",
    );

    console.log("Prepared runner E2E accounts", {
      codexOrganizationId,
      mockClaudeOrganizationId,
      codexBuiltInOrganizationId,
      ...runnerAccounts,
    });
  } catch (cause) {
    try {
      await cleanupRecordedClerkTestResources(RUNNER_CLEANUP_ROLES);
    } catch (cleanupCause) {
      console.error(
        "Recorded runner cleanup failed; deferring to the stale sweep",
        cleanupCause,
      );
    }
    throw cause;
  }
}

async function cleanupRunnerAccountGeneration(): Promise<void> {
  requiredEnvironmentVariable("JOB_REF");
  const result = await cleanupCurrentClerkTestGeneration(RUNNER_CLEANUP_ROLES);
  console.log("Cleaned up runner E2E account generation", result);
}

async function cleanupRunnerAccountRun(): Promise<void> {
  requiredEnvironmentVariable("JOB_REF");
  const result = await cleanupCurrentClerkTestRun(RUNNER_CLEANUP_ROLES);
  console.log("Cleaned up runner E2E workflow run", result);
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
