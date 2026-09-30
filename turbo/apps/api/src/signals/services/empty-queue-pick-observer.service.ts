import { AsyncLocalStorage } from "node:async_hooks";

import { singleton } from "../../lib/singleton";

type EmptyQueuePickObserver = (chatThreadId: string) => Promise<void>;

const scopedEmptyQueuePickObserver = singleton(() => {
  return new AsyncLocalStorage<EmptyQueuePickObserver>();
});

/** Scope an empty-queue pick observer to the operation that owns the test. */
export async function withEmptyQueuePickObserverForTest<T>(
  observer: EmptyQueuePickObserver,
  work: () => Promise<T>,
): Promise<T> {
  return await scopedEmptyQueuePickObserver().run(observer, work);
}

/**
 * Observe a picker that read an empty queue while holding the lease, before
 * its conditional delete runs.
 */
export async function observeEmptyQueuePickForTest(
  chatThreadId: string,
): Promise<void> {
  const observer = scopedEmptyQueuePickObserver.peek()?.getStore();
  if (observer) {
    await observer(chatThreadId);
  }
}
