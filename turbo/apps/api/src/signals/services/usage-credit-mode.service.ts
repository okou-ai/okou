import type { CreditBillingMode } from "@okouai/db/schema/credit-billing-mode";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePackCreditDebtEntries } from "@okouai/db/schema/usage-pack-credit-debt";
import {
  usagePackAllocations,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import { and, eq, gt, lt, lte, or, sum } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  managedAttributionQuery,
  managedBillingRunQuery,
} from "./managed-usage-attribution";

interface MemberIdentity {
  readonly orgId: string;
  readonly userId: string;
}

/** Classify current admission, never historical consumption or settlement. */
export async function getMemberCreditBillingMode(
  db: Db,
  member: MemberIdentity,
  at = nowDate(),
): Promise<CreditBillingMode> {
  const [grants, debts, allocations] = await Promise.all([
    db
      .select({ id: usagePackCreditGrants.id })
      .from(usagePackCreditGrants)
      .where(
        and(
          eq(usagePackCreditGrants.orgId, member.orgId),
          eq(usagePackCreditGrants.userId, member.userId),
          or(
            gt(usagePackCreditGrants.expiresAt, at),
            lt(usagePackCreditGrants.remainingAmount, 0),
          ),
        ),
      )
      .limit(1),
    db
      .select({ orgId: usagePackCreditDebtEntries.orgId })
      .from(usagePackCreditDebtEntries)
      .where(
        and(
          eq(usagePackCreditDebtEntries.orgId, member.orgId),
          eq(usagePackCreditDebtEntries.userId, member.userId),
        ),
      )
      .groupBy(usagePackCreditDebtEntries.orgId)
      .having(gt(sum(usagePackCreditDebtEntries.amount), 0))
      .limit(1),
    db
      .select({ id: usagePackAllocations.id })
      .from(usagePackAllocations)
      .innerJoin(
        usagePackSubscriptions,
        eq(
          usagePackSubscriptions.id,
          usagePackAllocations.usagePackSubscriptionId,
        ),
      )
      .where(
        and(
          eq(usagePackAllocations.orgId, member.orgId),
          eq(usagePackAllocations.userId, member.userId),
          eq(usagePackAllocations.status, "active"),
          gt(usagePackAllocations.usagePackUsd, 0),
          lte(usagePackAllocations.currentPeriodStart, at),
          gt(usagePackAllocations.currentPeriodEnd, at),
          eq(usagePackSubscriptions.orgId, member.orgId),
          eq(usagePackSubscriptions.subscriptionStatus, "active"),
          lte(usagePackSubscriptions.currentPeriodStart, at),
          gt(usagePackSubscriptions.currentPeriodEnd, at),
        ),
      )
      .limit(1),
  ]);
  return grants.length || debts.length || allocations.length
    ? "member_pack"
    : "org";
}

/** A supplied Run is already admitted: retain its mode, including legacy NULL. */
export async function getAdmittedCreditBillingMode(
  db: Db,
  actor: MemberIdentity & { readonly runId?: string },
): Promise<CreditBillingMode | null> {
  if (!actor.runId) {
    return await getMemberCreditBillingMode(db, actor);
  }
  const [[run], [attribution]] = await Promise.all([
    db.select().from(managedBillingRunQuery(actor.runId)),
    db.select().from(managedAttributionQuery(actor.runId)),
  ]);
  const source = attribution ?? run;
  if (
    source &&
    (source.orgId !== actor.orgId || source.userId !== actor.userId)
  ) {
    throw new Error("Credit billing Run ownership does not match");
  }
  return source?.creditBillingMode ?? null;
}
