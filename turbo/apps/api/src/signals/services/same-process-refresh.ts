import { singleton } from "../../lib/singleton";
import { settleIncludingAbort } from "../utils";

/**
 * Same-process duplicate suppression for ordinary credential refresh: a
 * request for a credential this API instance is already refreshing starts
 * after that attempt settles, then observes its published result. It is not
 * cross-instance coordination and holds no database state; concurrent
 * refreshes on different instances remain the accepted ordinary-refresh risk.
 */
const sameProcessRefreshes = singleton(() => {
  return new Map<string, Promise<unknown>>();
});

export async function runAfterSameProcessRefresh<T>(
  key: string,
  refresh: () => Promise<T>,
): Promise<T> {
  const refreshes = sameProcessRefreshes();
  const previous = refreshes.get(key);
  const current = (async () => {
    if (previous) {
      await settleIncludingAbort(previous);
    }
    return await refresh();
  })();
  refreshes.set(key, current);
  const settled = await settleIncludingAbort(current);
  if (refreshes.get(key) === current) {
    refreshes.delete(key);
  }
  if (!settled.ok) {
    throw settled.error;
  }
  return settled.value;
}
