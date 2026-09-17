import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../__tests__/test-context";
import { createDeferredPromise } from "../../signals/utils";
import { holdDeferredRow } from "../pi-deferred-lock";

const context = testContext();

describe("deferred database lock lifecycle", () => {
  it("commits once when explicitly released before cancellation", async () => {
    let commits = 0;
    const held = await holdDeferredRow(
      context.signal,
      () => {
        return Promise.resolve();
      },
      () => {
        commits++;
        return Promise.resolve();
      },
    );

    await held.release();
    await held.release();
    expect(commits).toBe(1);
  });

  it("joins rollback when an acquired hold is aborted before release", async () => {
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    let reachedCommit = false;
    const held = await holdDeferredRow(
      signal,
      () => {
        return Promise.resolve();
      },
      () => {
        reachedCommit = true;
        return Promise.resolve();
      },
    );

    controller.abort(new DOMException("Test cancelled", "AbortError"));
    await expect(held.release()).resolves.toBeUndefined();
    await expect(held.release()).resolves.toBeUndefined();
    expect(reachedCommit).toBeFalsy();
  });

  it("does not report readiness after cancellation during acquisition", async () => {
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const acquiring = createDeferredPromise<void>(context.signal);
    const acquired = createDeferredPromise<void>(context.signal);
    const reason = new DOMException("Acquisition cancelled", "AbortError");
    await Promise.all([
      expect(
        holdDeferredRow(signal, async () => {
          acquiring.resolve();
          await acquired.promise;
        }),
      ).rejects.toBe(reason),
      (async () => {
        await acquiring.promise;
        controller.abort(reason);
        acquired.resolve();
      })(),
    ]);
  });

  it("releases an outstanding hold during test teardown", async () => {
    const held = await holdDeferredRow(context.signal, () => {
      return Promise.resolve();
    });
    // testContext aborts before onTestFinished; that ordering must still join
    // the rollback without double-settling the release gate.
    onTestFinished(async () => {
      await expect(held.release()).resolves.toBeUndefined();
    });
  });
});
