import { env } from "../lib/env";
import { logger } from "../lib/log";
import { singleton } from "../lib/singleton";

export enum Mechanism {
  WaitUntil = "wait_until",
  BestEffortCleanup = "best_effort_cleanup",
  Deferred = "deferred",
}

const IN_VITEST = env("VITEST") === "true";
const L = logger("Promise");
const NON_ERROR_THROWN_PREFIX = "Non-Error thrown: ";
const NORMALIZED_THROWN_MESSAGE_MAX_LENGTH = 4096;

class PromiseTracker {
  collected = new Set<Promise<unknown>>();
  mechanisms = new Map<Promise<unknown>, Mechanism>();
  descriptions = new Map<Promise<unknown>, string>();
}

const tracker = singleton(() => {
  return new PromiseTracker();
});

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error || error instanceof DOMException) &&
    error.name === "AbortError"
  );
}

export function throwIfAbort(error: unknown): void {
  if (isAbortError(error)) {
    throw error;
  }
}

export function safeJsonParse(input: string): unknown {
  // eslint-disable-next-line no-restricted-syntax -- this is the centralized guarded JSON.parse
  try {
    return JSON.parse(input);
  } catch (error) {
    throwIfAbort(error);
    return undefined;
  }
}

export function safeUrlParse(input: string): URL | undefined {
  // eslint-disable-next-line no-restricted-syntax -- centralized guarded URL constructor
  try {
    return new URL(input);
  } catch (error) {
    throwIfAbort(error);
    return undefined;
  }
}

export function safeUriComponentDecode(input: string): string | undefined {
  const result = safeSync(() => {
    return decodeURIComponent(input);
  });
  return "ok" in result ? result.ok : undefined;
}

export function safeSync<T>(
  fn: () => T,
): { readonly ok: T } | { readonly error: unknown } {
  // eslint-disable-next-line no-restricted-syntax -- centralized guarded sync
  try {
    return { ok: fn() };
  } catch (error) {
    throwIfAbort(error);
    return { error };
  }
}

function safeThrownValueMessage(value: unknown): string {
  const result = safeSync(() => {
    return String(value);
  });
  const serialized = "ok" in result ? result.ok : "unknown thrown value";
  const valueMaxLength =
    NORMALIZED_THROWN_MESSAGE_MAX_LENGTH - NON_ERROR_THROWN_PREFIX.length;
  const serializedValue =
    serialized.length <= valueMaxLength
      ? serialized
      : `${serialized.slice(0, valueMaxLength - 3)}...`;
  return `${NON_ERROR_THROWN_PREFIX}${serializedValue}`;
}

function normalizeThrownError(value: unknown): Error {
  throwIfAbort(value);
  if (value instanceof Error) {
    return value;
  }
  return new Error(safeThrownValueMessage(value), {
    cause: value,
  });
}

export async function normalizeThrown<T>(run: () => Promise<T>): Promise<T> {
  // eslint-disable-next-line no-restricted-syntax -- centralized thrown value normalization
  try {
    return await run();
  } catch (error) {
    throwIfAbort(error);
    throw normalizeThrownError(error);
  }
}

export function isValidTimeZone(input: string): boolean {
  // eslint-disable-next-line no-restricted-syntax -- centralized guarded Intl timezone validation
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: input });
    return true;
  } catch (error) {
    throwIfAbort(error);
    return false;
  }
}

/**
 * Await `p`, swallowing non-abort rejections. Use for fire-and-forget work
 * where failure is acceptable. AbortError propagates — either from `p`
 * itself or from `signal` if one is passed — so a cancelled request never
 * returns silently as if the work succeeded.
 */
export async function bestEffort(
  p: Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- centralized .catch replacement
  try {
    await p;
    signal?.throwIfAborted();
  } catch (error) {
    throwIfAbort(error);
    signal?.throwIfAborted();
  }
}

/**
 * Start best-effort cleanup that must not keep tests or request cleanup waiting.
 * Use only for advisory cleanup promises that can legitimately remain pending
 * forever, such as Web Stream cancellation in fetch implementations.
 */
export function startUntrackedBestEffortCleanup(p: Promise<unknown>): void {
  void bestEffort(p).then(
    () => {},
    () => {},
  );
}

type BoundedResponseTextResult =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "too_large" };

function responseContentLengthExceeds(
  response: Response,
  maxBytes: number,
): boolean {
  const contentLength = response.headers.get("content-length");
  if (!contentLength) {
    return false;
  }

  const bytes = Number(contentLength);
  return Number.isFinite(bytes) && bytes > maxBytes;
}

function startResponseBodyCancel(
  body: ReadableStream<Uint8Array> | null,
): void {
  if (body) {
    startUntrackedBestEffortCleanup(body.cancel());
  }
}

