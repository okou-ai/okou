import type {
  SocialDataCreateRequest,
  SocialDataRequest,
} from "@okouai/api-contracts/contracts/social-data";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { and, eq, gt, isNull, lte, sql, sum } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  nullableDriverValueDecoder,
  pgInt8ToBigIntDecoder,
  pgInt8ToSafeIntegerDecoder,
} from "../../lib/db-structured-result";
import type { AuthContext } from "../../types/auth";
import {
  closedOfficialRun,
  estimatedCredits,
  insufficientCredits,
  pricingNotConfigured,
  type ManagedUsageCreditCheckArgs,
  type ManagedUsageErrorResponse,
} from "./managed-usage.service";
import {
  creditPolicyRunId,
  officialWorkflowCreditAccessSql,
} from "./official-workflow-policy.service";
import { orgPlanCapabilitiesFromRow } from "./org-plan-entitlement-read.service";
import type { SocialDataProviderQuote } from "./social-data-provider";
import type { SocialDataProviderPlan } from "./social-data-provider-catalog";
import { SocialDataProviderError } from "./social-data-provider-error";
import { creditsFor } from "./social-data-pricing";
import type { ErrorResponse } from "./social-data.service";

type Actor = AuthContext & { readonly orgId: string };
type Pricing = typeof usagePricing.$inferSelect;
type Budget = ReturnType<typeof socialAdmissionBudget>;

export function socialPricingWhere(platform: SocialDataRequest["platform"]) {
  return and(
    eq(usagePricing.kind, "social"),
    eq(usagePricing.provider, `monid/${platform}`),
    eq(usagePricing.category, "provider_cost_usd_micros"),
  );
}

export function requireSocialPricing(pricing: Pricing | undefined): Pricing {
  if (!pricing) {
    throw new SocialDataProviderError(
      "PRICING_NOT_CONFIGURED",
      "Social data pricing is unavailable.",
      503,
    );
  }
  return pricing;
}

export function socialAdmissionBudget(
  body: SocialDataCreateRequest,
  estimate: SocialDataProviderQuote,
  pricing: Pricing,
) {
  const estimated = creditsFor(
    estimate.estimatedCostUsdMicros,
    pricing.unitPrice,
    pricing.unitSize,
  );
  return {
    estimatedCredits: estimated,
    maxCredits: body.maxCredits ?? estimated,
    unitPrice: pricing.unitPrice,
    unitSize: pricing.unitSize,
  };
}

export function socialAdmissionValues(
  args: {
    readonly auth: Actor;
    readonly body: SocialDataCreateRequest;
    readonly plan: SocialDataProviderPlan;
    readonly estimate: SocialDataProviderQuote;
    readonly source?: typeof socialDataJobs.$inferSelect;
  },
  budget: Budget,
) {
  return {
    orgId: args.auth.orgId,
    userId: args.auth.userId,
    requestId: args.body.requestId,
    billingRunId:
      args.auth.tokenType === "agent" || args.auth.tokenType === "sandbox"
        ? args.auth.runId
        : null,
    platform: args.body.platform,
    operation: args.body.operation,
    request: args.body,
    providerName: args.plan.provider,
    providerEndpoint: args.plan.endpoint,
    sourceJobId: args.source?.id,
    providerCursor: args.plan.cursor,
    collectionProgress: args.source?.collectionProgress,
    estimatedCostUsdMicros: args.estimate.estimatedCostUsdMicros,
    unitPrice: budget.unitPrice,
    unitSize: budget.unitSize,
    maxCredits: budget.maxCredits,
    reservedCredits: budget.maxCredits,
  };
}

export function socialBudgetExceeded(): ErrorResponse {
  return {
    status: 402,
    body: {
      error: {
        code: "BUDGET_EXCEEDED",
        message:
          "The estimated Social data cost exceeds --max-credits. Reduce the result limit or raise the budget.",
      },
    },
  };
}

export function socialCapacityExceeded(): ErrorResponse {
  return {
    status: 429,
    body: {
      error: {
        code: "SOCIAL_DATA_CAPACITY",
        message: "Wait for existing Social data jobs to finish.",
      },
    },
  };
}

export function socialReservationPlan(orgId: string) {
  return {
    columns: {
      credits:
        sql`COALESCE(sum(${socialDataJobs.reservedCredits}), 0)::bigint`.mapWith(
          pgInt8ToSafeIntegerDecoder,
        ),
      jobs: sql`count(*)::bigint`.mapWith(pgInt8ToSafeIntegerDecoder),
    },
    where: and(
      eq(socialDataJobs.orgId, orgId),
      isNull(socialDataJobs.creditsCharged),
    ),
  };
}

