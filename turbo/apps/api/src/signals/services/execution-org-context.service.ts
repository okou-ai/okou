import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { eq, sql, sum } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { boolean, number, object, string, unknown as zUnknown } from "zod";
import { pgInt8ToSafeIntegerSchema } from "../../lib/db-raw-rows";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import { executionCreditQueries } from "./execution-credit-balance.service";
import { activeConcurrencySubscriptionPredicate } from "./org-concurrency-entitlements.service";
import {
  orgPlanCapabilitiesFromRow,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";

const rawDecoder = zodDriverValueDecoder(zUnknown());
const metadataSchema = object({
  credits: number(),
  openrouterPreset: string().nullable(),
});
export type ExecutionOrgPlan = Pick<
  OrgPlanCapabilities,
  | "planKey"
  | "status"
  | "baseConcurrencyLimit"
  | "canBuyCredits"
  | "restrictedBuiltInModels"
>;

const planSchema = object({
  planKey: string(),
  status: string(),
  baseConcurrencyLimit: number(),
  canBuyCredits: boolean(),
  restrictedBuiltInModels: boolean().nullable(),
});
/**
 * Transport only: business decoding belongs to independent derived consumers.
 */
export function executionOrgQuery(orgId: string, at: Date) {
  const expired = executionCreditQueries({ orgId, userId: "" }, at).expired;
  const builder = new QueryBuilder();
  const slots = builder
    .select({
      value: sql`${sum(orgConcurrencySubscriptions.slots)}::text`.mapWith(
        rawDecoder,
      ),
    })
    .from(orgConcurrencySubscriptions)
    .where(activeConcurrencySubscriptionPredicate(orgId, at));
  const expiredTotal = builder
    .select({
      value: sql`${sum(creditExpiresRecord.remaining)}::text`.mapWith(
        rawDecoder,
      ),
    })
    .from(creditExpiresRecord)
    .where(expired.where);
  return (
    builder
      .select({
        metadata:
          sql`CASE WHEN ${orgMetadata.orgId} IS NULL THEN NULL ELSE jsonb_build_object(
        'credits', ${orgMetadata.credits},
        'openrouterPreset', ${orgMetadata.openrouterPreset}) END`
            .mapWith(rawDecoder)
            .as("metadata"),
        plan: sql`(SELECT jsonb_build_object(
        'planKey', ${orgPlanEntitlements.planKey}, 'status', ${orgPlanEntitlements.status},
        'baseConcurrencyLimit', ${orgPlanEntitlements.baseConcurrencyLimit},
        'canBuyCredits', ${orgPlanEntitlements.canBuyCredits},
        'restrictedBuiltInModels', ${orgPlanEntitlements.restrictedBuiltInModels})
        FROM ${orgPlanEntitlements} WHERE ${eq(orgPlanEntitlements.orgId, orgId)})`
          .mapWith(rawDecoder)
          .as("plan"),
        slots: sql`(${slots})`.mapWith(rawDecoder).as("slots"),
        expired: sql`(${expiredTotal})`.mapWith(rawDecoder).as("expired"),
      })
      .from(orgMetadata)
      // Preserve entitlement-only organizations and absent metadata without a second read.
      .rightJoin(
        sql`(SELECT ${orgId}::text AS org_id) AS context_org`,
        eq(orgMetadata.orgId, sql`context_org.org_id`),
      )
  );
}
export interface ExecutionOrgRows {
  readonly at: Date;
  readonly rows: readonly {
    readonly metadata: unknown;
    readonly plan: unknown;
    readonly slots: unknown;
    readonly expired: unknown;
  }[];
}
function requiredOrgRow(snapshot: ExecutionOrgRows) {
  const row = snapshot.rows[0];
  if (!row) {
    throw new Error("Execution organization query returned no row");
  }
  return row;
}
export function executionOrgMetadata(snapshot: ExecutionOrgRows) {
  return metadataSchema.nullable().parse(requiredOrgRow(snapshot).metadata);
}
export function executionOrgPlan(
  snapshot: ExecutionOrgRows,
  orgId: string,
): ExecutionOrgPlan | null {
  const row = requiredOrgRow(snapshot);
  if (row.plan === null) {
    if (row.metadata !== null) {
      throw new Error(`Missing org plan entitlement for ${orgId}`);
    }
    return null;
  }
  return orgPlanCapabilitiesFromRow(planSchema.parse(row.plan), orgId);
}
export function executionOrgSlots(snapshot: ExecutionOrgRows) {
  const value = requiredOrgRow(snapshot).slots;
  return value === null ? 0 : pgInt8ToSafeIntegerSchema.parse(value);
}
export function executionExpiredCredits(snapshot: ExecutionOrgRows) {
  const value = requiredOrgRow(snapshot).expired;
  return value === null ? 0 : pgInt8ToSafeIntegerSchema.parse(value);
}
