import { command, state, type Command } from "ccstate";
import { delay, timeout } from "signal-timers";
import { IN_VITEST } from "../env.ts";
import { now } from "../lib/time.ts";
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

/** Report a failure that no caller awaits: detached work and loop rounds. */
function reportUnawaitedRejection(error: unknown, reason: Reason): void {
  if (!isAbortError(error) && !(error instanceof ApiError && error.expected)) {
    L.error(`Detached promise rejected [${reason}]`, error);
  }
}

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
        reportUnawaitedRejection(error, reason);
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
// A round that fails before reaching its own wait must not retry in a spin.
const FAILED_LOOP_ROUND_MIN_DELAY_MS = 1000;

type LoopBody = (signal: AbortSignal) => Promise<boolean> | boolean;

interface LoopOptions {
  /** Keep an intentionally owner-lived loop paced in tests until its signal aborts. */
  testIntervalMs?: number;
}

/**
 * Start an owner-scoped background loop; completion is tracked by detach.
 * Like setInterval, a failed round does not stop the loop: it is reported the
 * way detached work is, and the next round runs on schedule. Only
 * cancellation ends the loop early.
 */
export function setLoop(
  loopBody: LoopBody,
  interval: number,
  signal: AbortSignal,
  options: LoopOptions = {},
): void {
  detach(
    internalSetLoop(loopBody, interval, signal, options, "continue"),
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
  return internalSetLoop(loopBody, interval, signal, options, "propagate");
}

async function internalSetLoop(
  loopBody: LoopBody,
  interval: number,
  signal: AbortSignal,
  options: LoopOptions,
  onFailure: "continue" | "propagate",
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

    // Each round awaits its body exactly once, so a loop's ordering against
    // other work does not depend on how failures are handled.
    let done = false;
    let failed = false;
    if (onFailure === "propagate") {
      done = await loopBody(signal);
    } else {
      // eslint-disable-next-line no-restricted-syntax -- a failed round is reported like detached work; the loop continues on schedule
      try {
        done = await loopBody(signal);
      } catch (error) {
        throwIfAbort(error);
        reportUnawaitedRejection(error, Reason.Daemon);
        failed = true;
      }
    }
    if (done) {
      return;
    }
    const nextInterval = failed
      ? Math.max(interval, FAILED_LOOP_ROUND_MIN_DELAY_MS)
      : interval;
    // Yield in tests so observable UI updates can render between iterations.
    await delay(IN_VITEST ? (options.testIntervalMs ?? 0) : nextInterval, {
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
 * Caller-owned rejections stay tracked for teardown but are reported only by
 * the operation consuming the receipt, after its domain-specific handling.
 */
export interface DeferredPromise<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  settled: () => boolean;
}

export function createDeferredPromise<T>(
  ...args:
    | [signal: AbortSignal]
    | [options: { readonly rejection: "owner" }, signal: AbortSignal]
): DeferredPromise<T> {
  const signal = args.length === 1 ? args[0] : args[1];
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

  if (args.length === 1) {
    detach(promise, Reason.Deferred);
  } else {
    detach(Promise.allSettled([promise]), Reason.Deferred);
  }

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

// ---------------------------------------------------------------------------
// Shared asynchronous operation and command helpers
// ---------------------------------------------------------------------------

export function waitForToken<T>(
  token: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const aborted = createDeferredPromise<never>(signal);
  // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
  return withCleanup(Promise.race([token, aborted.promise]), () => {
    if (!aborted.settled()) {
      aborted.reject(new DOMException("Token read settled", "AbortError"));
    }
  });
}

/** Track whether a ccstate-owned async load is still available for joining. */
export interface TrackedAsyncResource<T> {
  readonly pending: () => boolean;
  readonly promise: Promise<T>;
}

export function trackAsyncResource<T>(
  promise: Promise<T>,
): TrackedAsyncResource<T> {
  let pending = true;
  // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
  const trackedPromise = withCleanup(promise, () => {
    pending = false;
  });
  return {
    pending: () => {
      return pending;
    },
    promise: trackedPromise,
  };
}

export function waitForBrowserPaint(signal: AbortSignal): Promise<void> {
  if (
    typeof window === "undefined" ||
    typeof globalThis.window.requestAnimationFrame !== "function" ||
    typeof globalThis.window.cancelAnimationFrame !== "function"
  ) {
    return Promise.resolve();
  }

  const deferred = createDeferredPromise<void>(signal);
  let firstFrameId: number | null = null;
  let secondFrameId: number | null = null;

  function cleanup(): void {
    signal.removeEventListener("abort", handleAbort);
  }

  function finish(): void {
    cleanup();
    if (!deferred.settled()) {
      deferred.resolve(undefined);
    }
  }

  function handleAbort(): void {
    if (firstFrameId !== null) {
      globalThis.window.cancelAnimationFrame(firstFrameId);
    }
    if (secondFrameId !== null) {
      globalThis.window.cancelAnimationFrame(secondFrameId);
    }
    finish();
  }

  signal.addEventListener("abort", handleAbort, { once: true });
  firstFrameId = globalThis.window.requestAnimationFrame(() => {
    secondFrameId = globalThis.window.requestAnimationFrame(finish);
  });
  return deferred.promise;
}

/** Report local voice failures while preserving the operation's rejection. */
export async function withVoiceDraftFailureToast<T>(
  operation: Promise<T>,
  onFailure: (error: unknown) => void,
  signal: AbortSignal,
): Promise<T> {
  // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
  const result = await settle(operation, signal);
  if (result.ok) {
    return result.value;
  }
  onFailure(result.error);
  throw result.error;
}

function commandSignal(
  args: readonly [...unknown[], AbortSignal],
): AbortSignal {
  // TypeScript cannot address the last element of a generic variadic tuple.
  return args[args.length - 1] as AbortSignal;
}

/**
 * Wait for a quiet interval before invoking the command with its latest args.
 * A new call cancels the previous delay and cooperatively cancels active work.
 * Superseded calls reject with AbortError; the latest call returns its result.
 * The final argument is the caller's lifecycle signal, as on the source command.
 */
export function debounceCommand<T, Args extends unknown[]>(
  command$: Command<T, [...Args, AbortSignal]>,
  intervalMs: number,
): Command<Promise<Awaited<T>>, [...Args, AbortSignal]> {
  const reset$ = resetSignal();

  const runDebounced$ = command(
    async (
      { set },
      args: [...Args, AbortSignal],
      parentSignal: AbortSignal,
    ): Promise<Awaited<T>> => {
      parentSignal.throwIfAborted();
      const signal = set(reset$, parentSignal);
      await delay(intervalMs, { signal });
      const invocationArgs: [...Args, AbortSignal] = [...args];
      invocationArgs[invocationArgs.length - 1] = signal;
      const result = await set(command$, ...invocationArgs);
      signal.throwIfAborted();
      return result;
    },
  );

  return command(({ set }, ...args: [...Args, AbortSignal]) => {
    return set(runDebounced$, args, commandSignal(args));
  });
}

type Completion<T> = ReturnType<typeof createDeferredPromise<T>>;

/**
 * Serialize command executions with a minimum interval between their starts.
 * An idle call starts immediately. Further calls share one trailing execution,
 * which uses the latest args without extending the interval. Every caller can
 * await its execution's result or error. Calls in one Store share scheduling
 * state and must pass the same lifecycle signal; independent lifecycles use
 * separate factory instances. Different Stores always have independent state.
 */
export function throttleCommand<T, Args extends unknown[]>(
  command$: Command<T, [...Args, AbortSignal]>,
  intervalMs: number,
): Command<Promise<Awaited<T>>, [...Args, AbortSignal]> {
  const lastStartedAt$ = state<number | null>(null);
  const active$ = state<Completion<Awaited<T>> | null>(null);
  const trailing$ = state<{
    readonly completion: Completion<Awaited<T>>;
    readonly args: [...Args, AbortSignal];
  } | null>(null);

  const executeScheduled$ = command(
    async (
      { get, set },
      completion: Completion<Awaited<T>>,
      args: [...Args, AbortSignal],
      previous: Promise<Awaited<T>> | null,
      signal: AbortSignal,
    ): Promise<Awaited<T>> => {
      signal.throwIfAborted();
      if (previous) {
        // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
        await settle(previous, signal);
      }
      const lastStartedAt = get(lastStartedAt$);
      const remaining =
        lastStartedAt === null
          ? 0
          : Math.max(0, lastStartedAt + intervalMs - now());
      if (remaining > 0) {
        await delay(remaining, { signal });
      }
      signal.throwIfAborted();

      const trailing = get(trailing$);
      const invocationArgs =
        trailing?.completion === completion ? trailing.args : args;
      if (trailing?.completion === completion) {
        set(trailing$, null);
      }
      set(active$, completion);
      set(lastStartedAt$, now());
      return await set(command$, ...invocationArgs);
    },
  );

  const runScheduled$ = command(
    async (
      { get, set },
      completion: Completion<Awaited<T>>,
      args: [...Args, AbortSignal],
      previous: Promise<Awaited<T>> | null,
      signal: AbortSignal,
    ): Promise<Awaited<T>> => {
      // eslint-disable-next-line ccstate/no-on-rejection -- 存量 2026/10/21: propagate execution failure to the shared completion.
      const result = await onRejection(
        // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
        withCleanup(
          set(executeScheduled$, completion, args, previous, signal),
          () => {
            if (get(active$) === completion) {
              set(active$, null);
            }
            if (get(trailing$)?.completion === completion) {
              set(trailing$, null);
            }
          },
        ),
        (error) => {
          if (!completion.settled()) {
            completion.reject(error);
          }
        },
      );
      signal.throwIfAborted();
      completion.resolve(result);
      return result;
    },
  );

  return command(({ get, set }, ...args: [...Args, AbortSignal]) => {
    const signal = commandSignal(args);
    signal.throwIfAborted();
    const trailing = get(trailing$);
    if (trailing) {
      set(trailing$, { completion: trailing.completion, args });
      return trailing.completion.promise;
    }

    const active = get(active$);
    const lastStartedAt = get(lastStartedAt$);
    const leading =
      active === null &&
      (lastStartedAt === null || now() - lastStartedAt >= intervalMs);
    const completion = createDeferredPromise<Awaited<T>>(signal);
    // Publish ownership before execution, including when the delay reaches zero.
    if (leading) {
      set(active$, completion);
    } else {
      set(trailing$, { completion, args });
    }
    return set(
      runScheduled$,
      completion,
      args,
      active?.promise ?? null,
      signal,
    );
  });
}
