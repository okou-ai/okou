import { onTestFinished } from "vitest";

interface FixtureOperationOwner {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export function createFixtureOperationOwner(
  teardown: () => Promise<unknown>,
  options: { readonly beforeDrain?: () => void } = {},
): FixtureOperationOwner {
  let teardownStarted = false;
  const operations: Promise<unknown>[] = [];

  async function run<T>(operation: () => Promise<T>): Promise<T> {
    if (teardownStarted) {
      throw new Error("Fixture teardown already started");
    }
    const pending = Promise.resolve().then(operation);
    operations.push(pending);
    return await pending;
  }

  onTestFinished(async () => {
    teardownStarted = true;
    options.beforeDrain?.();
    // A timed-out route can still own a non-cancellable database query.
    await Promise.allSettled(operations);
    await teardown();
  });

  return { run };
}
