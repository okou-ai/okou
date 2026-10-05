import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { computed } from "ccstate";
import { eq,sql,sum } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { z } from "zod";
import { pgInt8ToSafeIntegerSchema } from "../../lib/db-raw-rows";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import { executionCreditQueries } from "./execution-credit-balance.service";
import { activeConcurrencySubscriptionPredicate } from "./org-concurrency-entitlements.service";
import { orgPlanCapabilitiesFromRow } from "./org-plan-entitlement-read.service";

const rawDecoder = zodDriverValueDecoder(z.unknown());
const metadataSchema = z.object({
  credits: z.number(),
  defaultAgentId: z.string().nullable(),
});
const planSchema = z.object({
  planKey: z.string(),
  status: z.string(),
  baseConcurrencyLimit: z.number(),
  canBuyConcurrency: z.boolean(),
  canBuyCredits: z.boolean(),
  showUsagePack: z.boolean(),
  autoRechargeAllowed: z.boolean(),
  supportByok: z.boolean(),
  restrictedBuiltInModels: z.boolean().nullable(),
  workflowWebhookAutomationAllowed: z.boolean(),
  audioLifetimeLimit: z.number().nullable(),
  audioDailyRateLimit: z.number(),
  audioDailyDurationSeconds: z.number(),
});
/** Transport only: business decoding belongs to independent derived consumers. */
export function createExecutionOrgRows(orgId: string) {
  return computed(async (get) => {
    const at = nowDate();
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
    const rows = await get(db$)
      .select({
        metadata:
          sql`CASE WHEN ${orgMetadata.orgId} IS NULL THEN NULL ELSE jsonb_build_object(
        'credits', ${orgMetadata.credits},
        'defaultAgentId', ${orgMetadata.defaultAgentId}) END`.mapWith(
            rawDecoder,
          ),
        plan: sql`(SELECT jsonb_build_object(
        'planKey', ${orgPlanEntitlements.planKey}, 'status', ${orgPlanEntitlements.status},
        'baseConcurrencyLimit', ${orgPlanEntitlements.baseConcurrencyLimit},
        'canBuyConcurrency', ${orgPlanEntitlements.canBuyConcurrency}, 'canBuyCredits', ${orgPlanEntitlements.canBuyCredits},
        'showUsagePack', ${orgPlanEntitlements.showUsagePack}, 'autoRechargeAllowed', ${orgPlanEntitlements.autoRechargeAllowed},
        'supportByok', ${orgPlanEntitlements.supportByok}, 'restrictedBuiltInModels', ${orgPlanEntitlements.restrictedBuiltInModels},
        'workflowWebhookAutomationAllowed', ${orgPlanEntitlements.workflowWebhookTriggerAllowed},
        'audioLifetimeLimit', ${orgPlanEntitlements.audioLifetimeLimit}, 'audioDailyRateLimit', ${orgPlanEntitlements.audioDailyRateLimit},
        'audioDailyDurationSeconds', ${orgPlanEntitlements.audioDailyDurationSeconds})
        FROM ${orgPlanEntitlements} WHERE ${eq(orgPlanEntitlements.orgId, orgId)})`.mapWith(
          rawDecoder,
        ),
        slots: sql`(${slots})`.mapWith(rawDecoder),
        expired: sql`(${expiredTotal})`.mapWith(rawDecoder),
      })
      .from(orgMetadata)
      // Preserve entitlement-only organizations and absent metadata without a second read.
      .rightJoin(
        sql`(SELECT ${orgId}::text AS org_id) AS context_org`,
        eq(orgMetadata.orgId, sql`context_org.org_id`),
      );
    return { at, rows };
  });
}
export type ExecutionOrgRows = Awaited<
  ReturnType<ReturnType<typeof createExecutionOrgRows>["read"]>
>;
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
export function executionOrgPlan(snapshot: ExecutionOrgRows, orgId: string) {
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
