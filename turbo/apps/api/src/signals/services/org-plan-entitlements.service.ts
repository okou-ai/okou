import {
  orgTierSchema,
  type OrgTier,
} from "@okouai/api-contracts/contracts/orgs";
import type { OrgPlanEntitlementSourceMetadata } from "@okouai/db/jsonb-contracts/org-plan-entitlement";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { ORG_PLAN_ENTITLEMENT_TIER_VALUES } from "./org-plan-entitlement-tier-values";
import type { Tx } from "../../lib/db-types";

type WriteTx = Tx;

interface UpsertOrgPlanEntitlementArgs {
  readonly orgId: string;
  readonly tier: OrgTier;
  readonly source:
    | "stripe_subscription"
    | "stripe_atom_grant"
    | "org_metadata_bootstrap"
    | "org_metadata_migration";
  readonly status?: string;
  readonly stripeSubscriptionId?: string | null;
  readonly stripePriceId?: string | null;
  readonly currentPeriodStart?: Date | null;
  readonly currentPeriodEnd?: Date | null;
  readonly cancelAt?: Date | null;
  readonly expiresAt?: Date | null;
  readonly showUsagePack?: boolean;
  readonly sourceMetadata?: OrgPlanEntitlementSourceMetadata;
}

interface WriteOrgMetadataWithPlanEntitlementsArgs<Row> {
  readonly writeOrgMetadata: (tx: WriteTx) => Promise<Row[]>;
  readonly writePlanEntitlement: (tx: WriteTx, row: Row) => Promise<void>;
}

interface ResolvedStripeSubscriptionSnapshot {
  readonly stripeSubscriptionId: string | null;
  readonly sourceMetadata: OrgPlanEntitlementSourceMetadata;
}

function statusForTier(tier: OrgTier): string {
  return tier === "pro-suspend" ? "suspended" : "active";
}

async function resolveStripeSubscriptionSnapshot(
  tx: WriteTx,
  args: Pick<
    UpsertOrgPlanEntitlementArgs,
    "orgId" | "stripeSubscriptionId" | "sourceMetadata"
  >,
): Promise<ResolvedStripeSubscriptionSnapshot> {
  const sourceMetadata = args.sourceMetadata ?? {};
  const stripeSubscriptionId = args.stripeSubscriptionId ?? null;
  if (!stripeSubscriptionId) {
    return { stripeSubscriptionId: null, sourceMetadata };
  }

  const existingOrgId = await orgPlanEntitlementOrgIdForStripeSubscription(
    tx,
    stripeSubscriptionId,
  );
  if (!existingOrgId || existingOrgId === args.orgId) {
    return { stripeSubscriptionId, sourceMetadata };
  }

  return {
    stripeSubscriptionId: null,
    sourceMetadata: {
      ...sourceMetadata,
      stripeSubscriptionSnapshotSkipped: "duplicate_stripe_subscription_id",
    },
  };
}

export async function writeOrgMetadataWithPlanEntitlements<Row>(
  tx: WriteTx,
  args: WriteOrgMetadataWithPlanEntitlementsArgs<Row>,
): Promise<Row[]> {
  const rows = await args.writeOrgMetadata(tx);
  for (const row of rows) {
    await args.writePlanEntitlement(tx, row);
  }
  return rows;
}

function orgPlanEntitlementValues(
  args: UpsertOrgPlanEntitlementArgs,
  stripeSubscriptionSnapshot: ResolvedStripeSubscriptionSnapshot,
) {
  const limits = ORG_PLAN_ENTITLEMENT_TIER_VALUES[args.tier];
  const updatedAt = nowDate();
  const showUsagePack =
    (args.tier === "pro" || args.tier === "team") &&
    args.showUsagePack === true;
  return {
    orgId: args.orgId,
    planKey: args.tier,
    planRank: limits.planRank,
    source: args.source,
    status: args.status ?? statusForTier(args.tier),
    baseConcurrencyLimit: limits.baseConcurrencyLimit,
    canBuyConcurrency: limits.canBuyConcurrency,
    canBuyCredits: limits.canBuyCredits,
    showUsagePack,
    autoRechargeAllowed: limits.autoRechargeAllowed,
    supportByok: limits.supportByok,
    restrictedBuiltInModels: limits.restrictedBuiltInModels,
    videoGenerationAllowed: limits.videoGenerationAllowed,
    workflowWebhookTriggerAllowed: limits.workflowWebhookAutomationAllowed,
    audioLifetimeLimit: limits.audioLifetimeLimit,
    audioDailyRateLimit: limits.audioDailyRateLimit,
    audioDailyDurationSeconds: limits.audioDailyDurationSeconds,
    stripeSubscriptionId: stripeSubscriptionSnapshot.stripeSubscriptionId,
    stripePriceId: args.stripePriceId ?? null,
    currentPeriodStart: args.currentPeriodStart ?? null,
    currentPeriodEnd: args.currentPeriodEnd ?? null,
    cancelAt: args.cancelAt ?? null,
    expiresAt: args.expiresAt ?? null,
    sourceMetadata: stripeSubscriptionSnapshot.sourceMetadata,
    updatedAt,
  };
}

