import { command, state, type Command } from "ccstate";
import { delay } from "signal-timers";
import { IN_VITEST } from "../env.ts";
import { logger } from "./log.ts";

const L = logger("Promise");

export const NEVER_RESOLVED_PROMISE: Promise<never> =
  Promise.withResolvers<never>().promise;

export enum Reason {
  DomCallback = "dom_callback",
  Entrance = "entrance",
  Deferred = "deferred",
  Daemon = "daemon",
}

/** Private bookkeeping shared by detach() and clearAllDetached(). */
class PromiseTracker {
  readonly collected = new Map<
    Promise<void>,
    { readonly reason: Reason; readonly description?: string }
  >();
}

const tracker = new PromiseTracker();

export function detach<T>(
  promise: T | Promise<T>,
  reason: Reason,
  description?: string,
): void {
  L.debug("Detach promise", reason, description);

  const isPromise = promise instanceof Promise;
  let silencePromise: Promise<void> | undefined;

  if (isPromise) {
    // This instance is necessary because detach itself is a controlled way to generate a floating promise.
    // oxlint-disable-next-line promise/prefer-await-to-then
    silencePromise = Promise.resolve(promise).then(
      () => {},
      (error: unknown) => {
        if (!isAbortError(error)) {
          L.error(`Detached promise rejected [${reason}]`, error);
        }
      },
    );
  }

  if (IN_VITEST && silencePromise) {
    tracker.collected.set(silencePromise, { reason, description });
  }
}

/** Shared test setup drains detached work after testContext aborts its lifetimes. */
export async function clearAllDetached(): Promise<void> {
  for (const [promise, { reason, description }] of tracker.collected) {
    L.debug(`Await promise: ${reason} ${description ?? ""}`);
    await promise;
    tracker.collected.delete(promise);
  }
}

export const isAbortError = (error: unknown): boolean => {
  if (
    (error instanceof Error || error instanceof DOMException) &&
    error.name === "AbortError"
  ) {
    return true;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    error.reason instanceof Error &&
    error.reason.name === "AbortError"
  ) {
    return true;
  }

  return false;
};

/**
 * Treat cancellation by a nested lifecycle as successful completion while
 * preserving parent cancellation and unrelated failures.
 */
export function completeOnLocalAbort(
  completion: Promise<void>,
  localSignal: AbortSignal,
  parentSignal: AbortSignal,
): Promise<void> {
  return completion.then(undefined, (error) => {
    parentSignal.throwIfAborted();
    if (!localSignal.aborted || !isAbortError(error)) {
      throw error;
    }
  });
}

export function throwIfAbort(e: unknown) {
  if (isAbortError(e)) {
    throw e;
  }
}

/**
 * Parse JSON with a fallback value for untrusted input (e.g. localStorage).
 * Re-throws abort errors; swallows parse errors and returns `fallback`.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isNonArrayRecord(
  value: unknown,
): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

export function jsonParseOr<T>(value: string, fallback: T): T {
  // We must use this approach to silence the exception here. This is because
  // the function itself is designed to help the caller avoid having to handle
  // the try-catch block manually.
  // eslint-disable-next-line no-restricted-syntax
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throwIfAbort(error);
    return fallback;
  }
}

/**
 * Best-effort wrapper: await `p` and swallow non-abort errors.
 * Use for prefetch or fire-and-forget operations where failure is acceptable.
 * AbortError propagates — either from `p` itself or from `signal` if one is
 * passed — so a cancelled request never returns silently as if the work
 * succeeded.
 */
export async function bestEffort(
  p: Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax
  try {
    await p;
    signal?.throwIfAborted();
  } catch (error) {
    throwIfAbort(error);
    signal?.throwIfAborted();
  }
}

/**
 * Await `p` and return undefined on non-abort rejection. If supplied,
 * `onError` runs before resolving. Abort propagates. Use as a `.catch(handler)`
 * replacement when the caller needs an optional value and may surface a side
 * effect (toast, log) on failure.
 */
export async function tapError<T>(
  p: Promise<T>,
  onError?: (error: unknown) => unknown,
): Promise<T | undefined> {
  // eslint-disable-next-line no-restricted-syntax
  try {
    return await p;
  } catch (error) {
    throwIfAbort(error);
    await onError?.(error);
    return undefined;
  }
}

