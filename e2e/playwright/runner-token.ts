import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { chromium, expect, type Browser, type Page } from "@playwright/test";

import { resolveApiBackendUrl } from "./api-backend-url";
import { refreshClerkSessionToken, signInWithClerkEmailCode } from "./lib/auth";
import { issueCliToken } from "./lib/cli-token";
import { runnerTestAccounts } from "./lib/clerk-api";
import { formatErrorReport } from "./lib/error-report";
import { captureClerkReadiness } from "./lib/clerk-readiness";
import { ensureRunnerOrganizationReady } from "./lib/onboarding";
import {
  completeRunnerOnboarding,
  createRunnerCheckout,
  readRunnerPaidEntitlement,
} from "./lib/runner-onboarding";
import { seedPreviewBypassCookie } from "./lib/preview-bypass";
import {
  collectStripeCheckoutState,
  fillStripeCheckout,
} from "./lib/stripe-checkout";

const RUNNER_CREDENTIAL_CONCURRENCY = 2;

interface RunnerCredentialTarget {
  readonly email: string;
  readonly fileName: string;
  readonly organizationId: string;
  readonly upgradeToPro: boolean;
}

interface ProvisionRunnerCredentialOptions {
  readonly apiUrl: string;
  readonly appUrl: string;
  readonly browser: Browser;
  readonly outputDirectory: string;
  readonly target: RunnerCredentialTarget;
  readonly vercelAutomationBypassSecret?: string;
}

async function main(): Promise<void> {
  requiredEnvironmentVariable("JOB_REF");
  const apiUrl = resolveApiBackendUrl();
  const appUrl = requiredEnvironmentVariable("OKOU_APP_URL");
  const outputDirectory = process.argv[2];
  if (!outputDirectory) {
    throw new Error("Usage: runner-token.ts <output-directory>");
  }

  const accounts = runnerTestAccounts();
  const targets: readonly RunnerCredentialTarget[] = [
    {
      email: accounts.runner,
      fileName: "e2e-api-credentials-runner.json",
      organizationId: requiredEnvironmentVariable("E2E_RUNNER_ORGANIZATION_ID"),
      upgradeToPro: false,
    },
    {
      email: accounts.codex,
      fileName: "e2e-api-credentials-runner-real-codex.json",
      organizationId: requiredEnvironmentVariable(
        "E2E_RUNNER_CODEX_ORGANIZATION_ID",
      ),
      upgradeToPro: true,
    },
    {
      email: accounts.claude,
      fileName: "e2e-api-credentials-runner-real-claude.json",
      organizationId: requiredEnvironmentVariable(
        "E2E_RUNNER_CLAUDE_ORGANIZATION_ID",
      ),
      upgradeToPro: true,
    },
    {
      email: accounts.mockClaude,
      fileName: "e2e-api-credentials-runner-mock-claude.json",
      organizationId: requiredEnvironmentVariable(
        "E2E_RUNNER_MOCK_CLAUDE_ORGANIZATION_ID",
      ),
      upgradeToPro: true,
    },
    {
      email: accounts.codexBuiltIn,
      fileName: "e2e-api-credentials-runner-real-codex-built-in.json",
      organizationId: requiredEnvironmentVariable(
        "E2E_RUNNER_CODEX_BUILT_IN_ORGANIZATION_ID",
      ),
      upgradeToPro: true,
    },
  ];
  const vercelAutomationBypassSecret =
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  await mkdir(outputDirectory, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (
      let batchStart = 0;
      batchStart < targets.length;
      batchStart += RUNNER_CREDENTIAL_CONCURRENCY
    ) {
      const batch = targets.slice(
        batchStart,
        batchStart + RUNNER_CREDENTIAL_CONCURRENCY,
      );
      const results = await Promise.allSettled(
        batch.map((target) =>
          provisionRunnerCredential({
            apiUrl,
            appUrl,
            browser,
            outputDirectory,
            target,
            vercelAutomationBypassSecret,
          }),
        ),
      );
      const failures = results.flatMap((result, index) => {
        if (result.status === "fulfilled") {
          return [];
        }
        const target = batch[index];
        return [
          new Error(
            `Failed to provision runner E2E credential for ${target.email} (${target.fileName})`,
            { cause: result.reason },
          ),
        ];
      });
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          failures.map((failure) => failure.message).join("; "),
        );
      }
    }
  } finally {
    await browser.close();
  }
}

