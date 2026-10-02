import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { command } from "ccstate";
import { and, asc, eq, gt } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  grantPageAfter,
  grantPrefixForAmount,
  grantPrefixSelection,
  type PreparedUsageGrant,
  type PreparedUsageGrantPrefix,
  type UsageGrantFrontier,
} from "./usage-grant-prefix";

/** This read-only preparation pages outside any financial transaction. */
export const prepareUsageGrantPrefix$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly grossByUser: ReadonlyMap<string, number>;
    },
    signal: AbortSignal,
  ): Promise<PreparedUsageGrantPrefix> => {
    const db = set(writeDb$);
    const at = nowDate();
    const grants: PreparedUsageGrant[] = [];
    const frontiers: UsageGrantFrontier[] = [];
    const users = [...args.grossByUser].sort(([left], [right]) => {
      return left.localeCompare(right);
    });
    for (const [userId, gross] of users) {
      if (gross <= 0) {
        continue;
      }
      let remaining = gross;
      let last: PreparedUsageGrant | undefined;
      for (const grantType of ["purchased", "bonus"] as const) {
        let cursor: PreparedUsageGrant | undefined;
        while (remaining > 0) {
          const page = await db
            .select(grantPrefixSelection())
            .from(usagePackCreditGrants)
            .where(
              and(
                eq(usagePackCreditGrants.orgId, args.orgId),
                eq(usagePackCreditGrants.userId, userId),
                eq(usagePackCreditGrants.grantType, grantType),
                gt(usagePackCreditGrants.remainingAmount, 0),
                gt(usagePackCreditGrants.expiresAt, at),
                grantPageAfter(cursor),
              ),
            )
            .orderBy(
              asc(usagePackCreditGrants.expiresAt),
              asc(usagePackCreditGrants.id),
            )
            .limit(128);
          signal.throwIfAborted();
          const prefix = grantPrefixForAmount(page, remaining);
          grants.push(...prefix.grants);
          last = prefix.grants.at(-1) ?? last;
          remaining = prefix.remaining;
          cursor = page.at(-1);
          if (page.length < 128) {
            break;
          }
        }
      }
      frontiers.push({ userId, last: remaining <= 0 ? (last ?? null) : null });
    }
    return { grants, frontiers };
  },
);