/**
 * Await a promise or invoke a factory and call `fn` on any rejection (including
 * synchronous throws and abort), then re-throw. Use as a `.catch(handler)`
 * replacement when the caller needs to run a side effect before the rejection
 * propagates. `fn` runs on abort by design so cleanup still happens when the
 * page is cancelled, which is why `ccstate/no-catch-abort` cannot apply to this
 * file.
 */
export async function onRejection<T>(
  operation: Promise<T> | (() => Promise<T> | T),
  fn: (error: unknown) => unknown,
): Promise<T> {
  // eslint-disable-next-line no-restricted-syntax
  try {
    return await (typeof operation === "function" ? operation() : operation);
  } catch (error) {
    await fn(error);
    throw error;
  }
}

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/**
 * Settle `p` into a discriminated union. Abort errors propagate (re-throw),
 * either from `p` itself or from `signal` if one is passed — so the returned
 * union is guaranteed to never represent a cancellation. Use as a
 * `.then(onOk, onErr)` replacement when the caller needs to map both
 * branches to a value rather than swallow the error.
 */
export async function settle<T>(
  p: Promise<T>,
  signal?: AbortSignal,
): Promise<Settled<T>> {
  // eslint-disable-next-line no-restricted-syntax
  try {
    const value = await p;
    signal?.throwIfAborted();
    return { ok: true, value };
  } catch (error) {
    throwIfAbort(error);
    signal?.throwIfAborted();
    return { ok: false, error };
  }
}

export async function withCleanup<T>(
  promise: Promise<T>,
  cleanup: () => void | Promise<void>,
): Promise<T> {
  // Centralizes command cleanup that must preserve the original promise result.
  // eslint-disable-next-line no-restricted-syntax -- helper preserves rejection while guaranteeing cleanup
  try {
    return await promise;
  } finally {
    await cleanup();
  }
}
// ---------------------------------------------------------------------------
// Bounded async load retry
// ---------------------------------------------------------------------------

const DEFAULT_RETRY_DELAYS_MS = [250, 750] as const;

function errorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  if ("status" in error && typeof error.status === "number") {
    return error.status;
  }
  if ("statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return null;
}

function isRetryableError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === null) {
    return true;
  }
  return status === 408 || status === 429 || status >= 500;
}

function runRetriedLoad<T>(load: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(load);
}

/**
 * Retry idempotent read/lazy-load operations that can fail on transient
 * network or chunk-loading errors. Do not wrap mutations: `load` may run more
 * than once. Computed reads are finite and may finish after invalidation; the
 * reactive graph discards their stale result.
 */
export function retryTransientLoad<T>(load: () => Promise<T>): Promise<T> {
  async function attemptLoad(attempt: number): Promise<T> {
    const result = await settle(runRetriedLoad(load));
    if (result.ok) {
      return result.value;
    }
    const delayMs = DEFAULT_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined || !isRetryableError(result.error)) {
      throw result.error;
    }
    await delay(IN_VITEST ? 0 : delayMs);
    return attemptLoad(attempt + 1);
  }

  return attemptLoad(0);
}

// ---------------------------------------------------------------------------
// Polling loop with fibonacci backoff
// ---------------------------------------------------------------------------
const FIB_DELAYS_MS = [
  1000, 1000, 2000, 3000, 5000, 8000, 13_000, 21_000, 34_000, 55_000, 60_000,
] as const;

const MAX_LOOP_COUNT_IN_TEST = 100;

function fibonacciRetryDelayMs(retryIndex: number): number {
  return (
    FIB_DELAYS_MS[Math.min(retryIndex, FIB_DELAYS_MS.length - 1)] ?? 60_000
  );
}

async function waitForFibonacciRetry(
  retryIndex: number,
  signal: AbortSignal,
): Promise<void> {
  const delayMs = fibonacciRetryDelayMs(retryIndex);
  await delay(IN_VITEST ? 0 : delayMs, { signal });
  signal.throwIfAborted();
}

/**
 * Run `loopBody` in a loop with `interval` between iterations.
 * Transient (non-abort) errors trigger fibonacci backoff retries.
 * Resolves when `loopBody` returns `true` (done) or rejects on abort.
 */