async function provisionRunnerCredential(
  options: ProvisionRunnerCredentialOptions,
): Promise<void> {
  const {
    apiUrl,
    appUrl,
    browser,
    outputDirectory,
    target,
    vercelAutomationBypassSecret,
  } = options;
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  try {
    await seedPreviewBypassCookie(
      context,
      appUrl,
      vercelAutomationBypassSecret,
    );
    const page = await context.newPage();
    let clerkSessionToken = await signInWithClerkEmailCode(
      page,
      target.email,
      appUrl,
      { activeOrganizationId: target.organizationId },
    );
    await ensureRunnerOrganizationReady({
      apiUrl,
      clerkSessionToken,
      vercelAutomationBypassSecret,
    });
    await completeRunnerOnboarding({
      apiUrl,
      clerkSessionToken,
      vercelAutomationBypassSecret,
    });
    if (target.upgradeToPro) {
      clerkSessionToken = await preparePaidRunner(
        page,
        options,
        clerkSessionToken,
      );
    }
    const token = await issueCliToken({
      apiUrl,
      clerkSessionToken,
      vercelAutomationBypassSecret,
    });
    const outputFile = join(outputDirectory, target.fileName);
    await writeFile(
      outputFile,
      `${JSON.stringify({ token, apiUrl }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    console.log("Generated runner E2E API credential", {
      email: target.email,
      outputFile,
    });
  } finally {
    await context.close();
  }
}

async function preparePaidRunner(
  page: Page,
  options: ProvisionRunnerCredentialOptions,
  clerkSessionToken: string,
): Promise<string> {
  const {
    apiUrl,
    appUrl,
    target,
    outputDirectory,
    vercelAutomationBypassSecret,
  } = options;
  try {
    const memberId = await page.evaluate(() => window.Clerk?.user?.id);
    if (!memberId) {
      throw new Error("Runner checkout requires the signed-in Clerk user");
    }
    const checkoutUrl = await createRunnerCheckout({
      apiUrl,
      appUrl,
      memberId,
      clerkSessionToken,
      vercelAutomationBypassSecret,
    });
    await page.goto(checkoutUrl, { waitUntil: "domcontentloaded" });
    await fillStripeCheckout(page);
    await page.waitForURL((url) => url.origin === new URL(appUrl).origin, {
      timeout: 180_000,
      waitUntil: "domcontentloaded",
    });
    let verifiedToken = await refreshClerkSessionToken(page, {
      activeOrganizationId: target.organizationId,
    });
    // Observe the public entitlement after Stripe/webhook settlement before
    // exposing credentials to shards that require paid models and BYOK.
    await expect
      .poll(
        async () => {
          const token = await page.evaluate(
            async () => await window.Clerk?.session?.getToken(),
          );
          if (!token) {
            throw new Error(
              "Clerk session unavailable while verifying runner entitlement",
            );
          }
          verifiedToken = token;
          return await readRunnerPaidEntitlement({
            apiUrl,
            clerkSessionToken: token,
            vercelAutomationBypassSecret,
          });
        },
        { timeout: 60_000, message: "Runner Pro entitlement must be active" },
      )
      .toBe(true);
    return verifiedToken;
  } catch (error: unknown) {
    try {
      await capturePaidOnboardingFailure(page, target, outputDirectory);
    } catch (diagnosticError: unknown) {
      console.error("Unable to capture paid onboarding diagnostics", {
        diagnosticErrorType:
          diagnosticError instanceof Error
            ? diagnosticError.name
            : typeof diagnosticError,
        target: target.fileName,
      });
    }
    throw error;
  }
}

async function capturePaidOnboardingFailure(
  page: Page,
  target: RunnerCredentialTarget,
  outputDirectory: string,
): Promise<void> {
  const diagnosticDirectory = join(
    outputDirectory,
    "e2e-runner-checkout-diagnostics",
  );
  const fileStem = target.fileName.replace(/\.json$/u, "");
  await mkdir(diagnosticDirectory, { recursive: true });

  const results = await Promise.allSettled([
    writePaidOnboardingState(
      page,
      join(diagnosticDirectory, `${fileStem}.json`),
    ),
    page.screenshot({
      fullPage: true,
      path: join(diagnosticDirectory, `${fileStem}.png`),
    }),
  ]);
  if (!results.some((result) => result.status === "fulfilled")) {
    throw new Error("Unable to capture any paid onboarding diagnostic");
  }
}

async function writePaidOnboardingState(
  page: Page,
  path: string,
): Promise<void> {
  const [stripeResult, clerk] = await Promise.all([
    collectStripeCheckoutState(page).then(
      (state) => ({ available: true as const, state }),
      () => ({ available: false as const }),
    ),
    captureClerkReadiness(page),
  ]);
  const state = {
    clerk,
    stripe: stripeResult.available ? stripeResult.state : null,
  };
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

void main().catch((error: unknown) => {
  console.error(formatErrorReport(error));
  process.exitCode = 1;
});
