import { orgTierSchema } from "@okouai/api-contracts/contracts/orgs";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command } from "ccstate";
import { and, eq, isNull, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { getStripeClient } from "../external/stripe-client";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";
import { stripePreviewMetadata } from "./stripe-preview-metadata.service";

interface GetOrCreateStripeCustomerArgs {
  readonly orgId: string;
}

/** Publish one authoritative Stripe customer without replacing an existing one. */
export const getOrCreateStripeCustomer$ = command(
  async (
    { set },
    args: GetOrCreateStripeCustomerArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const writeDb = set(writeDb$);
    return await writeDb.transaction(async (tx) => {
      // API rollout: outgoing writers create without an idempotency key and
      // overwrite the binding. Keep their coordination until they have drained
      // and all retained rollback targets contain this conditional writer.
      // Release 2 then moves Stripe preparation outside this local transaction.
      await tx.execute(
        // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
        sql`SELECT pg_advisory_xact_lock(hashtext('stripe_customer_' || ${args.orgId}))`,
      );
      signal.throwIfAborted();

      const [row] = await tx
        .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, args.orgId))
        .limit(1);
      signal.throwIfAborted();
      if (row?.stripeCustomerId) {
        return row.stripeCustomerId;
      }

      const metadata: Record<string, string> = {
        orgId: args.orgId,
        ...stripePreviewMetadata(),
      };
      const customer = await getStripeClient().customers.create(
        { metadata },
        {
          // Preview routing participates in the identity because Stripe rejects
          // reuse of a key with different metadata. Production releases share
          // the same identity; Stripe's finite retention is not a durable log.
          idempotencyKey: `stripe-customer:${env("ENV")}:${metadata.job_ref ?? ""}:${args.orgId}`,
        },
      );
      signal.throwIfAborted();

      const [inserted] = await tx
        .insert(orgMetadataCanonicalWrites)
        .values({
          orgId: args.orgId,
          stripeCustomerId: customer.id,
          credits: 0,
        })
        .onConflictDoNothing({ target: orgMetadataCanonicalWrites.orgId })
        .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier });
      if (inserted) {
        const tier = orgTierSchema.safeParse(inserted.tier);
        if (tier.success) {
          await tx
            .insert(orgPlanEntitlements)
            .values(
              orgPlanEntitlementValues(
                {
                  orgId: inserted.orgId,
                  tier: tier.data,
                  source: "org_metadata_migration",
                },
                { stripeSubscriptionId: null, sourceMetadata: {} },
              ),
            )
            .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
        }
        signal.throwIfAborted();
        return customer.id;
      }

      const [bound] = await tx
        .update(orgMetadata)
        .set({ stripeCustomerId: customer.id, updatedAt: nowDate() })
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

      const [winner] = await tx
        .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, args.orgId))
        .limit(1);
      signal.throwIfAborted();
      if (!winner?.stripeCustomerId) {
        throw new Error("Stripe customer publication lost its organization");
      }
      return winner.stripeCustomerId;
    });
  },
);
