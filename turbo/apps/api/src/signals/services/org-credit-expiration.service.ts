import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { atomicOrgCreditExpirationSql } from "./org-credit-expiration";

/** Business recovery for a wallet writer that found unfinished expiration. */
export const expireOrgCredits$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      const [wallet] = await tx
        .select({ orgId: orgMetadata.orgId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .for("update");
      if (!wallet) {
        return;
      }
      await tx.execute(atomicOrgCreditExpirationSql(orgId, nowDate()));
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);
