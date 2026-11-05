import { computed } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { eq } from "drizzle-orm";
import { organizationAuthContext$ } from "../auth/auth-context";
import { db$ } from "../external/db";
import { createUserFeatureSwitchContext } from "./feature-switches.service";

const memberSwitchContext$ = createUserFeatureSwitchContext(
  organizationAuthContext$,
);

/** The verified Run marker survives claim's queue consumption and flag changes. */
const workflowSingleAgent$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType === "agent") {
    return auth.singleAgent === true;
  }
  return isFeatureEnabled(
    FeatureSwitchKey.SingleAgent,
    await get(memberSwitchContext$),
  );
});

export const workflowNamespace$ = computed(async (get) => {
  if (!(await get(workflowSingleAgent$))) {
    return null;
  }
  const auth = get(organizationAuthContext$);
  const [org] = await get(db$)
    .select({ id: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, auth.orgId))
    .limit(1);
  if (!org?.id) {
    throw new Error("Workspace default executor is unavailable");
  }
  return org.id;
});
