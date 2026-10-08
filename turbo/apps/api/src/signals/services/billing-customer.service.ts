import { orgTierSchema } from "@okouai/api-contracts/contracts/orgs";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";

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

const publishStripeCustomer$ = command(
  async (
    { get, set },
    args: GetOrCreateStripeCustomerArgs,
    customerId: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const db = set(writeDb$);
    // New metadata and its default Plan entitlement must publish together.
    const publication = await settle(
      db.transaction(async (tx) => {
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

        const [inserted] = await tx
          .insert(orgMetadataCanonicalWrites)
          .values({
            orgId: args.orgId,
            stripeCustomerId: customerId,
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
          return customerId;
        }

        const [bound] = await tx
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
      }),
      signal,
    );
    if (publication.ok) {
      return publication.value;
    }
    // A failed COMMIT response does not prove rollback. Read the authoritative
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
