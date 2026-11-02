import { command, state, type Command } from "ccstate";
import { delay, timeout } from "signal-timers";
import { IN_VITEST } from "../env.ts";
import { ApiError } from "../lib/api-error.ts";
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
        if (
          !isAbortError(error) &&
          !(error instanceof ApiError && error.expected)
        ) {
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
 * Legacy-only helper: await `p` and return undefined on non-abort rejection.
 * If supplied, `onError` runs before resolving. Abort propagates.
 * Do not introduce new usage; propagate failures and derive UI from loadables.
 * See docs/app/signals/tapError.md.
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
 * synchronous throws and abort), then re-throw. Reserved for explicitly reviewed
 * infrastructure boundaries; see docs/app/signals/onRejection.md. Application
 * request state belongs to the operation's loadable, not a failure callback.
 * If `fn` rejects, its error replaces the original rejection. `fn` runs on abort
 * by design, so `ccstate/no-catch-abort` cannot apply to this implementation.
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
 * Settle an operation into a discriminated union. A factory also catches
 * synchronous failures before a promise exists. Abort errors propagate (re-throw),
 * either from the operation itself or from `signal` if one is passed — so the returned
 * union is guaranteed to never represent a cancellation. Use as a
 * `.then(onOk, onErr)` replacement when the caller needs to map both
 * branches to a value rather than swallow the error.
 */
export async function settle<T>(
  operation: Promise<T> | (() => T | Promise<T>),
  signal?: AbortSignal,
): Promise<Settled<T>> {
  // eslint-disable-next-line no-restricted-syntax
  try {
    const value = await (typeof operation === "function"
      ? operation()
      : operation);
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

/** Add an owner-bound deadline, preserving the owner's reason on cancellation. */
export function abortAfter(
  ms: number,
  parentSignal: AbortSignal,
  timeoutReason: unknown = new DOMException(
    "Operation timed out",
    "AbortError",
  ),
): AbortSignal {
  const controller = new AbortController();
  timeout(
    () => {
      controller.abort(timeoutReason);
    },
    ms,
    { signal: parentSignal },
  );
  return AbortSignal.any([parentSignal, controller.signal]);
}

const MAX_LOOP_COUNT_IN_TEST = 100;

type LoopBody = (signal: AbortSignal) => Promise<boolean> | boolean;

interface LoopOptions {
  /** Keep an intentionally owner-lived loop paced in tests until its signal aborts. */
  testIntervalMs?: number;
}

/** Start an owner-scoped background loop; completion is tracked by detach. */
export function setLoop(
  loopBody: LoopBody,
  interval: number,
  signal: AbortSignal,
  options: LoopOptions = {},
): void {
  detach(
    internalSetLoop(loopBody, interval, signal, options),
    Reason.Daemon,
    "loop",
  );
}

/** Wait until the body returns true; propagate failures and cancellation. */
export function waitLoopUntil(
  loopBody: LoopBody,
  interval: number,
  signal: AbortSignal,
  options: LoopOptions = {},
): Promise<void> {
  return internalSetLoop(loopBody, interval, signal, options);
}

async function internalSetLoop(
  loopBody: LoopBody,
  interval: number,
  signal: AbortSignal,
  options: LoopOptions,
): Promise<void> {
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

    const done = await loopBody(signal);
    if (done) {
      return;
    }
    // Yield in tests so observable UI updates can render between iterations.
    await delay(IN_VITEST ? (options.testIntervalMs ?? 0) : interval, {
      signal,
    });
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
