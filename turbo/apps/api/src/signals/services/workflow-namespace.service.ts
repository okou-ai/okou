import { computed } from "ccstate";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { eq } from "drizzle-orm";
import { organizationAuthContext$ } from "../auth/auth-context";
import { db$ } from "../external/db";

/** Retained Runs resolve Workflows in their captured Agent namespace. */
export const workflowNamespace$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType === "agent" && auth.singleAgent !== true) {
    return null;
  }
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
