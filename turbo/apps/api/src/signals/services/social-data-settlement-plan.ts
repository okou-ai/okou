import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { and, eq } from "drizzle-orm";
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
export function socialJobQuery(orgId: string, claim: SocialSettlementClaim) {
  return new QueryBuilder()
    .select()
    .from(socialDataJobs)
    .where(and(eq(socialDataJobs.orgId, orgId), socialWhere(claim)))
    .for("update")
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
