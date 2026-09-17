import { joinAll, settleIncludingAbort } from "../signals/utils";

/** Keep the pool busy, stop scheduling on failure, and drain started work. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const values: R[] = [];
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const index = next++;
      const result = await settleIncludingAbort(
        (async (): Promise<R> => {
          return await run(items[index]!);
        })(),
      );
      if (!result.ok) {
        failed = true;
        throw result.error;
      }
      values[index] = result.value;
    }
  }
  await joinAll(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return values;
}
