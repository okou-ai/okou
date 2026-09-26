import { withUsageEventCompactionLockScopeForTest } from "../signals/services/usage-event-compaction-lock.service";

export type DbFixture = <T>(
  scope: string,
  work: () => Promise<T>,
) => Promise<T>;

export async function usageEventCompactionDbFixture<T>(
  scope: string,
  work: () => Promise<T>,
): Promise<T> {
  return await withUsageEventCompactionLockScopeForTest(scope, work);
}
