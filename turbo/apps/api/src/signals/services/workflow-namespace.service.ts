import { computed } from "ccstate";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { eq } from "drizzle-orm";
import { organizationAuthContext$ } from "../auth/auth-context";
import { db$ } from "../external/db";

export const workspaceWorkflowNamespace$ = computed(async (get) => {
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

/** Retained Runs can still use their legacy workflow namespace. */
export const workflowNamespace$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return auth.tokenType === "agent" && auth.singleAgent !== true
    ? null
    : get(workspaceWorkflowNamespace$);
});
