import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command } from "ccstate";
import { asc, eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  atomicOrgCreditExpirationSql,
  boundedOrgCreditExpirationSql,
  expiredOrgCreditsWhere,
  omittedOrgCreditExpirationQuery,
  ORG_CREDIT_EXPIRATION_BATCH_SIZE,
} from "./org-credit-expiration";

/** Business recovery for a wallet writer that found unfinished expiration. */
export const expireOrgCredits$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    await set(expireOrgCreditsAt$, { orgId, at: nowDate() }, signal);
  },
);

/** The cutoff is one business value; no database timestamp is rounded in JS. */
export const expireOrgCreditsAt$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly at: Date },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    while (true) {
      const prepared = await db
        .select({ id: creditExpiresRecord.id })
        .from(creditExpiresRecord)
        .where(expiredOrgCreditsWhere(args.orgId, args.at))
        .orderBy(
          asc(creditExpiresRecord.expiresAt),
          asc(creditExpiresRecord.id),
        )
        .limit(ORG_CREDIT_EXPIRATION_BATCH_SIZE);
      signal.throwIfAborted();
      if (prepared.length === 0) {
        return;
      }
      const ids = prepared.map(({ id }) => {
        return id;
      });
      const exists = await db.transaction(async (tx) => {
        const [wallet] = await tx
          .select({ orgId: orgMetadata.orgId })
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, args.orgId))
          .for("update");
        if (!wallet) {
          return false;
        }
        const [omitted] = await tx
          .select()
          .from(omittedOrgCreditExpirationQuery(args.orgId, args.at, ids));
        if (omitted) {
          // Pre-R1 adders can add between partial clamps. Until those writers have
          // drained, the incomplete cohort must commit one full clamp instead.
          // This branch runs before a finite batch has changed any amount.
          await tx.execute(atomicOrgCreditExpirationSql(args.orgId, args.at));
        } else {
          // Re-read remaining amounts/expiry under row ownership in this statement;
          // never apply a prepared absolute balance or an observed lot amount.
          await tx.execute(
            boundedOrgCreditExpirationSql(args.orgId, args.at, ids),
          );
        }
        signal.throwIfAborted();
        return true;
      });
      signal.throwIfAborted();
      if (!exists) {
        return;
      }
    }
  },
);
