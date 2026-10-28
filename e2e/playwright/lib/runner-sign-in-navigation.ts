import {
  errors,
  type Frame,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";

import {
  safeNetworkUrl,
  type TransferActivity,
} from "./runner-network-diagnostics";

const MAX_RETRIES = 2;

export interface RunnerSignInNavigationOptions {
  readonly idleTimeoutMs: number;
  readonly timeoutMs: number;
}

/** Only the initial GET navigation may recover; never replay sign-in actions. */
export async function navigateToRunnerSignIn(
  page: Page,
  url: string,
  options: RunnerSignInNavigationOptions,
  beforeRetry: (attempt: number) => Promise<void>,
  transferActivity: () => ReadonlyMap<string, TransferActivity> | undefined,
  afterRetry: () => Promise<void>,
): Promise<void> {
  const deadline = performance.now() + options.timeoutMs;
  const origin = new URL(url).origin;
  const pending = new Set<Request>();
  let committed = false;
  let failed = false;
  let crashed = false;
  let lastTimeout = new errors.TimeoutError(
    "Runner sign-in navigation exceeded its shared deadline",
  );
  const observeActivity = () => {
    const activity = transferActivity();
    if (!activity) return undefined;
    const transfers: TransferActivity[] = [];
    for (const request of pending) {
      const progress = activity.get(safeNetworkUrl(request.url()));
      if (!progress) return undefined;
      if (progress.failed) failed = true;
      if (progress.pending) transfers.push(progress);
    }
    return transfers;
  };
  const onRequest = (request: Request) => {
    const target = new URL(request.url());
    if (request.method() !== "GET" || target.origin !== origin) return;
    const document =
      request.isNavigationRequest() && request.frame() === page.mainFrame();
    const applicationAsset =
      (request.resourceType() === "script" ||
        request.resourceType() === "stylesheet") &&
      target.pathname.startsWith("/okou-app/assets/") &&
      /\.(?:js|css)$/u.test(target.pathname);
    if (document || applicationAsset) {
      pending.add(request);
    }
  };
  const onResponse = (response: Response) => {
    if (pending.has(response.request()) && response.status() >= 400)
      failed = true;
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
        const transfers = observeActivity();
        const now = performance.now();
        const remaining = deadline - now;
        if (remaining <= 0) throw lastTimeout;
        const untilIdle = Math.min(
          options.idleTimeoutMs,
          ...(transfers ?? []).map(
            (transfer) => options.idleTimeoutMs - transfer.idleMs,
          ),
        );
        const timeout =
          attempt <= MAX_RETRIES && !failed && transfers
            ? Math.max(1, Math.min(remaining, untilIdle))
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
          const transfers = observeActivity();
          const expired = performance.now();
          if (expired >= deadline || failed || crashed || page.isClosed()) {
            throw error;
          }
          const stalled = transfers?.some(
            (transfer) => transfer.idleMs >= options.idleTimeoutMs,
          );
          if (stalled && attempt <= MAX_RETRIES) {
            // Preserve evidence before cancelling the stalled load. Commit a
            // local blank document first so the previous navigation cannot
            // abort the next same-URL goto. Every browser wait is awaited.
            await beforeRetry(attempt);
            if (performance.now() >= deadline) throw error;
            const current = observeActivity();
            if (failed || crashed || page.isClosed()) throw error;
            // Diagnostic capture can take time. Do not replace a load that
            // completed or resumed progress while its snapshot was written.
            if (committed) {
              try {
                await page.waitForLoadState("domcontentloaded", { timeout: 1 });
                return;
              } catch (readyError: unknown) {
                if (!(readyError instanceof errors.TimeoutError))
                  throw readyError;
              }
            }
            if (
              !current?.some(
                (transfer) => transfer.idleMs >= options.idleTimeoutMs,
              )
            ) {
              continue;
            }
            await page.goto("about:blank", {
              waitUntil: "commit",
              timeout: Math.max(1, deadline - performance.now()),
            });
            await afterRetry();
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
