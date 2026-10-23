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

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/**
 * Settle `p` without propagating AbortError. Use when cancellation is an
 * explicitly owned outcome: observing and releasing a prepared resource, or
 * persisting an ambiguous result after an irreversible provider operation.
 */
export async function settleIncludingAbort<T>(
  p: Promise<T> | (() => T),
): Promise<Settled<T>> {
  // eslint-disable-next-line no-restricted-syntax -- centralized rejection capture for irreversible provider operations
  try {
    return { ok: true, value: await (typeof p === "function" ? p() : p) };
    // eslint-disable-next-line api/no-catch-abort -- abort is an explicit persisted outcome for this helper
  } catch (error) {
    return { ok: false, error };
  }
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
