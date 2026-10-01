import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { pgTextDecoder } from "../../lib/db-structured-result";
import type { PricedUsageEvent } from "./credit-usage-pricing";
import type { PreparedSocialSettlement } from "./social-data-settlement-plan";
import { UsageSettlementSnapshotConflict } from "./credit-usage-batch";

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
    xmin: sql`${usagePackCreditGrants}.xmin::text`
      .mapWith(pgTextDecoder)
      .as("xmin"),
  };
}
export interface PreparedUsageGrant {
  readonly id: string;
  readonly userId: string;
  readonly grantType: "purchased" | "bonus";
  readonly remainingAmount: number;
  readonly expiresAt: Date;
  readonly expiresText: string;
  readonly xmin: string;
}
export interface UsageGrantFrontier {
  readonly userId: string;
  readonly last: PreparedUsageGrant | null;
}
export interface PreparedUsageGrantPrefix {
  readonly grants: readonly PreparedUsageGrant[];
  readonly frontiers: readonly UsageGrantFrontier[];
}
/** Selects the real credit prefix; no cap may discard spendable credits. */
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

/** Current allowance can only reduce the prepared gross charge. */
export function requiredUsageGrantPrefix(
  prepared: PreparedUsageGrantPrefix,
  charges: ReadonlyMap<string, number>,
): PreparedUsageGrantPrefix {
  const grants: PreparedUsageGrant[] = [];
  const frontiers: UsageGrantFrontier[] = [];
  for (const { userId } of prepared.frontiers) {
    const amount = charges.get(userId) ?? 0;
    if (amount <= 0) {
      continue;
    }
    const prefix = grantPrefixForAmount(
      prepared.grants.filter((grant) => {
        return grant.userId === userId;
      }),
      amount,
    );
    grants.push(...prefix.grants);
    frontiers.push({
      userId,
      last: prefix.remaining <= 0 ? (prefix.grants.at(-1) ?? null) : null,
    });
  }
  return { grants, frontiers };
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
/**
 * Plain read of the prepared prefix. It only rejects an obviously stale
 * prefix early; the authority is the conditional decrement in
 * memberGrantDeductionsSql, which requires each row's observed xmin.
 */
export function preparedMemberGrantsQuery(
  orgId: string,
  prefix: PreparedUsageGrantPrefix,
  at: Date,
) {
  return new QueryBuilder()
    .select(grantPrefixSelection())
    .from(usagePackCreditGrants)
    .where(
      and(
        eq(usagePackCreditGrants.orgId, orgId),
        inArray(
          usagePackCreditGrants.id,
          prefix.grants.map((grant) => {
            return grant.id;
          }),
        ),
        gt(usagePackCreditGrants.remainingAmount, 0),
        gt(usagePackCreditGrants.expiresAt, at),
      ),
    )
    .orderBy(
      asc(usagePackCreditGrants.userId),
      sql`CASE ${usagePackCreditGrants.grantType} WHEN 'purchased' THEN 0 ELSE 1 END`,
      asc(usagePackCreditGrants.expiresAt),
      asc(usagePackCreditGrants.id),
    )
    .as("prepared_usage_grants");
}
function frontierWhere(frontier: UsageGrantFrontier) {
  const last = frontier.last;
  return and(
    eq(usagePackCreditGrants.userId, frontier.userId),
    last
      ? or(
          last.grantType === "bonus"
            ? eq(usagePackCreditGrants.grantType, "purchased")
            : undefined,
          and(
            eq(usagePackCreditGrants.grantType, last.grantType),
            or(
              lt(
                usagePackCreditGrants.expiresAt,
                sql`${last.expiresText}::timestamp`,
              ),
              and(
                eq(
                  usagePackCreditGrants.expiresAt,
                  sql`${last.expiresText}::timestamp`,
                ),
                lt(usagePackCreditGrants.id, last.id),
              ),
            ),
          ),
        )
      : undefined,
  );
}
export function unseenGrantPrefixQuery(
  orgId: string,
  prefix: PreparedUsageGrantPrefix,
  at: Date,
) {
  return new QueryBuilder()
    .select({ id: usagePackCreditGrants.id })
    .from(usagePackCreditGrants)
    .where(
      and(
        eq(usagePackCreditGrants.orgId, orgId),
        gt(usagePackCreditGrants.remainingAmount, 0),
        gt(usagePackCreditGrants.expiresAt, at),
        notInArray(
          usagePackCreditGrants.id,
          prefix.grants.map((grant) => {
            return grant.id;
          }),
        ),
        or(...prefix.frontiers.map(frontierWhere)) ?? sql`false`,
      ),
    )
    .limit(1)
    .as("unseen_usage_grant");
}
export function requireCurrentGrantPrefix(
  prefix: PreparedUsageGrantPrefix,
  rows: readonly PreparedUsageGrant[],
  unseen: { id: string } | undefined,
) {
  const current = new Map(
    rows.map((row) => {
      return [row.id, row.xmin];
    }),
  );
  if (
    unseen ||
    rows.length !== prefix.grants.length ||
    prefix.grants.some((row) => {
      return current.get(row.id) !== row.xmin;
    })
  ) {
    throw new UsageSettlementSnapshotConflict(
      "Usage grant prefix changed during preparation",
    );
  }
}
