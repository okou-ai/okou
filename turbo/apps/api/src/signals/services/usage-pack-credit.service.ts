import {
  usagePackCreditGrants,
  type UsagePackCreditGrantType,
} from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePackAllocations } from "@okouai/db/schema/usage-pack-subscription";
import { command } from "ccstate";
import { and, eq, gt, inArray, sql, sum } from "drizzle-orm";

import { pgInt8ToSafeIntegerDecoder } from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import type { UsagePackCreditRefundSource } from "./usage-pack-credit-refund.service";

export interface UsagePackCreditGrantArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly grantType: "purchased" | "bonus";
  readonly idempotencyKey: string;
  readonly amount: number;
  readonly expiresAt: Date;
  readonly refundSource?: UsagePackCreditRefundSource;
}

interface UsagePackCreditBalance {
  readonly totalCredits: number;
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
  readonly creditGrants: readonly {
    readonly id: string;
    readonly grantType: UsagePackCreditGrantType;
    readonly amount: number;
    readonly remaining: number;
    readonly createdAt: string;
    readonly expiresAt: string;
  }[];
}

interface UsagePackMemberCreditBalance extends UsagePackCreditBalance {
  readonly memberId: string;
}

interface UsagePackCreditGrantBalanceRow {
  readonly id: string;
  readonly grantType: UsagePackCreditGrantType;
  readonly amount: number;
  readonly remaining: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** Pure values and conflict identity; the financial owner executes the SQL. */
export function usagePackCreditGrantValues(args: UsagePackCreditGrantArgs) {
  return {
    orgId: args.orgId,
    userId: args.userId,
    grantType: args.grantType,
    idempotencyKey: args.idempotencyKey,
    originalAmount: args.amount,
    remainingAmount: args.amount,
    expiresAt: args.expiresAt,
  };
}

/** Callers check cancellation after the complete unsignalled admission phase. */
export const getSpendableUsagePackCredits$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly at: Date;
    },
  ): Promise<number> => {
    const db = get(db$);
    const at = args.at;
    const [row] = await db
      .select({
        total:
          sql`COALESCE(${sum(usagePackCreditGrants.remainingAmount)}, 0)::bigint`
            .mapWith(pgInt8ToSafeIntegerDecoder)
            .as("total"),
      })
      .from(usagePackCreditGrants)
      .where(
        and(
          eq(usagePackCreditGrants.orgId, args.orgId),
          eq(usagePackCreditGrants.userId, args.userId),
          gt(usagePackCreditGrants.remainingAmount, 0),
          gt(usagePackCreditGrants.expiresAt, at),
        ),
      );
    return row?.total ?? 0;
  },
);

export function activeUsagePackAllocationReadPlan(args: {
  readonly orgId: string;
  readonly userId?: string;
}) {
  return {
    columns: { id: usagePackAllocations.id },
    condition: and(
      eq(usagePackAllocations.orgId, args.orgId),
      args.userId === undefined
        ? undefined
        : eq(usagePackAllocations.userId, args.userId),
      inArray(usagePackAllocations.status, ["active", "pending_invitation"]),
    ),
  };
}

export function usagePackCreditBalanceFromRows(
  rows: readonly UsagePackCreditGrantBalanceRow[],
): UsagePackCreditBalance {
  const creditsByType: Record<UsagePackCreditGrantType, number> = {
    purchased: 0,
    bonus: 0,
  };
  for (const row of rows) {
    creditsByType[row.grantType] += row.remaining;
  }
  return {
    totalCredits: creditsByType.purchased + creditsByType.bonus,
    purchasedCredits: creditsByType.purchased,
    bonusCredits: creditsByType.bonus,
    creditGrants: rows.map((row) => {
      return {
        id: row.id,
        grantType: row.grantType,
        amount: row.amount,
        remaining: row.remaining,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      };
    }),
  };
}

export function usagePackCreditBalanceReadPlan(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly at: Date;
}) {
  return {
    columns: {
      id: usagePackCreditGrants.id,
      grantType: usagePackCreditGrants.grantType,
      amount: usagePackCreditGrants.originalAmount,
      remaining: usagePackCreditGrants.remainingAmount,
      createdAt: usagePackCreditGrants.createdAt,
      expiresAt: usagePackCreditGrants.expiresAt,
    },
    condition: and(
      eq(usagePackCreditGrants.orgId, args.orgId),
      eq(usagePackCreditGrants.userId, args.userId),
      gt(usagePackCreditGrants.remainingAmount, 0),
      gt(usagePackCreditGrants.expiresAt, args.at),
    ),
  };
}

export function organizationUsagePackCreditBalancesReadPlan(args: {
  readonly orgId: string;
  readonly at: Date;
}) {
  return {
    columns: {
      memberId: usagePackCreditGrants.userId,
      id: usagePackCreditGrants.id,
      grantType: usagePackCreditGrants.grantType,
      amount: usagePackCreditGrants.originalAmount,
      remaining: usagePackCreditGrants.remainingAmount,
      createdAt: usagePackCreditGrants.createdAt,
      expiresAt: usagePackCreditGrants.expiresAt,
    },
    condition: and(
      eq(usagePackCreditGrants.orgId, args.orgId),
      gt(usagePackCreditGrants.remainingAmount, 0),
      gt(usagePackCreditGrants.expiresAt, args.at),
    ),
  };
}

export function organizationUsagePackCreditBalancesFromRows(
  rows: readonly (UsagePackCreditGrantBalanceRow & {
    readonly memberId: string;
  })[],
): readonly UsagePackMemberCreditBalance[] {
  const rowsByMember = new Map<string, UsagePackCreditGrantBalanceRow[]>();
  for (const row of rows) {
    const memberRows = rowsByMember.get(row.memberId) ?? [];
    memberRows.push(row);
    rowsByMember.set(row.memberId, memberRows);
  }
  return Array.from(rowsByMember, ([memberId, memberRows]) => {
    return {
      memberId,
      ...usagePackCreditBalanceFromRows(memberRows),
    };
  });
}
