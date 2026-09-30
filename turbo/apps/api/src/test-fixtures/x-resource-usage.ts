
import { z } from "zod";
import { withXResourceClockForTest } from "../signals/services/x-resource-usage-lifecycle";

/** Scope a database-clock override to one test-owned API operation. */
export async function withXResourceClock<T>(
  clock: () => Date,
  work: () => Promise<T>,
): Promise<T> {
  return await withXResourceClockForTest(clock, work);
}
