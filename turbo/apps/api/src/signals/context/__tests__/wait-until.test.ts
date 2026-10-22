import { testContext } from "../../../__tests__/test-context";
import { acknowledgeDetachedForTest, createDeferredPromise } from "../../utils";
import {
  observeWaitUntilLifecycle,
  waitUntil,
  type WaitUntilLifecycleResult,
} from "../wait-until";

const context = testContext();

// Infrastructure contract: the observer owns telemetry completion, not the
// HTTP response. Deferred work models the promises supplied by its callers.
describe("waitUntil lifecycle observation", () => {
  it("returns before background work and includes work registered by that work", async () => {
    const parent = createDeferredPromise<void>(context.signal);
    const child = createDeferredPromise<void>(context.signal);
    const completed = createDeferredPromise<WaitUntilLifecycleResult>(
      context.signal,
    );

    await observeWaitUntilLifecycle(
      () => {
        waitUntil(
          (async () => {
            await parent.promise;
            waitUntil(child.promise);
          })(),
        );
      },
      (result) => {
        completed.resolve(result);
      },
    );

    // Reaching this point while the parent is still pending proves that
    // observing the lifecycle did not hold the foreground caller open.
    parent.resolve();
    child.resolve();
    await expect(completed.promise).resolves.toStrictEqual({
      taskCount: 2,
      failureCount: 0,
    });
  });

  it("isolates concurrent request scopes and excludes observer work", async () => {
    const first = createDeferredPromise<void>(context.signal);
    const second = createDeferredPromise<void>(context.signal);
    const firstCompleted = createDeferredPromise<WaitUntilLifecycleResult>(
      context.signal,
    );
    const secondCompleted = createDeferredPromise<WaitUntilLifecycleResult>(
      context.signal,
    );

    await observeWaitUntilLifecycle(
      () => {
        waitUntil(first.promise);
      },
      (result) => {
        firstCompleted.resolve(result);
      },
    );
    await observeWaitUntilLifecycle(
      () => {
        waitUntil(second.promise);
        waitUntil(Promise.resolve());
      },
      (result) => {
        // A telemetry flush cannot become part of its own observed lifecycle.
        waitUntil(Promise.resolve());
        secondCompleted.resolve(result);
      },
    );

    second.resolve();
    await expect(secondCompleted.promise).resolves.toStrictEqual({
      taskCount: 2,
      failureCount: 0,
    });
    first.resolve();
    await expect(firstCompleted.promise).resolves.toStrictEqual({
      taskCount: 1,
      failureCount: 0,
    });
  });

  it("preserves a handler failure and still observes its background work", async () => {
    const background = createDeferredPromise<void>(context.signal);
    const completed = createDeferredPromise<WaitUntilLifecycleResult>(
      context.signal,
    );
    const error = new Error("Handler failed");

    await expect(
      observeWaitUntilLifecycle(
        () => {
          waitUntil(background.promise);
          throw error;
        },
        (result) => {
          completed.resolve(result);
        },
      ),
    ).rejects.toBe(error);

    background.resolve();
    await expect(completed.promise).resolves.toStrictEqual({
      taskCount: 1,
      failureCount: 0,
    });
  });

  it("reports failed background work while waiting for the other tasks", async () => {
    const failed = Promise.reject(new Error("Background operation failed"));
    const remaining = createDeferredPromise<void>(context.signal);
    const completed = createDeferredPromise<WaitUntilLifecycleResult>(
      context.signal,
    );

    await observeWaitUntilLifecycle(
      () => {
        waitUntil(failed);
        waitUntil(remaining.promise);
      },
      (result) => {
        completed.resolve(result);
      },
    );
    remaining.resolve();
    await expect(completed.promise).resolves.toStrictEqual({
      taskCount: 2,
      failureCount: 1,
    });
    // This test explicitly observed the intentional background rejection.
    acknowledgeDetachedForTest(failed);
  });
});
