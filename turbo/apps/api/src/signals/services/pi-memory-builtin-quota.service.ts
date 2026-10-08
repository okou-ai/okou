import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  sum,
} from "drizzle-orm";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import type { Db } from "../external/db";
import { settle } from "../utils";
import type { PiMemoryQuotaDecision } from "./pi-memory-quota.service";

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
  let memberPool: PiMemoryQuotaDecision | undefined;
  if (pool.original !== null || pool.remaining !== null) {
    if (
      pool.original === null ||
      pool.remaining === null ||
      !/^\d+$/u.test(pool.original) ||
      !/^\d+$/u.test(pool.remaining)
    ) {
      return { decision: "unavailable", reason: "quota_unavailable" };
    }
    memberPool = reserve(
      "member_pool",
      BigInt(pool.original),
      BigInt(pool.remaining),
    );
  }
  if (
    memberPool?.decision === "unavailable" ||
    memberPool?.decision === "denied"
  ) {
    return memberPool;
  }
  // Cash has no original-budget denominator, even alongside a healthy member pool.
  return {
    ...memberPool,
    decision: "unknown",
    reason: "cash_percentage_unknown",
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