export async function setLoop(
  loopBody: (signal: AbortSignal) => Promise<boolean> | boolean,
  interval: number,
  signal: AbortSignal,
  options: {
    retryTransientErrors?: boolean;
    shouldRetryError?: (error: unknown) => boolean;
    logTransientErrors?: boolean;
    /** Keep an intentionally owner-lived loop paced in tests until its signal aborts. */
    testIntervalMs?: number;
  } = {},
): Promise<void> {
  let fibIndex = 0;
  let loopCount = 0;
  while (!signal.aborted) {
    if (
      IN_VITEST &&
      options.testIntervalMs === undefined &&
      loopCount++ > MAX_LOOP_COUNT_IN_TEST
    ) {
      throw new Error(
        `setLoop: infinite loop detected — exceeded ${MAX_LOOP_COUNT_IN_TEST} iterations in test`,
      );
    }

    // use try-catch here to implement an automatic retry.
    // eslint-disable-next-line no-restricted-syntax
    try {
      const done = await loopBody(signal);
      if (done) {
        return;
      }
      fibIndex = 0;
      // Keep yielding to the macrotask queue in tests so React can flush renders
      // between iterations, without waiting for the production interval.
      await delay(IN_VITEST ? (options.testIntervalMs ?? 0) : interval, {
        signal,
      });
    } catch (error) {
      throwIfAbort(error);
      if (
        options.retryTransientErrors === false ||
        (options.shouldRetryError !== undefined &&
          !options.shouldRetryError(error))
      ) {
        throw error;
      }
      const backoff = fibonacciRetryDelayMs(fibIndex);
      if (options.logTransientErrors !== false) {
        L.warn(
          `setLoop: transient error (attempt ${fibIndex + 1}), retrying in ${backoff}ms`,
          error,
        );
      }
      await waitForFibonacciRetry(fibIndex, signal);
      fibIndex++;
    }
  }
}

export function resetSignal(): Command<AbortSignal, AbortSignal[]> {
  const controller$ = state<AbortController | undefined>(undefined);

  return command(({ get, set }, ...signals: AbortSignal[]) => {
    get(controller$)?.abort();
    const controller = new AbortController();
    set(controller$, controller);

    return AbortSignal.any([controller.signal, ...signals]);
  });
}

/**
 * Create a local cancellation owner that always cascades its parent signal.
 * Aborting the child also removes its listener from the parent immediately.
 *
 * @deprecated Inherit an existing owner or use a stable resetSignal() command.
 */
export function createChildAbortController(
  parentSignal: AbortSignal,
): AbortController {
  const controller = new AbortController();
  const onParentAbort = () => {
    controller.abort(parentSignal.reason);
  };
  if (parentSignal.aborted) {
    onParentAbort();
  } else {
    const removeParentListener = () => {
      parentSignal.removeEventListener("abort", onParentAbort);
    };
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
    controller.signal.addEventListener("abort", removeParentListener, {
      once: true,
    });
  }
  return controller;
}

export function onDomEventFn<T>(callback: (e: T) => void | Promise<void>) {
  return function (e: T) {
    detach(callback(e), Reason.DomCallback);
  };
}

export function onRef<T extends HTMLElement | SVGSVGElement>(
  command$: Command<void | Promise<void>, [T, AbortSignal]>,
) {
  return command(({ set }, el: T | null) => {
    if (!el) {
      return;
    }

    const ctrl = new AbortController();

    detach(set(command$, el, ctrl.signal), Reason.DomCallback, "onRef");

    return () => {
      ctrl.abort();
    };
  });
}

/**
 * Create a deferred promise that can be resolved/rejected externally.
 * The promise is automatically rejected when the abort signal is triggered.
 */
export interface DeferredPromise<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  settled: () => boolean;
}

export function createDeferredPromise<T>(
  signal: AbortSignal,
): DeferredPromise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  let settled = false;
  let removeAbortListener = () => {};

  const settleOnce = (settlePromise: () => void) => {
    if (settled) {
      throw new Error("Deferred promise already settled");
    }
    settled = true;
    removeAbortListener();
    settlePromise();
  };

  detach(promise, Reason.Deferred);

  const guardedResolve = (value: T) => {
    settleOnce(() => {
      resolve(value);
    });
  };

  const guardedReject = (reason?: unknown) => {
    settleOnce(() => {
      reject(reason);
    });
  };

  const onAbort = () => {
    if (!settled) {
      guardedReject(signal.reason);
    }
  };

  if (signal.aborted) {
    guardedReject(signal.reason);
  } else {
    removeAbortListener = () => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    promise,
    resolve: guardedResolve,
    reject: guardedReject,
    settled: () => {
      return settled;
    },
  };
}
