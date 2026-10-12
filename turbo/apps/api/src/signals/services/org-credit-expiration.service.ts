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
 * The wallet lock, cohort clear/debit and conditional fresh remainder read
 * share one transaction. Expired remainder throws OrgCreditExpirationConflict
 * before commit; the next cron cycle or wallet writer expires the cohort again.
 */
export const expireOrgCreditsAt$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly at: Date },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    // eslint-disable-next-line api/no-db-transaction -- Billing atomicity: expired-lot clears and their wallet debit must commit together or both roll back when expired remainder survives; single-statement alternative: the conditional clear needs a later fresh snapshot to distinguish benign concurrent completion from a partial cohort requiring precommit rollback.
    await db.transaction(async (tx) => {
      // Cash writers acquire the wallet before grant/expiry-lot locks.
      await tx
        .select({ orgId: orgMetadata.orgId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, args.orgId))
        .for("update");
      const outcome = orgCreditExpirationOutcome(
        parseRawRows(
          orgCreditExpirationOutcomeRow,
          await tx.execute(orgCreditExpirationSql(args.orgId, args.at)),
        ),
      );
      // A fresh statement snapshot: concurrent completion or extension can
      // leave no expired remainder even when not every selected lot cleared.
      const [remaining] =
        outcome.cleared === outcome.expected
          ? []
          : await tx
              .select()
              .from(pendingOrgCreditExpirationQuery(args.orgId, args.at));
      requireCompleteOrgCreditExpiration(args.orgId, outcome, remaining);
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);
