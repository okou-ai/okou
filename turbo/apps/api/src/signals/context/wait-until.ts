import { AsyncLocalStorage } from "node:async_hooks";

// oxlint-disable-next-line no-restricted-imports -- this file owns the wrapper around @vercel/functions waitUntil
import { waitUntil as vercelWaitUntil } from "@vercel/functions";

import { env } from "../../lib/env";
import { currentRequestRuntime } from "../../lib/request-runtime";
import { singleton } from "../../lib/singleton";
import {
  acknowledgeDetachedForTest,
  detach,
  isAbortError,
  Mechanism,
  settleIncludingAbort,
} from "../utils";

const shouldTrackWaitUntil = env("VITEST") === "true";

class WaitUntilTracker {
  pending = new Set<Promise<unknown>>();
}

const waitUntilTracker = singleton(() => {
  return new WaitUntilTracker();
});

function trackWaitUntilForTest(work: Promise<unknown>): void {
  if (!shouldTrackWaitUntil) {
    return;
  }

  const tracker = waitUntilTracker();
  tracker.pending.add(work);
  void work.then(
    () => {
      tracker.pending.delete(work);
    },
    () => {
      tracker.pending.delete(work);
    },
  );
}

interface WaitUntilLifecycle {
  readonly pending: Promise<unknown>[];
}

export interface WaitUntilLifecycleResult {
  readonly taskCount: number;
  readonly failureCount: number;
}

const waitUntilLifecycle = singleton(() => {
  return new AsyncLocalStorage<WaitUntilLifecycle>();
});

function registerWaitUntil(work: Promise<unknown>): void {
  const runtime = currentRequestRuntime();
  if (runtime) {
    runtime.waitUntil(work);
  } else {
    vercelWaitUntil(work);
  }
  detach(work, Mechanism.WaitUntil);
  trackWaitUntilForTest(work);
}

export function waitUntil(work: Promise<unknown>): void {
  waitUntilLifecycle().getStore()?.pending.push(work);
  registerWaitUntil(work);
}

/**
 * Observe handler completion and all waitUntil registrations without delaying
 * the response. Nested work must register before its owning task settles.
 */
export async function observeWaitUntilLifecycle(
  work: () => void | Promise<void>,
  onComplete: (result: WaitUntilLifecycleResult) => void | Promise<void>,
): Promise<void> {
  const lifecycle: WaitUntilLifecycle = { pending: [] };
  const result = await waitUntilLifecycle().run(lifecycle, () => {
    return settleIncludingAbort(work);
  });

  // The foreground is still owned by the awaited HTTP handler. Register its
  // finalizer only once that work finishes, so background drains do not wait
  // for other requests whose foreground work is still in progress.
  // Register outside the request scope to exclude the observer's own delivery.
  registerWaitUntil(
    (async () => {
      let taskCount = 0;
      let failureCount = 0;
      while (lifecycle.pending.length > 0) {
        const pending = lifecycle.pending.splice(0);
        taskCount += pending.length;
        const settled = await Promise.allSettled(pending);
        failureCount += settled.filter((result) => {
          return result.status === "rejected";
        }).length;
        // A background task can itself register more waitUntil work.
      }
      await onComplete({ taskCount, failureCount });
    })(),
  );

  if (!result.ok) {
    throw result.error;
  }
}

export async function flushWaitUntilForTest(): Promise<void> {
  const errors: unknown[] = [];
  const tracker = waitUntilTracker();

  while (tracker.pending.size > 0) {
    const pending = [...tracker.pending];
    tracker.pending.clear();

    for (const promise of pending) {
      await promise.then(
        () => {},
        (error: unknown) => {
          if (!isAbortError(error)) {
            errors.push(error);
          }
        },
      );
      acknowledgeDetachedForTest(promise);
    }
  }

  if (errors.length > 0) {
    throw errors[0];
  }
}
