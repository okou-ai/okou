import { eq } from "drizzle-orm";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import type { Db } from "../external/db";

/** Auto mode always offers personal accounts, independently of their Custom rollout flag. */
export async function personalAccountsEnabledForOrg(
  db: Db,
  orgId: string,
  switchEnabled: boolean,
): Promise<boolean> {
  if (switchEnabled) {
    return true;
  }
  const [org] = await db
    .select({ mode: orgMetadata.modelMode })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return org?.mode === "auto";
}
