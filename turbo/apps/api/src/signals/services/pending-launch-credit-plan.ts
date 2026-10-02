import { z } from "zod";
import { eq, notExists, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import { orgPlanCapabilitiesFromRow } from "./org-plan-entitlement-read.service";

const capabilitiesSchema = z.object({
  planKey: z.string(),
  status: z.string(),
  baseConcurrencyLimit: z.number(),
  canBuyConcurrency: z.boolean(),
  canBuyCredits: z.boolean(),
  showUsagePack: z.boolean(),
  autoRechargeAllowed: z.boolean(),
  supportByok: z.boolean(),
  restrictedBuiltInModels: z.boolean().nullable(),
  videoGenerationAllowed: z.boolean(),
  workflowWebhookAutomationAllowed: z.boolean(),
  audioLifetimeLimit: z.number().nullable(),
  audioDailyRateLimit: z.number(),
  audioDailyDurationSeconds: z.number(),
});
export const pendingCreditPlanRowSchema = z.object({
  caps: capabilitiesSchema.nullable(),
  orgExists: z.boolean(),
});

/** Match entitlement-first locking, probing/locking org_metadata only on a miss. */
export function pendingCreditPlanSql(orgId: string) {
  const builder = new QueryBuilder();
  const projection = sql`jsonb_build_object(
    'planKey', ${orgPlanEntitlements.planKey}, 'status', ${orgPlanEntitlements.status},
    'baseConcurrencyLimit', ${orgPlanEntitlements.baseConcurrencyLimit},
    'canBuyConcurrency', ${orgPlanEntitlements.canBuyConcurrency}, 'canBuyCredits', ${orgPlanEntitlements.canBuyCredits},
    'showUsagePack', ${orgPlanEntitlements.showUsagePack}, 'autoRechargeAllowed', ${orgPlanEntitlements.autoRechargeAllowed},
    'supportByok', ${orgPlanEntitlements.supportByok}, 'restrictedBuiltInModels', ${orgPlanEntitlements.restrictedBuiltInModels},
    'videoGenerationAllowed', ${orgPlanEntitlements.videoGenerationAllowed}, 'workflowWebhookAutomationAllowed', ${orgPlanEntitlements.workflowWebhookTriggerAllowed},
    'audioLifetimeLimit', ${orgPlanEntitlements.audioLifetimeLimit}, 'audioDailyRateLimit', ${orgPlanEntitlements.audioDailyRateLimit},
    'audioDailyDurationSeconds', ${orgPlanEntitlements.audioDailyDurationSeconds})`
    .mapWith(zodDriverValueDecoder(capabilitiesSchema))
    .as("caps");
  const entitlement = builder
    .$with("pending_credit_entitlement")
    .as(
      builder
        .select({ caps: projection })
        .from(orgPlanEntitlements)
        .where(eq(orgPlanEntitlements.orgId, orgId))
        .limit(1)
        .for("update"),
    );
  const missingOrg = builder.$with("pending_credit_missing_org").as(
    builder
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(
        sql`${eq(orgMetadata.orgId, orgId)} AND ${notExists(builder.select({ caps: entitlement.caps }).from(entitlement))}`,
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
    .getSQL();
}

export function pendingCreditPlanResult(
  rows: readonly z.output<typeof pendingCreditPlanRowSchema>[],
  orgId: string,
) {
  const row = rows[0];
  if (!row) {
    throw new Error("Pending credit plan read returned no result");
  }
  if (!row.caps) {
    if (row.orgExists) {
      throw new Error(`Missing org plan entitlement for ${orgId}`);
    }
    return null;
  }
  return orgPlanCapabilitiesFromRow(row.caps, orgId);
}
