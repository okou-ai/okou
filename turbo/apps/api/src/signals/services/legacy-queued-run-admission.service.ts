import { AsyncLocalStorage } from "node:async_hooks";

import { singleton } from "../../lib/singleton";

const legacyQueuedRunAdmissionForTest = singleton(() => {
  return new AsyncLocalStorage<true>();
});

/**
 * Earlier API versions queued runs at the organization capacity limit, and
 * promotion still drains those runs. No production launch queues any more, so
 * tests of that promotion path create legacy queued runs inside this scope.
 */
export async function withLegacyQueuedRunAdmissionForTest<T>(
  work: () => Promise<T>,
): Promise<T> {
  return await legacyQueuedRunAdmissionForTest().run(true, work);
}

export function legacyQueuedRunAdmissionEnabledForTest(): boolean {
  return legacyQueuedRunAdmissionForTest.peek()?.getStore() === true;
}
