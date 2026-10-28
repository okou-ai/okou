import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Frame, Page, Request, Response } from "@playwright/test";

import {
  signInWithClerkEmailCode,
  type ClerkEmailCodeSignInOptions,
} from "./auth";
import {
  expectedAppBuild,
  safeNetworkUrl,
  startRunnerNetworkDiagnostics,
} from "./runner-network-diagnostics";
import {
  navigateToRunnerSignIn,
  type RunnerSignInNavigationOptions,
} from "./runner-sign-in-navigation";

const MAX_REQUESTS = 64;
const MAX_MILESTONES = 32;
const PAGE_STATE_TIMEOUT_MS = 1_000;

// A raw trace can contain bypass cookies, session tokens and request bodies.
// Keep only allowlisted metadata, never the full URL or arbitrary error text.
interface RequestObservation {
  readonly url: string;
  readonly resourceType: string;
  readonly startedMs: number;
  responseMs?: number;
  status?: number;
  endedMs?: number;
  outcome: "pending" | "finished" | "failed";
  failureCode?: string;
}

async function capturePageState(page: Page) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page
        .evaluate(() => ({
          readyState: document.readyState,
          clerk: window.Clerk
            ? window.Clerk.loaded
              ? "loaded"
              : "loading"
            : "absent",
          sessionPresent: Boolean(window.Clerk?.session),
          organizationPresent: Boolean(window.Clerk?.organization),
          bootstrapSkeletonPresent: Boolean(
            document.getElementById("app-bootstrap-skeleton"),
          ),
        }))
        .then(
          (state) => ({ kind: "observed" as const, state }),
          () => ({ kind: "unavailable" as const, reason: "evaluation-failed" }),
        ),
      new Promise<{ kind: "unavailable"; reason: "deadline" }>((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: "unavailable", reason: "deadline" }),
          PAGE_STATE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Failure-only evidence for the standalone Runner credential preparation. */
export async function signInRunnerWithDiagnostics(
  page: Page,
  email: string,
  appUrl: string,
  options: ClerkEmailCodeSignInOptions & {
    readonly diagnosticPath: string;
    readonly expectedAppBuildSha?: string;
    readonly navigationRetry?: RunnerSignInNavigationOptions;
  },
): Promise<string> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const requests = new Map<Request, RequestObservation>();
  const milestones: { event: string; elapsedMs: number; url: string }[] = [];
  let omittedRequests = 0;
  let omittedMilestones = 0;
  let pageErrors = 0;
  let crashed = false;
  let closed = page.isClosed();

  const milestone = (event: string) => {
    if (milestones.length < MAX_MILESTONES) {
      milestones.push({
        event,
        elapsedMs: elapsed(),
        url: safeNetworkUrl(page.url()),
      });
    } else {
      omittedMilestones++;
    }
  };
  const onRequest = (request: Request) => {
    if (requests.size >= MAX_REQUESTS) {
      omittedRequests++;
      return;
    }
    requests.set(request, {
      url: safeNetworkUrl(request.url()),
      resourceType: request.resourceType(),
      startedMs: elapsed(),
      outcome: "pending",
    });
  };
  const onResponse = (response: Response) => {
    const observation = requests.get(response.request());
    if (observation) {
      observation.status = response.status();
      observation.responseMs = elapsed();
    }
  };
  const onFinished = (request: Request) => {
    const observation = requests.get(request);
    if (observation) {
      observation.outcome = "finished";
      observation.endedMs = elapsed();
    }
  };
  const onFailed = (request: Request) => {
    const observation = requests.get(request);
    if (observation) {
      observation.outcome = "failed";
      observation.endedMs = elapsed();
      const code = request.failure()?.errorText ?? "";
      observation.failureCode = /^net::ERR_[A-Z_]+$/u.test(code)
        ? code
        : "unclassified";
    }
  };
  const onNavigation = (frame: Frame) => {
    if (frame === page.mainFrame()) milestone("document-committed");
  };
  const onDOMContentLoaded = () => milestone("domcontentloaded");
  const onLoad = () => milestone("load");
  const onPageError = () => {
    pageErrors++;
  };
  const onCrash = () => {
    crashed = true;
  };
  const onClose = () => {
    closed = true;
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  page.on("framenavigated", onNavigation);
  page.on("domcontentloaded", onDOMContentLoaded);
  page.on("load", onLoad);
  page.on("pageerror", onPageError);
  page.on("crash", onCrash);
  page.on("close", onClose);
  const build = {
    appOrigin: new URL(appUrl).origin,
    expected: expectedAppBuild(options.expectedAppBuildSha),
  };
  let network = await startRunnerNetworkDiagnostics(page, elapsed, build);
  let navigationAttempt = 1;
  const saveDiagnostics = async (path: string) => {
    try {
      const report = {
        expectedAppBuild: build.expected,
        appOrigin: build.appOrigin,
        elapsedMs: elapsed(),
        navigationAttempt,
        route: safeNetworkUrl(page.url()),
        closed,
        crashed,
        pageErrors,
        milestones: [...milestones],
        omittedMilestones,
        requests: [...requests.values()].map((request) => ({ ...request })),
        omittedRequests,
        network: network.freeze(),
        pageState: await capturePageState(page),
      };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // Diagnostics must not replace the authentication failure or recovery.
      console.error("Unable to save runner sign-in diagnostics");
    }
  };
  try {
    try {
      const navigationRetry = options.navigationRetry;
      return await signInWithClerkEmailCode(page, email, appUrl, {
        ...options,
        navigateToSignIn: navigationRetry
          ? (url) =>
              navigateToRunnerSignIn(
                page,
                url,
                navigationRetry,
                async (attempt) => {
                  await saveDiagnostics(
                    `${options.diagnosticPath}.navigation-${attempt}.json`,
                  );
                  await network.dispose();
                  requests.clear();
                  milestones.length = 0;
                  omittedRequests = 0;
                  omittedMilestones = 0;
                  pageErrors = 0;
                  navigationAttempt = attempt + 1;
                  network = await startRunnerNetworkDiagnostics(
                    page,
                    elapsed,
                    build,
                  );
                },
                () => network.responseHeaders(),
              )
          : options.navigateToSignIn,
      });
    } finally {
      // Freeze the failure evidence before best-effort capture or caller cleanup.
      network.freeze();
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
      page.off("framenavigated", onNavigation);
      page.off("domcontentloaded", onDOMContentLoaded);
      page.off("load", onLoad);
      page.off("pageerror", onPageError);
      page.off("crash", onCrash);
      page.off("close", onClose);
    }
  } catch (error: unknown) {
    await saveDiagnostics(options.diagnosticPath);
    throw error;
  } finally {
    await network.dispose();
  }
}
