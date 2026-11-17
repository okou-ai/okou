import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { computed } from "ccstate";

import { authContext$ } from "../auth/auth-context";
import { createUserFeatureSwitchContext } from "./feature-switches.service";

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
