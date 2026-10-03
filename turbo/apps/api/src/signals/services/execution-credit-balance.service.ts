import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { computed, type Computed } from "ccstate";
import { and, eq, gt, lte, sum } from "drizzle-orm";
import {
  nullableDriverValueDecoder,
  pgInt8ToSafeIntegerDecoder,
} from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import type { RunOrgMetadata } from "./model-bootstrap.service";

export interface ExecutionCreditBalance {
  readonly spendableCredits: number;
  readonly usagePackCredits: number;
}

/** One approved read-only credit snapshot per organization/member identity. */
export function createExecutionCreditBalance(
  owner: { readonly orgId: string; readonly userId: string },
  orgMetadata$: Computed<Promise<RunOrgMetadata | null>>,
): Computed<Promise<ExecutionCreditBalance | null>> {
  return computed(async (get) => {
    const db = get(db$);
    const at = nowDate();
    const [org, [expired], [pack]] = await Promise.all([
      get(orgMetadata$),
      db
        .select({
          total: sum(creditExpiresRecord.remaining).mapWith(
            nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder),
          ),
        })
        .from(creditExpiresRecord)
        .where(
          and(
            eq(creditExpiresRecord.orgId, owner.orgId),
            lte(creditExpiresRecord.expiresAt, at),
            gt(creditExpiresRecord.remaining, 0),
          ),
        ),
      db
        .select({
          total: sum(usagePackCreditGrants.remainingAmount).mapWith(
            nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder),
          ),
        })
        .from(usagePackCreditGrants)
        .where(
          and(
            eq(usagePackCreditGrants.orgId, owner.orgId),
            eq(usagePackCreditGrants.userId, owner.userId),
            gt(usagePackCreditGrants.remainingAmount, 0),
            gt(usagePackCreditGrants.expiresAt, at),
          ),
        ),
    ]);
    if (org && !Number.isSafeInteger(org.credits)) {
      throw new Error("Credit snapshot exceeds safe integer precision");
    }
    return org
      ? {
          spendableCredits: org.credits - (expired?.total ?? 0),
          usagePackCredits: pack?.total ?? 0,
        }
      : null;
  });
}
