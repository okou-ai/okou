import { orgTierSchema } from "@okouai/api-contracts/contracts/orgs";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command } from "ccstate";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { parseRawRows } from "../../lib/db-raw-rows";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { getStripeClient } from "../external/stripe-client";
import { settle } from "../utils";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";
import { stripePreviewMetadata } from "./stripe-preview-metadata.service";

interface GetOrCreateStripeCustomerArgs {
  readonly orgId: string;
}

const insertedMetadataSchema = z.object({ org_id: z.string() });

const bindStripeCustomer$ = command(
  async (
    { get, set },
    args: GetOrCreateStripeCustomerArgs,
    customerId: string,
    signal: AbortSignal,
  ): Promise<string> => {
    signal.throwIfAborted();
    const [row] = await get(db$)
      .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (row?.stripeCustomerId) {
      return row.stripeCustomerId;
    }

    const db = set(writeDb$);
    const metadata = db
      .insert(orgMetadataCanonicalWrites)
      .values({
        orgId: args.orgId,
        stripeCustomerId: customerId,
        credits: 0,
      })
      .onConflictDoNothing({ target: orgMetadataCanonicalWrites.orgId })
      .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier })
      .getSQL();
    // Use the actual inserted tier, including database defaults. An unknown
    // tier has no values row, just as the previous safeParse branch skipped it.
    const entitlementRows = orgTierSchema.options.map((tier) => {
      const values = orgPlanEntitlementValues(
        { orgId: args.orgId, tier, source: "org_metadata_migration" },
        { stripeSubscriptionId: null, sourceMetadata: {} },
      );
      return sql`(${values.planKey}, ${values.planRank}::integer,
        ${values.source}, ${values.status}, ${values.baseConcurrencyLimit}::integer,
        ${values.canBuyConcurrency}::boolean, ${values.canBuyCredits}::boolean,
        ${values.showUsagePack}::boolean, ${values.autoRechargeAllowed}::boolean,
        ${values.restrictedBuiltInModels}::boolean,
        ${values.workflowWebhookTriggerAllowed}::boolean,
        ${values.audioLifetimeLimit}::integer, ${values.audioDailyRateLimit}::integer,
        ${values.audioDailyDurationSeconds}::integer, ${values.stripeSubscriptionId},
        ${values.stripePriceId},
        ${sql.param(values.currentPeriodStart, orgPlanEntitlements.currentPeriodStart)}::timestamp,
        ${sql.param(values.currentPeriodEnd, orgPlanEntitlements.currentPeriodEnd)}::timestamp,
        ${sql.param(values.cancelAt, orgPlanEntitlements.cancelAt)}::timestamp,
        ${sql.param(values.expiresAt, orgPlanEntitlements.expiresAt)}::timestamp,
        ${sql.param(values.sourceMetadata, orgPlanEntitlements.sourceMetadata)}::jsonb,
        ${sql.param(values.updatedAt, orgPlanEntitlements.updatedAt)}::timestamp)`;
    });
    // Only this INSERT's returned row can initialize the default entitlement.
    // Existing organizations retain their Plan, including an absent entitlement.
    const [inserted] = parseRawRows(
      insertedMetadataSchema,
      await db.execute(sql`WITH metadata AS (${metadata}), entitlement_values (
        plan_key, plan_rank, source, status, base_concurrency_limit,
        can_buy_concurrency, can_buy_credits, show_usage_pack, auto_recharge_allowed,
        restricted_built_in_models, workflow_webhook_trigger_allowed,
        audio_lifetime_limit, audio_daily_rate_limit, audio_daily_duration_seconds,
        stripe_subscription_id, stripe_price_id, current_period_start,
        current_period_end, cancel_at, expires_at, source_metadata, updated_at
      ) AS (VALUES ${sql.join(entitlementRows, sql`, `)}), default_entitlement AS (
        INSERT INTO ${orgPlanEntitlements} (
          org_id, plan_key, plan_rank, source, status, base_concurrency_limit,
          can_buy_concurrency, can_buy_credits, show_usage_pack, auto_recharge_allowed,
          restricted_built_in_models, workflow_webhook_trigger_allowed,
          audio_lifetime_limit, audio_daily_rate_limit, audio_daily_duration_seconds,
          stripe_subscription_id, stripe_price_id, current_period_start,
          current_period_end, cancel_at, expires_at, source_metadata, updated_at
        ) SELECT metadata.org_id, entitlement_values.* FROM metadata
          JOIN entitlement_values ON metadata.tier = entitlement_values.plan_key
        ON CONFLICT (org_id) DO NOTHING
      ) SELECT org_id FROM metadata`),
    );
    signal.throwIfAborted();
    if (inserted) {
      return customerId;
    }

    // A subsequent statement sees a competing newly committed metadata row,
    // even when it was invisible to the INSERT's snapshot and has no binding.
    const [bound] = await db
      .update(orgMetadata)
      .set({ stripeCustomerId: customerId, updatedAt: nowDate() })
      .where(
        and(
          eq(orgMetadata.orgId, args.orgId),
          isNull(orgMetadata.stripeCustomerId),
        ),
      )
      .returning({ stripeCustomerId: orgMetadata.stripeCustomerId });
    signal.throwIfAborted();
    if (bound?.stripeCustomerId) {
      return bound.stripeCustomerId;
    }

    const [winner] = await get(db$)
      .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (!winner?.stripeCustomerId) {
      throw new Error("Stripe customer publication lost its organization");
    }
    return winner.stripeCustomerId;
  },
);

const publishStripeCustomer$ = command(
  async (
    { get, set },
    args: GetOrCreateStripeCustomerArgs,
    customerId: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const publication = await settle(
      set(bindStripeCustomer$, args, customerId, signal),
      signal,
    );
    if (publication.ok) {
      return publication.value;
    }
    // A failed SQL response does not prove rollback. Read the authoritative
    // binding before propagating the error, and never delete a possible winner.
    const [published] = await get(db$)
      .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (published?.stripeCustomerId) {
      return published.stripeCustomerId;
    }
    throw publication.error;
  },
);

/** Publish one authoritative Stripe customer without replacing an existing one. */
export const getOrCreateStripeCustomer$ = command(
  async (
    { get, set },
    args: GetOrCreateStripeCustomerArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const [published] = await get(db$)
      .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (published?.stripeCustomerId) {
      return published.stripeCustomerId;
    }
    const metadata: Record<string, string> = {
      orgId: args.orgId,
      ...stripePreviewMetadata(),
    };
    const prepared = await settle(
      getStripeClient().customers.create(
        { metadata },
        {
          // Preview routing participates in the identity because Stripe rejects
          // reuse of a key with different metadata. Production releases share
          // the same identity; Stripe's finite retention is not a durable log.
          idempotencyKey: `stripe-customer:${env("ENV")}:${metadata.job_ref ?? ""}:${args.orgId}`,
        },
      ),
      signal,
    );
    signal.throwIfAborted();
    if (prepared.ok) {
      return await set(publishStripeCustomer$, args, prepared.value.id, signal);
    }
    // Another request may have published the same remote success while this
    // request lost its provider response. Only use that committed binding.
    const [winner] = await get(db$)
      .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (winner?.stripeCustomerId) {
      return winner.stripeCustomerId;
    }
    throw prepared.error;
  },
);