export function socialCreditCheckArgs(
  auth: Actor,
  request: SocialDataRequest,
  estimate: SocialDataProviderQuote,
  budget: Budget,
  reservation: { readonly credits: number } | undefined,
): ManagedUsageCreditCheckArgs {
  return {
    runId: creditPolicyRunId(auth),
    orgId: auth.orgId,
    userId: auth.userId,
    resource: {
      kind: "social",
      provider: `monid/${request.platform}`,
      category: "provider_cost_usd_micros",
      quantity: Math.max(1, estimate.estimatedCostUsdMicros),
    },
    label: "Okou Social",
    reservedCredits:
      (reservation?.credits ?? 0) + budget.maxCredits - budget.estimatedCredits,
  };
}

/** A sessionless read plan; the admission owner executes the unchanged CTE. */
export function managedSnapshotPlan(args: ManagedUsageCreditCheckArgs) {
  const builder = new QueryBuilder();
  const expired = builder.$with("expired").as(
    builder
      .select({
        total: sql`COALESCE(${sum(creditExpiresRecord.remaining)}, 0)::bigint`
          .mapWith(pgInt8ToBigIntDecoder)
          .as("expired_total"),
      })
      .from(creditExpiresRecord)
      .where(
        and(
          eq(creditExpiresRecord.orgId, args.orgId),
          lte(creditExpiresRecord.expiresAt, sql`now()`),
          gt(creditExpiresRecord.remaining, sql`0`),
        ),
      ),
  );
  return {
    expired,
    columns: {
      officialCreditAccess: officialWorkflowCreditAccessSql(args),
      credits: sql`${orgMetadata.credits}`.mapWith(
        nullableDriverValueDecoder(pgInt8ToBigIntDecoder),
      ),
      unsettledExpired: expired.total,
      unitPrice: sql`${usagePricing.unitPrice}`.mapWith(
        nullableDriverValueDecoder(pgInt8ToBigIntDecoder),
      ),
      unitSize: sql`${usagePricing.unitSize}`.mapWith(
        nullableDriverValueDecoder(pgInt8ToBigIntDecoder),
      ),
    },
    orgWhere: eq(orgMetadata.orgId, args.orgId),
    pricingWhere: and(
      eq(usagePricing.kind, args.resource.kind),
      eq(usagePricing.provider, args.resource.provider),
      eq(usagePricing.category, args.resource.category),
    ),
  };
}

interface ManagedSnapshot {
  readonly unitPrice: bigint | null;
  readonly unitSize: bigint | null;
  readonly credits: bigint | null;
  readonly unsettledExpired: bigint;
  readonly officialCreditAccess: string;
}

export function managedSnapshotRequirement(
  row: ManagedSnapshot | undefined,
  args: ManagedUsageCreditCheckArgs,
):
  | {
      readonly row: ManagedSnapshot;
      readonly required: bigint;
      readonly spendable: bigint;
    }
  | ManagedUsageErrorResponse {
  if (row?.unitPrice === null || row?.unitSize === null) {
    return pricingNotConfigured(args.label);
  }
  if (!row || row.credits === null) {
    return insufficientCredits();
  }
  return {
    row,
    required:
      estimatedCredits(
        row.unitPrice,
        row.unitSize,
        args.resource.quantity ?? 1,
      ) + BigInt(args.reservedCredits ?? 0),
    spendable: row.credits - row.unsettledExpired,
  };
}

export function managedSnapshotAccess(
  row: ManagedSnapshot,
  capabilities: Parameters<typeof orgPlanCapabilitiesFromRow>[0] | undefined,
  orgId: string,
): "paid" | "free" | ManagedUsageErrorResponse {
  const plan = capabilities
    ? orgPlanCapabilitiesFromRow(capabilities, orgId)
    : null;
  if (!plan || plan.status !== "active") {
    return insufficientCredits();
  }
  if (row.officialCreditAccess === "closed") {
    return closedOfficialRun();
  }
  return row.officialCreditAccess === "free" ? "free" : "paid";
}

export function memberCreditPlan(args: ManagedUsageCreditCheckArgs, at: Date) {
  return {
    columns: {
      total:
        sql`COALESCE(${sum(usagePackCreditGrants.remainingAmount)}, 0)::bigint`
          .mapWith(pgInt8ToSafeIntegerDecoder)
          .as("total"),
    },
    where: and(
      eq(usagePackCreditGrants.orgId, args.orgId),
      eq(usagePackCreditGrants.userId, args.userId),
      gt(usagePackCreditGrants.remainingAmount, 0),
      gt(usagePackCreditGrants.expiresAt, at),
    ),
  };
}

export function hasManagedSnapshotCredits(
  requirement: { readonly required: bigint; readonly spendable: bigint },
  member: { readonly total: number } | undefined,
) {
  return (
    BigInt(member?.total ?? 0) +
      (requirement.spendable > 0n ? requirement.spendable : 0n) >=
    requirement.required
  );
}
