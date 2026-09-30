import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { UsageSettlementSnapshotConflict } from "./credit-usage-batch";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  managedUsageReceiptCredits,
  type ManagedUsageRecordArgs,
} from "./managed-usage-record";

type Job = typeof socialDataJobs.$inferSelect;
export interface SocialSettlementClaim {
  readonly jobId: string;
  readonly expiresAt: Date;
}
export function socialWhere(claim: SocialSettlementClaim) {
  return and(
    eq(socialDataJobs.id, claim.jobId),
    eq(socialDataJobs.claimExpiresAt, claim.expiresAt),
  );
}
/** The claimed job is still the unsettled version this settlement read. */
export function socialSettledWhere(
  claim: SocialSettlementClaim,
  job: { readonly xmin: string },
) {
  return and(
    socialWhere(claim),
    isNull(socialDataJobs.creditsCharged),
    sql`${socialDataJobs}.xmin::text = ${job.xmin}`,
  );
}

export function requireSocialSettlement(updated: number) {
  if (updated !== 1) {
    throw new UsageSettlementSnapshotConflict(
      "Social settlement changed before its charge was recorded",
    );
  }
}

export function socialJobSelection() {
  return {
    ...getTableColumns(socialDataJobs),
    xmin: sql`${socialDataJobs}.xmin::text`.mapWith(pgTextDecoder).as("xmin"),
  };
}
/**
 * Plain read. The settling transaction's final job write is conditional on
 * this row version and an unsettled charge (socialSettledWhere); a zero-row
 * result rejects the snapshot and rolls the whole settlement back.
 */
export function socialJobQuery(orgId: string, claim: SocialSettlementClaim) {
  return new QueryBuilder()
    .select(socialJobSelection())
    .from(socialDataJobs)
    .where(and(eq(socialDataJobs.orgId, orgId), socialWhere(claim)))
    .as("settlement_social_job");
}
function socialUsageArgs(
  job: Job | undefined,
): ManagedUsageRecordArgs | undefined {
  if (!job) {
    return undefined;
  }
  if (job.actualCostUsdMicros === null) {
    throw new Error("Completed Social data job has no settlement cost");
  }
  if (job.actualCostUsdMicros === 0 || job.maxCredits === 0) {
    return undefined;
  }
  return {
    actor: {
      orgId: job.orgId,
      userId: job.userId,
      ...(job.billingRunId ? { runId: job.billingRunId } : {}),
    },
    resource: {
      kind: "social",
      provider: `monid/${job.platform}`,
      category: "provider_cost_usd_micros",
      quantity: job.actualCostUsdMicros,
    },
    label: "Okou Social",
    idempotencyKey: job.usageIdempotencyKey,
    pricingSnapshot: {
      unitPrice: job.unitPrice,
      unitSize: job.unitSize,
      creditsLimit: job.maxCredits,
    },
  };
}
export function socialValues(
  args: ManagedUsageRecordArgs | undefined,
  receipt: typeof usageEvent.$inferSelect | undefined,
  at: Date,
) {
  return {
    creditsCharged: args ? managedUsageReceiptCredits(args, receipt) : 0,
    reservedCredits: 0,
    completedAt: at,
    updatedAt: at,
  };
}

export function socialClaimUnavailable(
  claim: SocialSettlementClaim | undefined,
  job: Job | undefined,
) {
  return claim !== undefined && (!job || job.creditsCharged !== null);
}

export function socialSettlementPlan(job: Job | undefined) {
  const usage = socialUsageArgs(job);
  return { usage, processPending: job === undefined || usage !== undefined };
}

export interface PreparedSocialSettlement {
  readonly jobId: string;
  readonly xmin: string;
  readonly plan: ReturnType<typeof socialSettlementPlan>;
  readonly grossCredits: number;
}
export function prepareSocialSettlement(
  job: (Job & { readonly xmin: string }) | undefined,
): PreparedSocialSettlement | undefined {
  if (!job || job.creditsCharged !== null) {
    return undefined;
  }
  const plan = socialSettlementPlan(job);
  const price = plan.usage?.pricingSnapshot;
  const quantity = BigInt(plan.usage?.resource.quantity ?? 0);
  const credits = price
    ? (quantity * BigInt(price.unitPrice) + BigInt(price.unitSize) - 1n) /
      BigInt(price.unitSize)
    : 0n;
  return {
    jobId: job.id,
    xmin: job.xmin,
    plan,
    grossCredits: price
      ? Number(
          credits < BigInt(price.creditsLimit)
            ? credits
            : BigInt(price.creditsLimit),
        )
      : 0,
  };
}
export function socialPlan(
  prepared: PreparedSocialSettlement | undefined,
  job: (Job & { readonly xmin: string }) | undefined,
) {
  if (!job) {
    return socialSettlementPlan(undefined);
  }
  if (!prepared || prepared.jobId !== job.id || prepared.xmin !== job.xmin) {
    throw new UsageSettlementSnapshotConflict(
      "Social settlement changed during preparation",
    );
  }
  return prepared.plan;
}
