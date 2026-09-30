import { AsyncLocalStorage } from "node:async_hooks";

import { singleton } from "../../lib/singleton";

type PreparedLaunchPersistenceObserver = (
  workflowAutomationId: string | undefined,
) => void;

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
export function observePreparedLaunchPersistenceForTest(
  workflowAutomationId: string | undefined,
): void {
  const observer = scopedPreparedLaunchPersistenceObserver.peek()?.getStore();
  if (observer) {
    observer(workflowAutomationId);
  }
}
