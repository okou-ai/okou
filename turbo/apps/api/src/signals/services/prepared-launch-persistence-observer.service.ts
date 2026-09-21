import { AsyncLocalStorage } from "node:async_hooks";

import { singleton } from "../../lib/singleton";

interface PreparedLaunchPersistenceSnapshot {
  readonly runId: string;
  readonly workflowAutomationId: string | undefined;
}

type PreparedLaunchPersistenceObserver = (
  snapshot: PreparedLaunchPersistenceSnapshot,
) => Promise<void> | void;

const scopedPreparedLaunchPersistenceObserver = singleton(() => {
  return new AsyncLocalStorage<PreparedLaunchPersistenceObserver>();
});

/** Scope impossible persistence outcomes to the operation that owns the test. */
export async function withPreparedLaunchPersistenceObserverForTest<T>(
  observer: PreparedLaunchPersistenceObserver,
  work: () => Promise<T>,
): Promise<T> {
  return await scopedPreparedLaunchPersistenceObserver().run(observer, work);
}

/** Observe a real atomic launch write before its transaction can commit. */
export async function observePreparedLaunchPersistenceForTest(
  snapshot: PreparedLaunchPersistenceSnapshot,
): Promise<void> {
  const observer = scopedPreparedLaunchPersistenceObserver.peek()?.getStore();
  if (observer) {
    await observer(snapshot);
  }
}
