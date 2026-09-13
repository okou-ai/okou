import { command } from "ccstate";
import { eq, isNull, lt, or, sql } from "drizzle-orm";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import {
  IMPACT_ATTRIBUTION_METADATA_KEY,
  parseImpactAttribution,
  type ImpactAttribution,
} from "@okouai/api-contracts/contracts/impact-attribution";

import {
  getStripeClient,
  listAllStripeSubscriptions,
} from "../external/stripe-client";
import { writeDb$, type ReadonlyDb } from "../external/db";
import { optionalEnv } from "../../lib/env";
import { clerkAttributionDisabled } from "../../lib/clerk-attribution";
import { authContext$ } from "../auth/auth-context";
import { clerk$ } from "../external/clerk";
import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import { settle } from "../utils";

const log = logger("impact-attribution");

const persistOrgImpactAttribution$ = command(
  async (
    { get, set },
    orgId: string,
    attribution: ImpactAttribution,
    signal: AbortSignal,
  ): Promise<void> => {
    const auth = get(authContext$);
    if (auth.orgId !== orgId || auth.orgRole !== "admin") {
      return;
    }
    const capturedAt = new Date(attribution.capturedAt);
    await set(writeDb$)
      .insert(orgMetadataCanonicalWrites)
      .values({
        orgId,
        impactClickId: attribution.clickId,
        impactClickAt: capturedAt,
      })
      .onConflictDoUpdate({
        target: orgMetadataCanonicalWrites.orgId,
        set: {
          impactClickId: attribution.clickId,
          impactClickAt: capturedAt,
          updatedAt: nowDate(),
        },
        setWhere: or(
          isNull(orgMetadata.impactClickAt),
          lt(orgMetadata.impactClickAt, capturedAt),
        ),
      });
    signal.throwIfAborted();
  },
);

export async function readOrgImpactMetadata(
  db: Pick<ReadonlyDb, "select">,
  orgId: string,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  const [row] = await db
    .select({
      clickId: orgMetadata.impactClickId,
      capturedAt: orgMetadata.impactClickAt,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  signal.throwIfAborted();
  return row?.clickId && row.capturedAt
    ? {
        impact_click_id: row.clickId,
        impact_click_at: row.capturedAt.toISOString(),
      }
    : {};
}

// Customer creation is called by authenticated billing routes. Bind the click
// to the actual purchaser; never select an arbitrary member of their org.
export const impactStripeMetadata$ = command(
  async (
    { get, set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<Record<string, string>> => {
    const auth = get(authContext$);
    if (auth.orgId !== orgId || auth.orgRole !== "admin") {
      return {};
    }
    if (clerkAttributionDisabled()) {
      return {};
    }
    const result = await settle(
      get(clerk$).users.getUserList(
        { userId: [auth.userId], limit: 1 },
        undefined,
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      // Attribution enrichment is best effort; payment availability takes priority.
      log.warn("Unable to resolve purchaser Impact attribution", {
        userId: auth.userId,
      });
      return readOrgImpactMetadata(set(writeDb$), orgId, signal);
    }
    const user = result.value.data.find((candidate) => {
      return candidate.id === auth.userId;
    });
    const impact = parseImpactAttribution(
      user?.privateMetadata?.[IMPACT_ATTRIBUTION_METADATA_KEY],
      nowDate().getTime(),
    );
    if (impact) {
      await set(persistOrgImpactAttribution$, orgId, impact, signal);
    }
    return readOrgImpactMetadata(set(writeDb$), orgId, signal);
  },
);

export async function updateImpactCustomer(
  customerId: string,
  metadata: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<void> {
  const capturedAt = metadata.impact_click_at;
  if (!metadata.impact_click_id || !capturedAt) {
    return;
  }
  const stripe = getStripeClient();
  const customer = await stripe.customers.retrieve(customerId);
  signal.throwIfAborted();
  if (
    !customer.deleted &&
    (!customer.metadata.impact_click_at ||
      customer.metadata.impact_click_at < capturedAt)
  ) {
    await stripe.customers.update(customerId, { metadata: { ...metadata } });
    signal.throwIfAborted();
  }
  if (
    customer.deleted ||
    (customer.metadata.impact_click_at &&
      customer.metadata.impact_click_at > capturedAt)
  ) {
    return;
  }
  // Stripe copies subscription metadata onto each newly created invoice.
  // Refresh future renewals while existing invoices retain their own snapshot.
  const subscriptions = await listAllStripeSubscriptions(
    stripe,
    { customer: customerId, status: "all" },
    signal,
  );
  for (const subscription of subscriptions) {
    if (
      subscription.status === "canceled" ||
      subscription.status === "incomplete_expired"
    ) {
      continue;
    }
    const previous = subscription.metadata?.impact_click_at;
    if (previous && previous >= capturedAt) {
      continue;
    }
    await stripe.subscriptions.update(subscription.id, {
      metadata: { ...metadata },
    });
    signal.throwIfAborted();
  }
}

// A returning subscriber can upgrade without creating another customer.
// Refresh an existing customer's click at login as well as at checkout.
export const syncImpactStripeCustomer$ = command(
  async (
    { get, set },
    metadata: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<void> => {
    const auth = get(authContext$);
    if (!auth.orgId || auth.orgRole !== "admin") {
      return;
    }
    const orgId = auth.orgId;
    const impact = parseImpactAttribution(
      {
        clickId: metadata.impact_click_id,
        capturedAt: metadata.impact_click_at,
      },
      nowDate().getTime(),
    );
    if (impact) {
      await set(persistOrgImpactAttribution$, orgId, impact, signal);
    }
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return;
    }
    await set(writeDb$).transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('stripe_customer_' || ${orgId}))`,
      );
      signal.throwIfAborted();
      const [row] = await tx
        .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1);
      signal.throwIfAborted();
      if (row?.stripeCustomerId) {
        const current = await readOrgImpactMetadata(tx, orgId, signal);
        await updateImpactCustomer(row.stripeCustomerId, current, signal);
      }
    });
    signal.throwIfAborted();
  },
);
