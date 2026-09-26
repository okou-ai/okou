import { AsyncLocalStorage } from "node:async_hooks";

import { sql } from "drizzle-orm";

import { singleton } from "../../lib/singleton";
import type { Db } from "../external/db";

const scopedAdmissionAttempt = singleton(() => {
  return new AsyncLocalStorage<(orgId: string) => void>();
});

// Test-only: organizations whose final admission waits on the org advisory
// key held by an infrastructure fixture. Production never registers one.
const admissionGatedOrgs = singleton(() => {
  return new Map<string, number>();
});

export async function withPreparedLaunchAdmissionTrackingForTest<T>(
  onAttempt: (orgId: string) => void,
  work: () => Promise<T>,
): Promise<T> {
  return await scopedAdmissionAttempt().run(onAttempt, work);
}

/**
 * Test-only pause point. While registered, final admission for `orgId` also
 * waits on the org advisory key, which the caller's fixture holds. The
 * returned function unregisters this fixture.
 */
export function gatePreparedLaunchAdmissionForTest(orgId: string): () => void {
  const gated = admissionGatedOrgs();
  gated.set(orgId, (gated.get(orgId) ?? 0) + 1);
  let registered = true;
  return () => {
    if (!registered) {
      return;
    }
    registered = false;
    const remaining = (gated.get(orgId) ?? 1) - 1;
    if (remaining > 0) {
      gated.set(orgId, remaining);
    } else {
      gated.delete(orgId);
    }
  };
}

async function lockOrgAdmission(
  db: Pick<Db, "execute">,
  orgId: string,
): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);
}

/**
 * Observe final admission only, after launch and subscription preparation.
 * Ordinary launches take no organization lock: capacity admission is a coarse
 * count, so concurrent launches may briefly overshoot the limit.
 */
export async function enterPreparedLaunchAdmission(
  db: Pick<Db, "execute">,
  orgId: string,
): Promise<void> {
  scopedAdmissionAttempt.peek()?.getStore()?.(orgId);
  if (admissionGatedOrgs.peek()?.has(orgId)) {
    await lockOrgAdmission(db, orgId);
  }
}

/**
 * Final admission for an official workflow run. The org lock is the
 * lock-order fence against official workflow reconciliation, which locks the
 * org plan row before workflow and automation rows under this key, while this
 * admission locks workflow and automation rows before the plan row.
 */
export async function lockPreparedLaunchAdmission(
  db: Pick<Db, "execute">,
  orgId: string,
): Promise<void> {
  scopedAdmissionAttempt.peek()?.getStore()?.(orgId);
  await lockOrgAdmission(db, orgId);
}