/** Read an HTTP response body without allowing its byte size to exceed a limit. */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<BoundedResponseTextResult> {
  if (responseContentLengthExceeds(response, maxBytes)) {
    startResponseBodyCancel(response.body);
    return { kind: "too_large" };
  }

  if (!response.body) {
    return { kind: "text", text: "" };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      startUntrackedBestEffortCleanup(reader.cancel());
      return { kind: "too_large" };
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return { kind: "text", text: chunks.join("") };
}

/**
 * Await `p` and return undefined on non-abort rejection. If supplied,
 * `onError` runs before resolving. Abort propagates. Replaces
 * `await foo().catch((e) => { L.error("...", e); })` and silent optional-value
 * fallback patterns.
 */
export async function tapError<T>(
  p: Promise<T>,
  onError?: (error: unknown) => unknown,
): Promise<T | undefined> {
  // eslint-disable-next-line no-restricted-syntax -- centralized .catch replacement
  try {
    return await p;
  } catch (error) {
    throwIfAbort(error);
    await onError?.(error);
    return undefined;
  }
}

/**
 * Await `p` and invoke `fn` on any rejection (including abort), then re-throw.
 * Replaces `.catch((e) => { cleanup(); throw e; })` cleanup patterns. `fn`
 * runs on abort by design so cleanup (e.g. temp-dir removal) still happens
 * when the request is cancelled — that's why `api/no-catch-abort` is muted
 * here.
 */
export async function onRejection<T>(
  p: Promise<T>,
  fn: (error: unknown) => unknown,
): Promise<T> {
  // eslint-disable-next-line no-restricted-syntax -- centralized .catch replacement
  try {
    return await p;
    // eslint-disable-next-line api/no-catch-abort -- fn must run before abort propagates so cleanup happens on cancellation
  } catch (error) {
    await fn(error);
    throw error;
  }
}

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/**
 * Settle `p` without propagating AbortError. Use only after an irreversible
 * provider operation has started and cancellation is itself an ambiguous
 * outcome that the caller must persist explicitly.
 */
export async function settleIncludingAbort<T>(
  p: Promise<T>,
): Promise<Settled<T>> {
  // eslint-disable-next-line no-restricted-syntax -- centralized rejection capture for irreversible provider operations
  try {
    return { ok: true, value: await p };
    // eslint-disable-next-line api/no-catch-abort -- abort is an explicit persisted outcome for this helper
  } catch (error) {
    return { ok: false, error };
  }
}

interface PromiseResolvers<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

/**
 * Settle `p` into a discriminated union. AbortError propagates (re-throws),
 * either from `p` itself or from `signal` if one is passed — so the returned
 * union is guaranteed to never represent a cancellation. Replaces
 * `await foo().catch(() => fallback)` and `.then(onOk, onErr)` shapes when
 * both outcomes need to be mapped.
 */
export async function settle<T>(
  p: Promise<T>,
  signal?: AbortSignal,
): Promise<Settled<T>> {
  // eslint-disable-next-line no-restricted-syntax -- centralized .then(onOk, onErr) replacement
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

/**
 * Await an operation only until a signal aborts while continuing to observe
 * the original operation if the signal wins the race.
 */
export function awaitWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const { promise, resolve, reject } = (
    Promise as PromiseConstructor & {
      withResolvers<T>(): PromiseResolvers<T>;
    }
  ).withResolvers<T>();
  let settled = false;

  const finish = (settlePromise: () => void): void => {
    if (settled) {
      return;
    }
    settled = true;
    signal.removeEventListener("abort", onAbort);
    settlePromise();
  };
  const onAbort = (): void => {
    finish(() => {
      reject(signal.reason);
    });
  };

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  void operation.then(
    (value) => {
      finish(() => {
        resolve(value);
      });
    },
    (error: unknown) => {
      finish(() => {
        reject(error);
      });
    },
  );
  return promise;
}

export function detach(
  promise: Promise<unknown>,
  mechanism: Mechanism,
  description?: string,
): void {
  // Attach a rejection handler the moment work is detached so a background
  // failure is logged and never escalates to an unhandledRejection. The
  // original promise is what gets tracked: clearAllDetached re-awaits it in
  // afterEach so a non-abort rejection fails the test instead of passing
  // silently behind this catch.
  void promise.then(
    () => {},
    (error: unknown) => {
      if (!isAbortError(error)) {
        L.error(`Detached promise rejected [${mechanism}]`, error);
      }
    },
  );

  if (IN_VITEST) {
    tracker().collected.add(promise);
    tracker().mechanisms.set(promise, mechanism);
    if (description) {
      tracker().descriptions.set(promise, description);
    }
  }
}

export function acknowledgeDetachedForTest(promise: Promise<unknown>): void {
  if (!IN_VITEST) {
    return;
  }

  // Domain-level test synchronization may acknowledge only work it has
  // explicitly observed. Everything else remains owned by global teardown.
  tracker().collected.delete(promise);
  tracker().mechanisms.delete(promise);
  tracker().descriptions.delete(promise);
}

export function createDeferredPromise<T>(signal: AbortSignal): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
  readonly settled: () => boolean;
} {
  const { promise, resolve, reject } = (
    Promise as PromiseConstructor & {
      withResolvers<T>(): PromiseResolvers<T>;
    }
  ).withResolvers<T>();
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

  detach(promise, Mechanism.Deferred);

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

export async function clearAllDetached(): Promise<void> {
  if (!IN_VITEST) {
    return;
  }

  // Await every detached promise so background work cannot leak into the next
  // test. Detached work can schedule more detached work as it settles, so keep
  // draining until no promises remain. Only AbortError is swallowed — any other
  // rejection is re-thrown so a failing waitUntil task fails the test that
  // scheduled it.
  const errors: unknown[] = [];
  while (tracker().collected.size > 0) {
    const pending = [...tracker().collected];
    for (const promise of pending) {
      tracker().collected.delete(promise);
      tracker().mechanisms.delete(promise);
      tracker().descriptions.delete(promise);
    }

    for (const promise of pending) {
      await promise.then(
        () => {},
        (error: unknown) => {
          if (!isAbortError(error)) {
            errors.push(error);
          }
        },
      );
    }
  }
  if (errors.length > 0) {
    throw errors[0];
  }
}
