import { chromium, type BrowserContext, type Page } from "@playwright/test";

import { resolveApiBackendUrl } from "./api-backend-url";
import { expectClerkTestInstance, signInWithClerkEmailCode } from "./lib/auth";
import { seedPreviewBypassCookie } from "./lib/preview-bypass";
import { RunnerWssApi, type OwnedWssRun } from "./lib/run-wss-api";
import {
  bundleRunWssProbe,
  closeRunWssProbe,
  installRunWssProbe,
  verifyRunWssEcho,
  verifyRunWssRevocation,
} from "./lib/run-wss-probe";

async function main(): Promise<void> {
  if (required("E2E_RUNNER_PROFILE") !== "mock-codex")
    throw new Error("Prepared mock Codex profile required");
  const apiUrl = secureOrigin(resolveApiBackendUrl());
  const appUrl = secureOrigin(required("OKOU_APP_URL"));
  const email = required("E2E_RUNNER_MOCK_CLAUDE_EMAIL");
  const organizationId = required("E2E_RUNNER_MOCK_CLAUDE_ORG_ID");
  const model = required("E2E_MOCK_CODEX_MODEL");
  const apiToken = required("E2E_API_TOKEN");
  const bundle = await bundleRunWssProbe();
  const browser = await chromium.launch();
  const lifetime = new AbortController();
  let deadlineClose: Promise<void> | undefined;
  const deadline = setTimeout(() => {
    lifetime.abort();
    deadlineClose = browser.close();
    // The owning finally awaits this close; avoid an unobserved rejection meanwhile.
    void deadlineClose.catch(() => {});
  }, 180_000);
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let api: RunnerWssApi | undefined;
  let failed = false;
  let cleanupFailures = 0;
  let phase = "sign-in";
  const receipts: {
    runId: string;
    runnerId: string;
    hostname: string;
    status: string;
  }[] = [];
  try {
    context = await browser.newContext({ ignoreHTTPSErrors: false });
    await seedPreviewBypassCookie(context, appUrl);
    page = await context.newPage();
    // Validate the existing test instance before the email-code helper submits anything.
    await page.goto(new URL("/sign-in", appUrl).toString(), {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(() => window.Clerk?.loaded === true, undefined, {
      timeout: 30_000,
    });
    await expectClerkTestInstance(page);
    await signInWithClerkEmailCode(page, email, appUrl, {
      activeOrganizationId: organizationId,
    });
    api = new RunnerWssApi(apiUrl, apiToken, lifetime.signal);
    phase = "profile";
    await api.verifyMockProfile(model);
    await api.createAgent();
    const probeOptions = { page, bundle, apiUrl };

    phase = "completion";
    // Finite native work keeps a real Run live during the short protocol exchange.
    const completed = await api.start(model, 45);
    await connect(probeOptions, completed, true);
    await api.waitForStatus(completed.runId, "completed");
    await verifyRunWssRevocation(page, completed.runId);
    await closeRunWssProbe(page);
    receipts.push({
      runId: completed.runId,
      runnerId: completed.runnerId,
      hostname: completed.hostname,
      status: "completed",
    });

    phase = "cancellation";
    const cancelled = await api.start(model, 300);
    await connect(probeOptions, cancelled, false);
    await api.cancel(cancelled.runId);
    await api.waitForStatus(cancelled.runId, "cancelled");
    await verifyRunWssRevocation(page, cancelled.runId);
    await closeRunWssProbe(page);
    receipts.push({
      runId: cancelled.runId,
      runnerId: cancelled.runnerId,
      hostname: cancelled.hostname,
      status: "cancelled",
    });
  } catch {
    failed = true;
  } finally {
    if (page && !page.isClosed()) {
      try {
        await closeRunWssProbe(page);
      } catch {
        cleanupFailures += 1;
      }
    }
    if (api) {
      try {
        await api.cleanup();
      } catch {
        cleanupFailures += 1;
      }
    }
    try {
      await context?.close();
    } catch {
      cleanupFailures += 1;
    }
    try {
      await browser.close();
    } catch {
      cleanupFailures += 1;
    }
    try {
      await deadlineClose;
    } catch {
      cleanupFailures += 1;
    }
    clearTimeout(deadline);
  }
  if (failed || cleanupFailures) {
    console.error(JSON.stringify({ result: "FAIL", phase, cleanupFailures }));
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({
      result: "PASS",
      tlsVerification: true,
      frameSizes: [0, 1, 17, 1024, 65536, 37],
      replayRejectedBeforeExpiry: true,
      runs: receipts,
      ownedCleanup: "PASS",
    }),
  );
}

async function connect(
  options: {
    readonly page: Page;
    readonly bundle: string;
    readonly apiUrl: string;
  },
  run: OwnedWssRun,
  replay: boolean,
): Promise<void> {
  await installRunWssProbe(
    options.page,
    options.bundle,
    options.apiUrl,
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
  );
  await verifyRunWssEcho(options.page, run.runId, run.expectedUrl, replay);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing WSS fixture environment: ${name}`);
  return value;
}

function secureOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("WSS fixture requires an exact HTTPS service origin");
  return url.origin;
}

void main().catch(() => {
  // Playwright and provider errors may embed credentials or request details.
  console.error(
    "Runner WSS acceptance failed; no credential-bearing diagnostic is emitted",
  );
  process.exitCode = 1;
});
