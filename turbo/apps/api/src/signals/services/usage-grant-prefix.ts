import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { and, eq, gt, or, sql } from "drizzle-orm";
import { pgTextDecoder } from "../../lib/db-structured-result";
import type { PricedUsageEvent } from "./credit-usage-pricing";
import type { PreparedSocialSettlement } from "./social-data-settlement-plan";

export function grantPrefixSelection() {
  return {
    id: usagePackCreditGrants.id,
    userId: usagePackCreditGrants.userId,
    grantType: usagePackCreditGrants.grantType,
    remainingAmount: usagePackCreditGrants.remainingAmount,
    expiresAt: usagePackCreditGrants.expiresAt,
    expiresText: sql`${usagePackCreditGrants.expiresAt}::text`
      .mapWith(pgTextDecoder)
      .as("expires_text"),
  };
}
export interface PreparedUsageGrant {
  readonly id: string;
  readonly userId: string;
  readonly grantType: "purchased" | "bonus";
  readonly remainingAmount: number;
  readonly expiresAt: Date;
  readonly expiresText: string;
}
export interface PreparedUsageGrantPrefix {
  readonly grants: readonly PreparedUsageGrant[];
}
/** Prepare enough spendable credits, preserving source priority and FEFO. */
export function grantPrefixForAmount(
  grants: readonly PreparedUsageGrant[],
  amount: number,
) {
  let remaining = amount;
  const selected: PreparedUsageGrant[] = [];
  for (const grant of grants) {
    if (remaining <= 0) {
      break;
    }
    selected.push(grant);
    remaining -= grant.remainingAmount;
  }
  return { grants: selected, remaining };
}
export function grantPageAfter(cursor: PreparedUsageGrant | undefined) {
  return cursor
    ? or(
        gt(
          usagePackCreditGrants.expiresAt,
          sql`${cursor.expiresText}::timestamp`,
        ),
        and(
          eq(
            usagePackCreditGrants.expiresAt,
            sql`${cursor.expiresText}::timestamp`,
          ),
          gt(usagePackCreditGrants.id, cursor.id),
        ),
      )
    : undefined;
}
export function usageGrossByUser(
  priced: readonly PricedUsageEvent[],
  social: PreparedSocialSettlement | undefined,
) {
  const result = new Map<string, number>();
  if (social) {
    const userId = social.plan.usage?.actor.userId;
    if (userId && social.grossCredits > 0) {
      result.set(userId, social.grossCredits);
    }
    return result;
  }
  for (const event of priced) {
    result.set(
      event.record.userId,
      (result.get(event.record.userId) ?? 0) + event.grossCredits,
    );
  }
  return result;
}
