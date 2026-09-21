import { describe, expect, it } from "vitest";

import {
  clearAllDetached,
  settleIncludingAbort,
  detach,
  joinAllInOrder,
  Mechanism,
  startUntrackedBestEffortCleanup,
} from "../utils";

interface PromiseResolvers<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function promiseWithResolvers<T>(): PromiseResolvers<T> {
  return (
    Promise as PromiseConstructor & {
      withResolvers<Value>(): PromiseResolvers<Value>;
    }
  ).withResolvers<T>();
}

function pendingPromise(): Promise<void> {
  return promiseWithResolvers<void>().promise;
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

describe("joinAllInOrder", () => {
  it("settles every owned branch and surfaces errors by dependency order", async () => {
    const first = promiseWithResolvers<void>();
    const second = promiseWithResolvers<void>();
    const completed: string[] = [];
    const firstError = new Error("first dependency failed");
    const secondError = new Error("second dependency failed");
    const work = joinAllInOrder([
      first.promise.finally(() => {
        completed.push("first");
      }),
      second.promise.finally(() => {
        completed.push("second");
      }),
    ]);
    let settled = false;
    void work.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    second.reject(secondError);
    await Promise.resolve();
    expect(settled).toBeFalsy();
    expect(completed).toStrictEqual(["second"]);

    first.reject(firstError);
    await expect(work).rejects.toBe(firstError);
    expect(completed).toStrictEqual(["second", "first"]);
  });

  it("settles every owned branch before surfacing cancellation", async () => {
    const controller = new AbortController();
    const first = promiseWithResolvers<void>();
    const second = promiseWithResolvers<void>();
    const completed: string[] = [];
    const reason = new DOMException("cancelled", "AbortError");
    const work = joinAllInOrder(
      [
        first.promise.finally(() => {
          completed.push("first");
        }),
        second.promise.finally(() => {
          completed.push("second");
        }),
      ],
      controller.signal,
    );
    let settled = false;
    void work.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    controller.abort(reason);
    second.resolve();
    await Promise.resolve();
    expect(settled).toBeFalsy();
    expect(completed).toStrictEqual(["second"]);

    first.resolve();
    await expect(work).rejects.toBe(reason);
    expect(completed).toStrictEqual(["second", "first"]);
  });
});
