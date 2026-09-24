import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { sql } from "drizzle-orm";

import { db } from "../lib/db";
import { nowDate } from "../lib/time";

/**
 * Reconstruct an override admitted by an older API before the retirement.
 * The current public API intentionally cannot write `true`, but already-native
 * owners and mixed-version writes must remain testable through real routes.
 * Only UUID-owned test identities call this fixture; ordinary switches still
 * use the public feature-switch endpoint.
 */
export async function seedRetainedNativeMorningBriefOverride(owner: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  const at = nowDate();
  await db()
    .insert(userFeatureSwitches)
    .values({
      ...owner,
      switches: { [FeatureSwitchKey.NativeMorningBrief]: true },
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
      set: {
        switches: sql`jsonb_set(${userFeatureSwitches.switches}, '{simpleMorningBrief}', 'true'::jsonb)`,
        updatedAt: at,
      },
    });
}
