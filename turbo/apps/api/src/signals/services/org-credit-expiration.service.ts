import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { command } from "ccstate";
import { asc } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  atomicOrgCreditExpirationSql,
  boundedOrgCreditExpirationSql,
  expiredOrgCreditsWhere,
  OrgCreditExpirationConflict,
  orgCreditExpirationOutcome,
  orgCreditExpirationOutcomeRow,
  ORG_CREDIT_EXPIRATION_BATCH_SIZE,
  requireCompleteOrgCreditExpiration,
} from "./org-credit-expiration";

/** Bounded re-reads after a lost conditional clear before surfacing it. */
const ORG_CREDIT_EXPIRATION_CONFLICT_RETRIES = 3;

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
    let conflicts = 0;
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
      // No explicit row lock: each statement clears lots conditionally on
      // their observed versions and clamps the wallet with atomic arithmetic.
      // A short clear throws inside the transaction, rolling the clamp back,
      // and this loop reads the cohort again.
      const outcome = await settle(
        db.transaction(async (tx) => {
          const bounded = orgCreditExpirationOutcome(
            parseRawRows(
              orgCreditExpirationOutcomeRow,
              await tx.execute(
                boundedOrgCreditExpirationSql(args.orgId, args.at, ids),
              ),
            ),
          );
          if (!bounded.wallet) {
            return false;
          }
          if (bounded.omitted) {
            // Pre-R1 adders can add between partial clamps. Until those
            // writers have drained, the incomplete cohort must commit one full
            // clamp instead. The bounded statement changed nothing here.
            const atomic = orgCreditExpirationOutcome(
              parseRawRows(
                orgCreditExpirationOutcomeRow,
                await tx.execute(
                  atomicOrgCreditExpirationSql(args.orgId, args.at),
                ),
              ),
            );
            requireCompleteOrgCreditExpiration(args.orgId, atomic);
          } else {
            requireCompleteOrgCreditExpiration(args.orgId, bounded);
          }
          signal.throwIfAborted();
          return true;
        }),
        signal,
      );
      signal.throwIfAborted();
      if (!outcome.ok) {
        if (
          (outcome.error instanceof OrgCreditExpirationConflict ||
            safeSqlStateCode(outcome.error) === "40P01") &&
          conflicts < ORG_CREDIT_EXPIRATION_CONFLICT_RETRIES
        ) {
          conflicts += 1;
          continue;
        }
        throw outcome.error;
      }
      if (!outcome.value) {
        return;
      }
    }
  },
);
