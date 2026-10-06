import { createStore } from "ccstate";
import { z } from "zod";

import { compactUsageEvents$ } from "../signals/services/cron-compact-usage-events.service";

const ownedOrgIdSchema = z.string().min(1);

// Keep the production compaction bounded to the calling test's organization.
export async function compactUsageForTest(orgId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const ownedOrgId = ownedOrgIdSchema.parse(orgId);
  return await createStore().set(compactUsageEvents$, ownedOrgId, signal);
}
