import { createStore } from "ccstate";
import { z } from "zod";

import { syncSkillsForScope$ } from "../signals/services/cron-sync-skills.service";

const ownedSkillScopeSchema = z.object({
  skillNamePrefix: z.string().regex(/^api-test-skill-[0-9a-f]{32}-$/),
  requiredSkillNames: z.array(z.string()).min(1),
});

// Run the real sync only for the calling test's unique skill prefix.
export async function syncSkillFixturesForTest(
  scope: {
    readonly skillNamePrefix: string;
    readonly requiredSkillNames: readonly string[];
  },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const ownedScope = ownedSkillScopeSchema.parse(scope);
  return await createStore().set(syncSkillsForScope$, ownedScope, signal);
}
