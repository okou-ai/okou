import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";

interface CleanupBudget {
  readonly signal: AbortSignal;
  readonly maxRequests: number;
  readonly requestIntervalMs: number;
  attempts: number;
  lastRequestAt: number | undefined;
}

interface CleanupLimits {
  readonly maxRequests?: number;
  readonly maxDurationMs?: number;
  readonly requestIntervalMs?: number;
}

const cleanupBudget = new AsyncLocalStorage<CleanupBudget>();

export async function withClerkCleanupBudget<T>(
  operation: () => Promise<T>,
  limits: CleanupLimits = {},
): Promise<T> {
  if (cleanupBudget.getStore()) {
    return await operation();
  }
  const maxRequests = limits.maxRequests ?? 500;
  const maxDurationMs = limits.maxDurationMs ?? 300_000;
  const requestIntervalMs =
    limits.requestIntervalMs ?? (process.env.CLERK_API_TEST_BASE_URL ? 0 : 500);
  if (
    !Number.isSafeInteger(maxRequests) ||
    maxRequests <= 0 ||
    !Number.isSafeInteger(maxDurationMs) ||
    maxDurationMs <= 0 ||
    !Number.isSafeInteger(requestIntervalMs) ||
    requestIntervalMs < 0
  ) {
    throw new Error("Invalid Clerk cleanup request budget");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("Clerk cleanup time budget exhausted"));
  }, maxDurationMs);
  try {
    return await cleanupBudget.run(
      {
        signal: controller.signal,
        maxRequests,
        requestIntervalMs,
        attempts: 0,
        lastRequestAt: undefined,
      },
      operation,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function assertClerkCleanupCanRequest(): void {
  const budget = cleanupBudget.getStore();
  if (!budget) {
    return;
  }
  budget.signal.throwIfAborted();
  if (budget.attempts >= budget.maxRequests) {
    throw new Error(
      `Clerk cleanup request budget exhausted (${budget.attempts}/${budget.maxRequests} attempts)`,
    );
  }
}

export async function fetchClerkRequest(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const budget = cleanupBudget.getStore();
  if (!budget) {
    return await fetch(url, init);
  }
  assertClerkCleanupCanRequest();
  if (budget.lastRequestAt !== undefined) {
    await waitForClerkRequest(
      Math.max(
        0,
        Math.ceil(
          budget.lastRequestAt + budget.requestIntervalMs - performance.now(),
        ),
      ),
    );
  }
  assertClerkCleanupCanRequest();
  budget.lastRequestAt = performance.now();
  budget.attempts += 1;
  // Fetch's signal also governs reading the body after headers have arrived.
  const signal = AbortSignal.any([
    budget.signal,
    AbortSignal.timeout(10_000),
    ...(init.signal ? [init.signal] : []),
  ]);
  return await fetch(url, { ...init, redirect: "error", signal });
}

export async function waitForClerkRequest(delayMs: number): Promise<void> {
  await delay(delayMs, undefined, { signal: cleanupBudget.getStore()?.signal });
}
