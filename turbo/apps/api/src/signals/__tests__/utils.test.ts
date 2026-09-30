import { describe, expect, it } from "vitest";

import {
  clearAllDetached,
  collectAllDetachedErrorsForTest,
  settleIncludingAbort,
  detach,
  joinAll,
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

  it("preserves the first-error contract after draining every failure", async () => {
    const firstError = new Error("first detached failure");
    const secondError = new Error("second detached failure");
    detach(Promise.reject(firstError), Mechanism.WaitUntil);
    detach(Promise.reject(secondError), Mechanism.WaitUntil);

    await expect(clearAllDetached()).rejects.toBe(firstError);
    await expect(collectAllDetachedErrorsForTest()).resolves.toStrictEqual([]);
  });
});

describe("collectAllDetachedErrorsForTest", () => {
  it("reports distinct failures including work scheduled while draining", async () => {
    const firstError = new Error("outer detached failure");
    const secondError = new Error("nested detached failure");
    const completed: string[] = [];
    const runNestedWork = async () => {
      await Promise.resolve();
      completed.push("inner");
      throw secondError;
    };
    detach(
      Promise.resolve().then(() => {
        detach(runNestedWork(), Mechanism.WaitUntil);
        completed.push("outer");
        throw firstError;
      }),
      Mechanism.WaitUntil,
    );

    await expect(collectAllDetachedErrorsForTest()).resolves.toStrictEqual([
      firstError,
      secondError,
    ]);
    expect(completed).toStrictEqual(["outer", "inner"]);
    await expect(collectAllDetachedErrorsForTest()).resolves.toStrictEqual([]);
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

describe("joinAll", () => {
  it("settles every owned branch before surfacing the first rejection", async () => {
    const first = promiseWithResolvers<void>();
    const second = promiseWithResolvers<void>();
    const error = new Error("second branch failed");
    const work = joinAll([first.promise, second.promise]);
    let settled = false;
    const settlementObservation = work.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const secondObservation = settleIncludingAbort(second.promise);

    second.reject(error);
    await secondObservation;
    expect(settled).toBeFalsy();

    first.resolve();
    await expect(work).rejects.toBe(error);
    await settlementObservation;
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
