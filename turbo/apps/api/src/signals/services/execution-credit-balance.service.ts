import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { and, eq, gt, lte, sum } from "drizzle-orm";
import {
  nullableDriverValueDecoder,
  pgInt8ToSafeIntegerDecoder,
} from "../../lib/db-structured-result";
import type { RunOrgMetadata } from "./model-bootstrap.service";

export interface ExecutionCreditBalance {
  readonly spendableCredits: number;
  readonly usagePackCredits: number;
}

/** Pure query definitions; the owning computed executes both reads. */
export function executionCreditQueries(
  owner: { readonly orgId: string; readonly userId: string },
  at: Date,
) {
  return {
    expired: {
      fields: {
        total: sum(creditExpiresRecord.remaining).mapWith(
          nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder),
        ),
      },
      where: and(
        eq(creditExpiresRecord.orgId, owner.orgId),
        lte(creditExpiresRecord.expiresAt, at),
        gt(creditExpiresRecord.remaining, 0),
      ),
    },
    pack: {
      fields: {
        total: sum(usagePackCreditGrants.remainingAmount).mapWith(
          nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder),
        ),
      },
      where: and(
        eq(usagePackCreditGrants.orgId, owner.orgId),
        eq(usagePackCreditGrants.userId, owner.userId),
        gt(usagePackCreditGrants.remainingAmount, 0),
        gt(usagePackCreditGrants.expiresAt, at),
      ),
    },
  };
}

export function executionCreditBalance(
  org: RunOrgMetadata | null,
  expiredCredits: number,
  usagePackCredits: number,
): ExecutionCreditBalance | null {
  if (org && !Number.isSafeInteger(org.credits)) {
    throw new Error("Credit snapshot exceeds safe integer precision");
  }
  return org
    ? { spendableCredits: org.credits - expiredCredits, usagePackCredits }
    : null;
}
