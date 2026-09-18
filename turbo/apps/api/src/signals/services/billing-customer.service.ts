import { command } from "ccstate";
import { sql, eq } from "drizzle-orm";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";

import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { getStripeClient } from "../external/stripe-client";
import { stripePreviewMetadata } from "./stripe-preview-metadata.service";
import { writeOrgMetadataWithDefaultPlanEntitlement } from "./org-plan-entitlements.service";

interface GetOrCreateStripeCustomerArgs {
  readonly orgId: string;
}

/**
 * Get or create a Stripe customer for an org. Serializes per-org via
 * pg_advisory_xact_lock so concurrent checkout / redeem requests in the
 * same org cannot mint multiple Stripe customers and orphan webhook events.
 *
 * Lock key `stripe_customer_${orgId}` matches apps/web exactly so cross-
 * process races during the web→api cutover coordinate on the same lock.
 */
export const getOrCreateStripeCustomer$ = command(
  async (
    { set },
    args: GetOrCreateStripeCustomerArgs,
    signal: AbortSignal,
  ): Promise<string> => {
    const writeDb = set(writeDb$);
    return await writeDb.transaction(async (tx) => {
      await tx.execute(
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

      const stripe = getStripeClient();
      const metadata: Record<string, string> = { orgId: args.orgId };
      Object.assign(metadata, stripePreviewMetadata());
      const customer = await stripe.customers.create({ metadata });
      signal.throwIfAborted();

      await writeOrgMetadataWithDefaultPlanEntitlement(
        tx,
        args.orgId,
        async (writeTx) => {
          return await writeTx
            .insert(orgMetadataCanonicalWrites)
            .values({
              orgId: args.orgId,
              stripeCustomerId: customer.id,
              credits: 0,
            })
            .onConflictDoUpdate({
              target: orgMetadataCanonicalWrites.orgId,
              set: { stripeCustomerId: customer.id, updatedAt: nowDate() },
            })
            .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier });
        },
      );

      signal.throwIfAborted();

      return customer.id;
    });
  },
);
