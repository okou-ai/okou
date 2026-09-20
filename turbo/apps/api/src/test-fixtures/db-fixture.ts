import { withUsageEventCompactionLockScopeForTest } from "../signals/services/usage-event-compaction-lock.service";
import { withXResourceAdmissionScopeForTest } from "../signals/services/x-resource-usage-lifecycle";

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

export async function xResourceAdmissionDbFixture<T>(
  scope: string,
  work: () => Promise<T>,
): Promise<T> {
  return await withXResourceAdmissionScopeForTest(scope, work);
}
