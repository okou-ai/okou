import { retireImpactMetadata } from "../../lib/impact-marketing";
import { compatibleGoogleAdsAttribution } from "@okouai/core/google-ads-attribution";
import { command } from "ccstate";
import { sql, eq } from "drizzle-orm";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";

import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { getStripeClient } from "../external/stripe-client";
import { stripePreviewMetadata } from "./stripe-preview-metadata.service";
import {
  impactStripeMetadata$,
  updateImpactCustomer,
} from "./impact-attribution.service";

interface GetOrCreateStripeCustomerArgs {
  readonly orgId: string;
  readonly metadata?: Readonly<Record<string, string | undefined>>;
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
    const impactMetadata = await set(impactStripeMetadata$, args.orgId, signal);
    const writeDb = set(writeDb$);
    return writeDb.transaction(async (tx) => {
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
        await updateImpactCustomer(
          row.stripeCustomerId,
          impactMetadata,
          signal,
        );
        return row.stripeCustomerId;
      }

      const stripe = getStripeClient();
      const metadata: Record<string, string> = { orgId: args.orgId };
      for (const [key, value] of Object.entries(
        compatibleGoogleAdsAttribution(
          retireImpactMetadata(args.metadata ?? {}),
        ),
      )) {
        if (value) {
          metadata[key] = value;
        }
      }
      Object.assign(metadata, stripePreviewMetadata());
      Object.assign(metadata, impactMetadata);
      const customer = await stripe.customers.create({ metadata });
      signal.throwIfAborted();

      await tx
        .insert(orgMetadataCanonicalWrites)
        .values({
          orgId: args.orgId,
          stripeCustomerId: customer.id,
          credits: 0,
        })
        .onConflictDoUpdate({
          target: orgMetadataCanonicalWrites.orgId,
          set: { stripeCustomerId: customer.id, updatedAt: nowDate() },
        });
      signal.throwIfAborted();

      return customer.id;
    });
  },
);
