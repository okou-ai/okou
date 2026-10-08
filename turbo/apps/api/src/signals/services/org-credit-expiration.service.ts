import { command } from "ccstate";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { eq } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  orgCreditExpirationOutcome,
  orgCreditExpirationOutcomeRow,
  orgCreditExpirationSql,
  pendingOrgCreditExpirationQuery,
  requireCompleteOrgCreditExpiration,
} from "./org-credit-expiration";

/**
 * Clears the organization's complete expired cohort with one conditional
 * statement inside the caller's transaction. Expired remainder left by a lot
 * a concurrent writer changed throws OrgCreditExpirationConflict, rolling the
 * caller back; that is the deterministic outcome, never an in-place re-run.
 */
export async function expireOrgCreditsInTransaction(
  tx: Pick<Tx, "execute" | "select">,
  orgId: string,
  at: Date,
): Promise<void> {
  // Cash writers acquire the wallet before grant/expiry-lot locks.
  await tx
    .select({ orgId: orgMetadata.orgId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .for("update");
  const outcome = orgCreditExpirationOutcome(
    parseRawRows(
      orgCreditExpirationOutcomeRow,
      await tx.execute(orgCreditExpirationSql(orgId, at)),
    ),
  );
  // A fresh statement snapshot: lots a concurrent expiration cleared first
  // are no longer expired remainder and are not a conflict.
  const [remaining] =
    outcome.cleared === outcome.expected
      ? []
      : await tx.select().from(pendingOrgCreditExpirationQuery(orgId, at));
  requireCompleteOrgCreditExpiration(orgId, outcome, remaining);
}

/** Business recovery for a wallet writer that found unfinished expiration. */
export const expireOrgCredits$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    await set(expireOrgCreditsAt$, { orgId, at: nowDate() }, signal);
  },
);

/**
 * The cutoff is one business value; no database timestamp is rounded in JS.
 * One statement in one transaction; a lost conditional clear surfaces as
 * OrgCreditExpirationConflict and the next cron cycle or wallet writer expires
 * the cohort again.
 */
export const expireOrgCreditsAt$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly at: Date },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(writeDb$).transaction(async (tx) => {
      await expireOrgCreditsInTransaction(tx, args.orgId, args.at);
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);
