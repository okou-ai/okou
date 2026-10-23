import type { DataSearchCreateRequest } from "@okouai/api-contracts/contracts/data-search";
import { dataSearchJobs } from "@okouai/db/schema/data-search-job";
import { socialDataJobs } from "@okouai/db/schema/social-data-job";
import type { usagePricing } from "@okouai/db/schema/usage-pricing";
import { and, eq, isNull, sql } from "drizzle-orm";
import { pgInt8ToSafeIntegerDecoder } from "../../lib/db-structured-result";
import type { AuthContext } from "../../types/auth";
import { creditPolicyRunId } from "./official-workflow-policy.service";
import type { ManagedUsageCreditCheckArgs } from "./managed-usage.service";
import type { DataSearchProviderQuote } from "./data-search-provider";
import { creditsFor } from "./social-data-pricing";

type Price = typeof usagePricing.$inferSelect;
export interface DataSearchAdmission {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly body: DataSearchCreateRequest;
  readonly estimate: DataSearchProviderQuote;
  readonly providerName: string;
}
export function dataReservationPlan(orgId: string) {
  return {
    columns: {
      credits:
        sql`COALESCE(sum(${dataSearchJobs.reservedCredits}),0)::bigint`.mapWith(
          pgInt8ToSafeIntegerDecoder,
        ),
      jobs: sql`count(*)::bigint`.mapWith(pgInt8ToSafeIntegerDecoder),
    },
    where: and(
      eq(dataSearchJobs.orgId, orgId),
      isNull(dataSearchJobs.creditsCharged),
    ),
  };
}
export function socialReservationPlan(orgId: string) {
  return {
    columns: {
      credits:
        sql`COALESCE(sum(${socialDataJobs.reservedCredits}),0)::bigint`.mapWith(
          pgInt8ToSafeIntegerDecoder,
        ),
    },
    where: and(
      eq(socialDataJobs.orgId, orgId),
      isNull(socialDataJobs.creditsCharged),
    ),
  };
}
export function dataAdmissionCreditArgs(
  args: DataSearchAdmission,
  price: Price,
  held: number,
): ManagedUsageCreditCheckArgs {
  const quantity = Math.max(1, args.estimate.estimatedCostUsdMicros);
  return {
    runId: creditPolicyRunId(args.auth),
    orgId: args.auth.orgId,
    userId: args.auth.userId,
    resource: {
      kind: "data-search",
      provider: args.providerName,
      category: "provider_cost_usd_micros",
      quantity,
    },
    label: "Data Search",
    reservedCredits:
      held +
      args.body.maxCredits -
      creditsFor(quantity, price.unitPrice, price.unitSize),
  };
}
export function dataAdmissionValues(args: DataSearchAdmission, price: Price) {
  return {
    orgId: args.auth.orgId,
    userId: args.auth.userId,
    requestId: args.body.requestId,
    billingRunId: creditPolicyRunId(args.auth) ?? null,
    capability: args.body.capability,
    request: args.body,
    plan: args.estimate.plan,
    providerName: args.providerName,
    providerEndpoint: args.estimate.plan.endpoint,
    estimatedCostUsdMicros: args.estimate.estimatedCostUsdMicros,
    unitPrice: price.unitPrice,
    unitSize: price.unitSize,
    maxCredits: args.body.maxCredits,
    reservedCredits: args.body.maxCredits,
  };
}
export function dataRequestConflictTarget() {
  return [
    dataSearchJobs.orgId,
    dataSearchJobs.userId,
    dataSearchJobs.requestId,
  ];
}
export function requireAdmissionValue<T>(value: T | undefined): T {
  if (!value) {
    throw new DataSearchAdmissionConflict();
  }
  return value;
}
export class DataSearchAdmissionConflict extends Error {}
