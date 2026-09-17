import { AsyncLocalStorage } from "node:async_hooks";

import { sql } from "drizzle-orm";

import { singleton } from "../../lib/singleton";
import type { Db } from "../external/db";

const scopedAdmissionAttempt = singleton(() => {
  return new AsyncLocalStorage<(orgId: string) => void>();
});

export async function withPreparedLaunchAdmissionTrackingForTest<T>(
  onAttempt: (orgId: string) => void,
  work: () => Promise<T>,
): Promise<T> {
  return await scopedAdmissionAttempt().run(onAttempt, work);
}

/** Observe final admission only, after launch and subscription preparation. */
export async function lockPreparedLaunchAdmission(
  db: Pick<Db, "execute">,
  orgId: string,
): Promise<void> {
  scopedAdmissionAttempt.peek()?.getStore()?.(orgId);
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);
}
