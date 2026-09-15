import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
} from "@okouai/db/schema/org-usage-allowance";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  sum,
} from "drizzle-orm";
import {
  pgInt8ToBigIntDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import type { Db } from "../external/db";
import { settle } from "../utils";
import type { PiMemoryQuotaDecision } from "./pi-memory-quota.service";
import {
  ACTIVE_ALLOWANCE_STATUSES,
  activeAllowanceCutoff,
} from "./usage-allowance.service";

function reserve(
  bucket: PiMemoryQuotaDecision["bucket"],
  original: bigint,
  remaining: bigint,
): PiMemoryQuotaDecision {
  if (original <= 0n || remaining < 0n || remaining > original) {
    return { decision: "unavailable", reason: "quota_unavailable", bucket };
  }
  const low = remaining * 4n < original;
  return {
    decision: low ? "denied" : "allowed",
    reason: low ? "quota_below_threshold" : "quota_available",
    bucket,
    // Display only. The threshold comparison above is lossless integer math.
    remainingPercent: Number((remaining * 10_000n) / original) / 100,
  };
}

async function allowanceReserves(
  db: Pick<Db, "select">,
  orgId: string,
  at: Date,
): Promise<PiMemoryQuotaDecision[]> {
  const [entitlement] = await db
    .select({
      id: orgUsageAllowanceEntitlements.id,
      status: orgUsageAllowanceEntitlements.status,
      effectiveAt: orgUsageAllowanceEntitlements.effectiveAt,
      expiresAt: orgUsageAllowanceEntitlements.expiresAt,
      subscriptionId: orgUsageAllowanceEntitlements.stripeSubscriptionId,
      short: sql`${orgUsageAllowanceEntitlements.shortWindowUnits}`.mapWith(
        pgInt8ToBigIntDecoder,
      ),
      weekly: sql`${orgUsageAllowanceEntitlements.weeklyWindowUnits}`.mapWith(
        pgInt8ToBigIntDecoder,
      ),
    })
    .from(orgUsageAllowanceEntitlements)
    .where(eq(orgUsageAllowanceEntitlements.orgId, orgId));
  if (
    !entitlement ||
    entitlement.effectiveAt > at ||
    !ACTIVE_ALLOWANCE_STATUSES.some((status) => {
      return status === entitlement.status;
    })
  ) {
    return [];
  }
  const expired = entitlement.expiresAt !== null && entitlement.expiresAt <= at;
  if (expired && !entitlement.subscriptionId) {
    return [];
  }
  if (
    entitlement.expiresAt &&
    entitlement.expiresAt <= activeAllowanceCutoff(entitlement.status, at)
  ) {
    // Ordinary admission owns external reconciliation. This reader never refreshes Stripe.
    return [{ decision: "unknown", reason: "entitlement_stale" }];
  }
  const results: PiMemoryQuotaDecision[] = [];
  for (const kind of ["short", "weekly"] as const) {
    // Match current entitlement identity and canonical issued-window time rules.
    // In payment grace, an expired entitlement has no applicable issued window.
    const [window] = expired
      ? []
      : await db
          .select({
            original: sql`${orgUsageAllowanceWindows.unitLimit}`.mapWith(
              pgInt8ToBigIntDecoder,
            ),
            consumed: sql`${orgUsageAllowanceWindows.consumedUnits}`.mapWith(
              pgInt8ToBigIntDecoder,
            ),
          })
          .from(orgUsageAllowanceWindows)
          .where(
            and(
              eq(orgUsageAllowanceWindows.orgId, orgId),
              eq(orgUsageAllowanceWindows.entitlementId, entitlement.id),
              eq(orgUsageAllowanceWindows.kind, kind),
              gte(orgUsageAllowanceWindows.startsAt, entitlement.effectiveAt),
              lte(orgUsageAllowanceWindows.startsAt, at),
              gt(orgUsageAllowanceWindows.expiresAt, at),
            ),
          )
          .orderBy(desc(orgUsageAllowanceWindows.startsAt))
          .limit(1);
    if (window && window.consumed < 0n) {
      results.push({
        decision: "unavailable",
        reason: "quota_unavailable",
        bucket: kind,
      });
    } else {
      const original = window?.original ?? entitlement[kind];
      const remaining = window
        ? window.consumed >= original
          ? 0n
          : original - window.consumed
        : original;
      results.push(reserve(kind, original, remaining));
    }
  }
  return results;
}

async function readBuiltinQuota(
  db: Db,
  owner: { readonly orgId: string; readonly userId: string },
  at: Date,
  signal: AbortSignal,
): Promise<PiMemoryQuotaDecision> {
  // Complete server-side pool: no positive-balance filter or client page limit.
  // The existing partial spendable index cannot cover depleted grants.
  const [pool] = await db
    .select({
      original: sum(usagePackCreditGrants.originalAmount),
      remaining: sum(usagePackCreditGrants.remainingAmount),
      invalid: sql`coalesce(bool_or(${or(
        isNull(usagePackCreditGrants.originalAmount),
        isNull(usagePackCreditGrants.remainingAmount),
        lte(usagePackCreditGrants.originalAmount, 0),
        lt(usagePackCreditGrants.remainingAmount, 0),
        gt(
          usagePackCreditGrants.remainingAmount,
          usagePackCreditGrants.originalAmount,
        ),
      )}), false)`.mapWith(pgBooleanDecoder),
    })
    .from(usagePackCreditGrants)
    .where(
      and(
        eq(usagePackCreditGrants.orgId, owner.orgId),
        eq(usagePackCreditGrants.userId, owner.userId),
        inArray(usagePackCreditGrants.grantType, ["purchased", "bonus"]),
        lte(usagePackCreditGrants.createdAt, at),
        gt(usagePackCreditGrants.expiresAt, at),
      ),
    );
  signal.throwIfAborted();
  if (!pool || pool.invalid) {
    return { decision: "unavailable", reason: "quota_unavailable" };
  }
  const decisions = await allowanceReserves(db, owner.orgId, at);
  signal.throwIfAborted();
  if (pool.original !== null || pool.remaining !== null) {
    if (
      pool.original === null ||
      pool.remaining === null ||
      !/^\d+$/u.test(pool.original) ||
      !/^\d+$/u.test(pool.remaining)
    ) {
      return { decision: "unavailable", reason: "quota_unavailable" };
    }
    decisions.push(
      reserve("member_pool", BigInt(pool.original), BigInt(pool.remaining)),
    );
  }
  const blocking =
    decisions.find((d) => {
      return d.decision === "unavailable";
    }) ??
    decisions.find((d) => {
      return d.decision === "denied";
    });
  if (blocking) {
    return blocking;
  }
  // Cash has no original-budget denominator, even alongside known healthy reserves.
  const limiting = decisions
    .filter((d) => {
      return d.remainingPercent !== undefined;
    })
    .sort((a, b) => {
      return (a.remainingPercent ?? 100) - (b.remainingPercent ?? 100);
    })[0];
  return {
    ...limiting,
    decision: "unknown",
    reason: decisions.some((d) => {
      return d.reason === "entitlement_stale";
    })
      ? "entitlement_stale"
      : "cash_percentage_unknown",
  };
}

export async function readPiMemoryBuiltinQuota(
  db: Db,
  owner: { readonly orgId: string; readonly userId: string },
  at: Date,
  signal: AbortSignal,
): Promise<PiMemoryQuotaDecision> {
  signal.throwIfAborted();
  const result = await settle(readBuiltinQuota(db, owner, at, signal), signal);
  return result.ok
    ? result.value
    : { decision: "unavailable", reason: "quota_unavailable" };
}
