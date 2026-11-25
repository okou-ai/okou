import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { onboardingRollouts } from "@okouai/db/schema/onboarding-rollout";
import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { clerk$, type ClerkUser } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { db$ } from "../external/db";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import type { ProactiveWorkflowOwner } from "./proactive-workflows-eligibility.service";

export const shouldEnableOnboardingSuggestions$ = command(
  async (
    { get, set },
    owner: ProactiveWorkflowOwner,
    knownUser: ClerkUser | undefined,
    signal: AbortSignal,
  ) => {
    const [rollout] = await get(db$)
      .select({ activatedAt: onboardingRollouts.activatedAt })
      .from(onboardingRollouts)
      .leftJoin(
        orgMembersMetadata,
        and(
          eq(orgMembersMetadata.orgId, owner.orgId),
          eq(orgMembersMetadata.userId, owner.userId),
        ),
      )
      .where(
        and(
          eq(onboardingRollouts.name, "suggestions"),
          isNull(orgMembersMetadata.proactiveSuggestionsEnabled),
        ),
      );
    signal.throwIfAborted();
    if (!rollout) {
      return false;
    }
    const user =
      knownUser ?? (await findClerkUser(get(clerk$), owner.userId, signal));
    signal.throwIfAborted();
    if (
      user?.createdAt === undefined ||
      user.createdAt < rollout.activatedAt.getTime()
    ) {
      return false;
    }
    const features = await set(
      loadUserFeatureSwitchContext$,
      owner.orgId,
      owner.userId,
      signal,
    );
    return isFeatureEnabled(FeatureSwitchKey.AgentSuggestion, features);
  },
);
