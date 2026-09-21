import {
  usagePackCreditGrants,
  type UsagePackCreditGrantType,
} from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePackAllocations } from "@okouai/db/schema/usage-pack-subscription";
import { and, desc, eq, gt, inArray, sql, sum } from "drizzle-orm";

import { pgInt8ToSafeIntegerDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  ensureUsagePackCreditRefundSource,
  type UsagePackCreditRefundSource,
} from "./usage-pack-credit-refund.service";

/**
 * Stripe advances a subscription period at the billing boundary but finalizes
 * and pays the cycle invoice afterwards, and `invoice.paid` is the only entry
 * point that issues the next period's grants. An expiry pinned to the period
 * end therefore strands paid members between the two, from minutes on a prompt
 * renewal to days while a failed payment is retried. Matches the payment
 * failure grace already used by usage allowance, paid concurrency, and plan
 * downgrade.
 */
const USAGE_PACK_GRANT_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Expiry for a member grant bought for a billing period ending at `periodEnd`.
 *
 * Settlement spends purchased grants by ascending expiry, so a carried-over
 * grant is consumed before the grant that replaces it.
 */
export function usagePackGrantExpiresAt(periodEnd: Date): Date {
  return new Date(periodEnd.getTime() + USAGE_PACK_GRANT_GRACE_MS);
}

interface UsagePackCreditGrantArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly grantType: "purchased" | "bonus";
  readonly idempotencyKey: string;
  readonly amount: number;
  readonly expiresAt: Date;
  readonly refundSource?: UsagePackCreditRefundSource;
}

interface UsagePackCreditGrantResult {
  readonly id: string;
  readonly created: boolean;
}

type UsagePackCreditGrantStore = Pick<Db, "insert" | "select">;

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

export async function createUsagePackCreditGrant(
  db: UsagePackCreditGrantStore,
  args: UsagePackCreditGrantArgs,
): Promise<UsagePackCreditGrantResult> {
  // Fulfillment is intentionally independent of the enrollment feature switch:
  // an already-paid subscription must still be safe to fulfill after rollout closes.
  const [inserted] = await db
    .insert(usagePackCreditGrants)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      grantType: args.grantType,
      idempotencyKey: args.idempotencyKey,
      originalAmount: args.amount,
      remainingAmount: args.amount,
      expiresAt: args.expiresAt,
    })
    .onConflictDoNothing({ target: usagePackCreditGrants.idempotencyKey })
    .returning({ id: usagePackCreditGrants.id });
  if (inserted) {
    if (args.refundSource) {
      if (args.grantType !== "purchased") {
        throw new Error("Bonus usage pack credits cannot have a refund source");
      }
      await ensureUsagePackCreditRefundSource(db, {
        creditGrantId: inserted.id,
        orgId: args.orgId,
        userId: args.userId,
        source: args.refundSource,
      });
    }
    return { id: inserted.id, created: true };
  }

  const [existing] = await db
    .select({
      id: usagePackCreditGrants.id,
      orgId: usagePackCreditGrants.orgId,
      userId: usagePackCreditGrants.userId,
      grantType: usagePackCreditGrants.grantType,
      originalAmount: usagePackCreditGrants.originalAmount,
      expiresAt: usagePackCreditGrants.expiresAt,
    })
    .from(usagePackCreditGrants)
    .where(eq(usagePackCreditGrants.idempotencyKey, args.idempotencyKey))
    .limit(1);
  if (
    !existing ||
    existing.orgId !== args.orgId ||
    existing.userId !== args.userId ||
    existing.grantType !== args.grantType ||
    existing.originalAmount !== args.amount ||
    existing.expiresAt.getTime() !== args.expiresAt.getTime()
  ) {
    throw new Error("Usage pack credit grant idempotency key conflict");
  }
  if (args.refundSource) {
    if (args.grantType !== "purchased") {
      throw new Error("Bonus usage pack credits cannot have a refund source");
    }
    await ensureUsagePackCreditRefundSource(db, {
      creditGrantId: existing.id,
      orgId: args.orgId,
      userId: args.userId,
      source: args.refundSource,
    });
  }
  return { id: existing.id, created: false };
}

export async function getSpendableUsagePackCredits(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly at?: Date;
  },
): Promise<number> {
  const at = args.at ?? nowDate();
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
}

export async function hasActiveUsagePackAllocation(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId?: string;
  },
): Promise<boolean> {
  const [allocation] = await db
    .select({ id: usagePackAllocations.id })
    .from(usagePackAllocations)
    .where(
      and(
        eq(usagePackAllocations.orgId, args.orgId),
        args.userId === undefined
          ? undefined
          : eq(usagePackAllocations.userId, args.userId),
        inArray(usagePackAllocations.status, ["active", "pending_invitation"]),
      ),
    )
    .limit(1);
  return allocation !== undefined;
}

function usagePackCreditBalanceFromRows(
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

export async function getUsagePackCreditBalance(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly at?: Date;
  },
): Promise<UsagePackCreditBalance> {
  const at = args.at ?? nowDate();
  const rows = await db
    .select({
      id: usagePackCreditGrants.id,
      grantType: usagePackCreditGrants.grantType,
      amount: usagePackCreditGrants.originalAmount,
      remaining: usagePackCreditGrants.remainingAmount,
      createdAt: usagePackCreditGrants.createdAt,
      expiresAt: usagePackCreditGrants.expiresAt,
    })
    .from(usagePackCreditGrants)
    .where(
      and(
        eq(usagePackCreditGrants.orgId, args.orgId),
        eq(usagePackCreditGrants.userId, args.userId),
        gt(usagePackCreditGrants.remainingAmount, 0),
        gt(usagePackCreditGrants.expiresAt, at),
      ),
    )
    .orderBy(desc(usagePackCreditGrants.createdAt));
  return usagePackCreditBalanceFromRows(rows);
}

export async function getOrganizationUsagePackCreditBalances(
  db: Pick<Db, "select">,
  args: {
    readonly orgId: string;
    readonly at?: Date;
  },
): Promise<readonly UsagePackMemberCreditBalance[]> {
  const at = args.at ?? nowDate();
  const rows = await db
    .select({
      memberId: usagePackCreditGrants.userId,
      id: usagePackCreditGrants.id,
      grantType: usagePackCreditGrants.grantType,
      amount: usagePackCreditGrants.originalAmount,
      remaining: usagePackCreditGrants.remainingAmount,
      createdAt: usagePackCreditGrants.createdAt,
      expiresAt: usagePackCreditGrants.expiresAt,
    })
    .from(usagePackCreditGrants)
    .where(
      and(
        eq(usagePackCreditGrants.orgId, args.orgId),
        gt(usagePackCreditGrants.remainingAmount, 0),
        gt(usagePackCreditGrants.expiresAt, at),
      ),
    )
    .orderBy(
      usagePackCreditGrants.userId,
      desc(usagePackCreditGrants.createdAt),
    );

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
