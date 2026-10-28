import {
  errors,
  type Frame,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";

import { safeNetworkUrl } from "./runner-network-diagnostics";

const MAX_RETRIES = 2;

export interface RunnerSignInNavigationOptions {
  readonly noResponseTimeoutMs: number;
  readonly timeoutMs: number;
}

/** Only the initial GET navigation may recover; never replay sign-in actions. */
export async function navigateToRunnerSignIn(
  page: Page,
  url: string,
  options: RunnerSignInNavigationOptions,
  beforeRetry: (attempt: number) => Promise<void>,
  responseHeaders: () => ReadonlyMap<string, number> | undefined,
): Promise<void> {
  const deadline = performance.now() + options.timeoutMs;
  const origin = new URL(url).origin;
  const pending = new Map<Request, { started: number; responded: boolean }>();
  let committed = false;
  let failed = false;
  let crashed = false;
  let lastTimeout = new errors.TimeoutError(
    "Runner sign-in navigation exceeded its shared deadline",
  );
  const observeHeaders = () => {
    const headers = responseHeaders();
    if (!headers) return false;
    for (const [request, observation] of pending) {
      const status = headers.get(safeNetworkUrl(request.url()));
      if (status !== undefined) {
        observation.responded = true;
        if (status >= 400) failed = true;
      }
    }
    return true;
  };
  const onRequest = (request: Request) => {
    const target = new URL(request.url());
    if (request.method() !== "GET" || target.origin !== origin) return;
    const document =
      request.isNavigationRequest() && request.frame() === page.mainFrame();
    const applicationScript =
      request.resourceType() === "script" &&
      target.pathname.startsWith("/okou-app/assets/") &&
      target.pathname.endsWith(".js");
    if (document || applicationScript) {
      pending.set(request, { started: performance.now(), responded: false });
    }
  };
  const onResponse = (response: Response) => {
    const request = pending.get(response.request());
    if (request) {
      request.responded = true;
      if (response.status() >= 400) failed = true;
    }
  };
  const onFinished = (request: Request) => pending.delete(request);
  const onFailed = (request: Request) => {
    if (pending.delete(request)) failed = true;
  };
  const onNavigation = (frame: Frame) => {
    if (frame === page.mainFrame()) committed = true;
  };
  const onCrash = () => {
    crashed = true;
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  page.on("framenavigated", onNavigation);
  page.on("crash", onCrash);
  try {
    for (let attempt = 1; ; attempt++) {
      pending.clear();
      committed = false;
      failed = false;
      let navigate = true;
      for (;;) {
        const headersAvailable = observeHeaders();
        const now = performance.now();
        const remaining = deadline - now;
        if (remaining <= 0) throw lastTimeout;
        const responseDeadline = Math.min(
          now + options.noResponseTimeoutMs,
          ...[...pending.values()]
            .filter((request) => !request.responded)
            .map((request) => request.started + options.noResponseTimeoutMs),
        );
        const timeout =
          attempt <= MAX_RETRIES && !failed && headersAvailable
            ? Math.max(1, Math.min(remaining, responseDeadline - now))
            : Math.max(1, remaining);
        try {
          if (navigate) {
            navigate = false;
            await page.goto(url, { waitUntil: "domcontentloaded", timeout });
          } else if (!committed) {
            // A timed-out goto can still be awaiting the first document. The
            // about:blank page's load state must not count as sign-in readiness.
            await page.waitForEvent("framenavigated", {
              predicate: (frame) => frame === page.mainFrame(),
              timeout,
            });
            continue;
          } else {
            await page.waitForLoadState("domcontentloaded", { timeout });
          }
          return;
        } catch (error: unknown) {
          if (!(error instanceof errors.TimeoutError)) throw error;
          lastTimeout = error;
          const headersAvailable = observeHeaders();
          const expired = performance.now();
          if (expired >= deadline || failed || crashed || page.isClosed()) {
            throw error;
          }
          const stalled = [...pending.values()].some(
            (request) =>
              !request.responded &&
              expired - request.started >= options.noResponseTimeoutMs,
          );
          if (stalled && headersAvailable && attempt <= MAX_RETRIES) {
            // Preserve evidence before cancelling the stalled load. Commit a
            // local blank document first so the previous navigation cannot
            // abort the next same-URL goto. Every browser wait is awaited.
            await beforeRetry(attempt);
            if (performance.now() >= deadline) throw error;
            await page.goto("about:blank", {
              waitUntil: "commit",
              timeout: Math.max(1, deadline - performance.now()),
            });
            break;
          }
        }
      }
    }
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFailed);
    page.off("framenavigated", onNavigation);
    page.off("crash", onCrash);
  }
}
