import { withEmptyQueuePickObserverForTest } from "../signals/services/empty-queue-pick-observer.service";

/**
 * Hold the lease holder of one thread after it read an empty queue and before
 * its conditional delete, for the duration of `work`.
 */
export async function holdEmptyQueuePickForTest<T>(
  chatThreadId: string,
  hold: () => Promise<void>,
  work: () => Promise<T>,
): Promise<T> {
  return await withEmptyQueuePickObserverForTest(async (pickedThreadId) => {
    if (pickedThreadId === chatThreadId) {
      await hold();
    }
  }, work);
}
