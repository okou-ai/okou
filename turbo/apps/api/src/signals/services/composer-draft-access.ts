import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { command, computed } from "ccstate";

import { authContext$ } from "../auth/auth-context";
import { createUserFeatureSwitchContext } from "./feature-switches.service";
import { projectReferences } from "./project-reference.service";

const identity$ = computed((get) => {
  const auth = get(authContext$);
  return auth.orgId ? { orgId: auth.orgId, userId: auth.userId } : null;
});
const featureContext$ = createUserFeatureSwitchContext(identity$);

export const conditionalComposerDraftsEnabled$ = computed(async (get) => {
  const context = await get(featureContext$);
  return (
    context !== null &&
    isFeatureEnabled(FeatureSwitchKey.ConditionalComposerDrafts, context)
  );
});

export const conditionalDraftReferencesAllowed$ = command(
  async (
    { get },
    document: UserMessageDocument | null,
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    if (projectReferences(document).length === 0) {
      return true;
    }
    const context = await get(featureContext$);
    signal.throwIfAborted();
    return (
      context !== null &&
      isFeatureEnabled(FeatureSwitchKey.SingleAgent, context)
    );
  },
);
