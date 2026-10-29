import { boolean, number, object, string } from "zod";

import { and, eq, notExists, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";

const capabilitiesSchema = object({
  planKey: string(),
  status: string(),
  baseConcurrencyLimit: number(),
  canBuyConcurrency: boolean(),
  canBuyCredits: boolean(),
  showUsagePack: boolean(),
  autoRechargeAllowed: boolean(),
  restrictedBuiltInModels: boolean().nullable(),
  workflowWebhookAutomationAllowed: boolean(),
  audioLifetimeLimit: number().nullable(),
  audioDailyRateLimit: number(),
  audioDailyDurationSeconds: number(),
});
/** Match entitlement-first locking, probing/locking org_metadata only on a miss. */
export function pendingCreditPlanSql(orgId: string, prerequisite?: SQL) {
  const builder = new QueryBuilder();
  const projection = sql`jsonb_build_object(
    'planKey', ${orgPlanEntitlements.planKey}, 'status', ${orgPlanEntitlements.status},
    'baseConcurrencyLimit', ${orgPlanEntitlements.baseConcurrencyLimit},
    'canBuyConcurrency', ${orgPlanEntitlements.canBuyConcurrency}, 'canBuyCredits', ${orgPlanEntitlements.canBuyCredits},
    'showUsagePack', ${orgPlanEntitlements.showUsagePack}, 'autoRechargeAllowed', ${orgPlanEntitlements.autoRechargeAllowed},
    'restrictedBuiltInModels', ${orgPlanEntitlements.restrictedBuiltInModels},
    'workflowWebhookAutomationAllowed', ${orgPlanEntitlements.workflowWebhookTriggerAllowed},
    'audioLifetimeLimit', ${orgPlanEntitlements.audioLifetimeLimit}, 'audioDailyRateLimit', ${orgPlanEntitlements.audioDailyRateLimit},
    'audioDailyDurationSeconds', ${orgPlanEntitlements.audioDailyDurationSeconds})`
    .mapWith(zodDriverValueDecoder(capabilitiesSchema))
    .as("caps");
  const entitlement = builder.$with("pending_credit_entitlement").as(
    builder
      .select({ caps: projection })
      .from(orgPlanEntitlements)
      .where(and(eq(orgPlanEntitlements.orgId, orgId), prerequisite))
      .limit(1)
      .for("update"),
  );
  const missingOrg = builder.$with("pending_credit_missing_org").as(
    builder
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(
        and(
          sql`${eq(orgMetadata.orgId, orgId)} AND ${notExists(builder.select({ caps: entitlement.caps }).from(entitlement))}`,
          prerequisite,
        ),
      )
      .limit(1)
      .for("update"),
  );
  return builder
    .with(entitlement, missingOrg)
    .select({
      caps: sql`(SELECT ${entitlement.caps} FROM ${entitlement})`
        .mapWith(
          nullableDriverValueDecoder(zodDriverValueDecoder(capabilitiesSchema)),
        )
        .as("caps"),
      orgExists: sql`EXISTS (SELECT 1 FROM ${missingOrg})`
        .mapWith(pgBooleanDecoder)
        .as("orgExists"),
    })
    .from(sql`(VALUES (1)) AS pending_credit_probe(value)`)
    .where(prerequisite)
    .getSQL();
}
