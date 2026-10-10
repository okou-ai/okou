import { onTestFinished } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";

interface FixtureOperationOwner {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export function createFixtureOperationOwner(
  teardown: () => Promise<unknown>,
  options: {
    readonly beforeDrain?: () => void;
    readonly continueAcceptedOperations?: boolean;
  } = {},
): FixtureOperationOwner {
  let teardownStarted = false;
  let drained = false;
  const acceptedOperation = new AsyncLocalStorage<{ active: boolean }>();
  const operations: Promise<unknown>[] = [];

  async function run<T>(operation: () => Promise<T>): Promise<T> {
    if (
      drained ||
      (teardownStarted &&
        !(
          options.continueAcceptedOperations &&
          acceptedOperation.getStore()?.active
        ))
    ) {
      throw new Error("Fixture teardown already started");
    }
    const scope = { active: true };
    const pending = Promise.resolve()
      .then(() => {
        return acceptedOperation.run(scope, operation);
      })
      .then(
        (value) => {
          scope.active = false;
          return value;
        },
        (error: unknown) => {
          scope.active = false;
          throw error;
        },
      );
    operations.push(pending);
    return await pending;
  }

  onTestFinished(async () => {
    teardownStarted = true;
    options.beforeDrain?.();
    // A timed-out route can still own a non-cancellable database query.
    let count = 0;
    while (count < operations.length) {
      const pending = operations.slice(count);
      count = operations.length;
      await Promise.allSettled(pending);
    }
    drained = true;
    await teardown();
  });

  return { run };
}
