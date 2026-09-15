import { describe, expect, it } from "vitest";

import {
  clearAllDetached,
  settleIncludingAbort,
  detach,
  Mechanism,
  startUntrackedBestEffortCleanup,
} from "../utils";

interface PromiseResolvers<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function pendingPromise(): Promise<void> {
  return (
    Promise as PromiseConstructor & {
      withResolvers<T>(): PromiseResolvers<T>;
    }
  ).withResolvers<void>().promise;
}

describe("clearAllDetached", () => {
  it("drains detached promises scheduled by detached work", async () => {
    const completed: string[] = [];

    detach(
      (async () => {
        await Promise.resolve();
        completed.push("outer");
        detach(
          (async () => {
            await Promise.resolve();
            completed.push("inner");
          })(),
          Mechanism.WaitUntil,
        );
      })(),
      Mechanism.WaitUntil,
    );

    await clearAllDetached();

    expect(completed).toStrictEqual(["outer", "inner"]);
  });

  it("does not wait for untracked best-effort cleanup", async () => {
    const completed: string[] = [];
    startUntrackedBestEffortCleanup(pendingPromise());
    detach(
      Promise.resolve().then(() => {
        completed.push("tracked");
      }),
      Mechanism.WaitUntil,
    );

    await clearAllDetached();

    expect(completed).toStrictEqual(["tracked"]);
  });
});

describe("settleIncludingAbort", () => {
  it("owns synchronous cancellation errors after irreversible work", async () => {
    const error = new DOMException("observation failed", "AbortError");
    await expect(
      settleIncludingAbort(() => {
        throw error;
      }),
    ).resolves.toStrictEqual({ ok: false, error });
  });
});