/**
 * Complete a metadata write in its transaction without replacing an existing
 * entitlement. Use the returned metadata tier, including database defaults and
 * conflict updates, rather than the attempted insert's tier.
 */
export async function ensureOrgMetadataPlanEntitlement(
  tx: WriteTx,
  metadata: { readonly orgId: string; readonly tier: string },
): Promise<void> {
  const tier = orgTierSchema.safeParse(metadata.tier);
  // The legacy trigger's plan lookup also leaves unknown tiers untouched.
  if (!tier.success) {
    return;
  }
  const values = orgPlanEntitlementValues(
    {
      orgId: metadata.orgId,
      tier: tier.data,
      source: "org_metadata_migration",
    },
    { stripeSubscriptionId: null, sourceMetadata: {} },
  );
  await tx
    .insert(orgPlanEntitlements)
    .values(values)
    .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
}

/**
 * Preserve the INSERT-only bootstrap effect for metadata upserts. Lock an
 * existing row before the write so an ordinary update cannot silently repair a
 * missing entitlement or race a deletion. Concurrent creators still converge
 * on the organization-key constraints.
 */
export async function writeOrgMetadataWithDefaultPlanEntitlement<
  Row extends { readonly orgId: string; readonly tier: string },
>(
  tx: WriteTx,
  orgId: string,
  writeOrgMetadata: (tx: WriteTx) => Promise<Row[]>,
): Promise<Row[]> {
  const [existing] = await tx
    .select({ orgId: orgMetadata.orgId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .for("update");
  const rows = await writeOrgMetadata(tx);
  if (!existing) {
    for (const row of rows) {
      await ensureOrgMetadataPlanEntitlement(tx, row);
    }
  }
  return rows;
}

export async function upsertOrgPlanEntitlement(
  tx: WriteTx,
  args: UpsertOrgPlanEntitlementArgs,
): Promise<void> {
  const stripeSubscriptionSnapshot = await resolveStripeSubscriptionSnapshot(
    tx,
    args,
  );
  const values = orgPlanEntitlementValues(args, stripeSubscriptionSnapshot);
  await tx
    .insert(orgPlanEntitlements)
    .values(values)
    .onConflictDoUpdate({
      target: orgPlanEntitlements.orgId,
      set: {
        planKey: values.planKey,
        planRank: values.planRank,
        source: values.source,
        status: values.status,
        baseConcurrencyLimit: values.baseConcurrencyLimit,
        canBuyConcurrency: values.canBuyConcurrency,
        canBuyCredits: values.canBuyCredits,
        showUsagePack: values.showUsagePack,
        autoRechargeAllowed: values.autoRechargeAllowed,
        supportByok: values.supportByok,
        restrictedBuiltInModels: values.restrictedBuiltInModels,
        videoGenerationAllowed: values.videoGenerationAllowed,
        workflowWebhookTriggerAllowed: values.workflowWebhookTriggerAllowed,
        audioLifetimeLimit: values.audioLifetimeLimit,
        audioDailyRateLimit: values.audioDailyRateLimit,
        audioDailyDurationSeconds: values.audioDailyDurationSeconds,
        stripeSubscriptionId: values.stripeSubscriptionId,
        stripeProductId: null,
        stripePriceId: values.stripePriceId,
        currentPeriodStart: values.currentPeriodStart,
        currentPeriodEnd: values.currentPeriodEnd,
        cancelAt: values.cancelAt,
        expiresAt: values.expiresAt,
        metadataHash: null,
        sourceMetadata: values.sourceMetadata,
        updatedAt: values.updatedAt,
      },
    });
}

export async function orgPlanEntitlementOrgIdForStripeSubscription(
  tx: WriteTx,
  stripeSubscriptionId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ orgId: orgPlanEntitlements.orgId })
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  return row?.orgId ?? null;
}
