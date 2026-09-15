import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePackCreditRefunds } from "@okouai/db/schema/usage-pack-credit-refund";
import {
  USAGE_PACK_SUBSCRIPTION_MIGRATION_STATUSES,
  usagePackAllocationChanges,
  usagePackAllocations,
  usagePackInvitationPurchases,
  usagePackInvoiceFulfillments,
  usagePackPendingSnapshotGuards,
  usagePackSubscriptionMigrations,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import { command } from "ccstate";
import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { executeRawRows } from "../../lib/db-raw-rows";
import { testOverride } from "../../lib/singleton";
import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { type Db, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { lockBillingPurchaseOrg } from "../services/billing-purchase-lock.service";
import type { Tx } from "../../lib/db-types";
import {
  repairUsagePackPendingSnapshotGuards,
  writeUsagePackPendingSnapshots,
} from "../services/usage-pack-pending-snapshot.service";
import { loadOrgPlanCapabilities } from "../services/org-plan-entitlement-read.service";
import { prepareUsagePackMemberCreditRefunds } from "../services/usage-pack-credit-refund.service";
import { createDeferredPromise, onRejection } from "../utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const usagePackUsdSchema = z.union([
  z.literal(20),
  z.literal(50),
  z.literal(100),
  z.literal(200),
]);
type UsagePackUsd = z.infer<typeof usagePackUsdSchema>;
type UsagePackCreditGrantRow = typeof usagePackCreditGrants.$inferSelect;

const seedAllocationSchema = z
  .object({
    userId: z.string().min(1).nullable(),
    invitationId: z.string().min(1).nullable(),
    usagePackUsd: usagePackUsdSchema,
    stripePriceId: z.string().min(1),
    status: z
      .enum(["pending_payment", "active", "pending_invitation", "inactive"])
      .optional(),
  })
  .refine((allocation) => {
    return (allocation.userId === null) !== (allocation.invitationId === null);
  });

const actionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("seed"),
    orgId: z.string().min(1),
    tier: z.enum(["pro", "team"]),
    stripePlanPriceId: z.string().min(1),
    stripeCustomerId: z.string().min(1),
    stripeCheckoutSessionId: z.string().min(1).nullable(),
    preSerializationCutover: z.boolean().optional(),
    allocations: z.array(seedAllocationSchema).min(1),
  }),
  z.object({
    action: z.literal("read"),
    orgId: z.string().min(1),
    usagePackSubscriptionId: z.string().uuid().optional(),
  }),
  z.object({
    action: z.literal("set-updated-at"),
    orgId: z.string().min(1),
    usagePackSubscriptionId: z.string().uuid(),
    updatedAt: z.iso.datetime(),
  }),
  z.object({
    action: z.literal("correlate-legacy-checkout-session"),
    orgId: z.string().min(1),
    usagePackSubscriptionId: z.string().uuid(),
    stripeCheckoutSessionId: z.string().min(1),
    updatedAt: z.iso.datetime(),
  }),
  z.object({
    action: z.literal("hold-billing-purchase-lock"),
    orgId: z.string().min(1),
    usagePackSubscriptionId: z.string().uuid(),
    stripeCheckoutSessionId: z.string().min(1),
    updatedAt: z.iso.datetime(),
  }),
  z.object({
    action: z.literal("read-billing-purchase-lock-state"),
    orgId: z.string().min(1),
  }),
  z.object({
    action: z.literal("release-billing-purchase-lock"),
    orgId: z.string().min(1),
  }),
  z.object({
    action: z.literal("set-grant-remaining"),
    orgId: z.string().min(1),
    userId: z.string().min(1),
    grantType: z.enum(["purchased", "bonus"]),
    remainingAmount: z.number().int().nonnegative(),
    prepareRefund: z.boolean().optional(),
    refundState: z
      .object({
        status: z.enum(["pending", "processing", "succeeded", "failed"]),
        refundedAmountCents: z.number().int().nonnegative().nullable(),
        stripeCreditNoteId: z.string().nullable(),
        stripeRefundId: z.string().nullable(),
        attempt: z.number().int().positive(),
        failureReason: z.string().nullable(),
      })
      .optional(),
  }),
  z.object({
    action: z.literal("delete-refund-source"),
    orgId: z.string().min(1),
    userId: z.string().min(1),
  }),
  z.object({
    action: z.literal("seed-legacy-migration"),
    orgId: z.string().min(1),
    tier: z.enum(["pro", "team"]),
    stripeCustomerId: z.string().min(1),
    stripeSubscriptionId: z.string().min(1),
    currentPeriodEnd: z.iso.datetime(),
    legacyCreditInvoiceId: z.string().min(1),
    credits: z.number().int().positive(),
  }),
  z.object({
    action: z.literal("cleanup-migration"),
    orgId: z.string().min(1),
  }),
  z.object({
    action: z.literal("cleanup"),
    orgId: z.string().min(1),
    usagePackSubscriptionId: z.string().uuid(),
    deleteGrants: z.boolean(),
    deleteOrgMetadata: z.boolean(),
  }),
]);
type ActionBody = z.infer<typeof actionBodySchema>;
type SetGrantRemainingBody = Extract<
  ActionBody,
  { action: "set-grant-remaining" }
>;

const nullableDateSchema = z.iso.datetime().nullable();
const readStateSchema = z.object({
  subscriptionCount: z.number().int().nonnegative(),
  subscriptionIds: z.array(z.string().uuid()),
  subscription: z
    .object({
      id: z.string().uuid(),
      stripeCheckoutSessionId: z.string().nullable(),
      stripeSubscriptionId: z.string().nullable(),
      subscriptionStatus: z.string(),
      currentPeriodStart: nullableDateSchema,
      currentPeriodEnd: nullableDateSchema,
      cancelAtPeriodEnd: z.boolean(),
    })
    .nullable(),
  allocations: z.array(
    z.object({
      id: z.string().uuid(),
      userId: z.string().nullable(),
      invitationId: z.string().nullable(),
      usagePackUsd: usagePackUsdSchema,
      stripePriceId: z.string(),
      status: z.string(),
      currentPeriodStart: nullableDateSchema,
      currentPeriodEnd: nullableDateSchema,
    }),
  ),
  changes: z.array(
    z.object({
      id: z.string().uuid(),
      userId: z.string(),
      kind: z.enum(["addition", "upgrade", "downgrade", "removal"]),
      status: z.enum([
        "previewed",
        "applying",
        "pending_payment",
        "scheduled",
        "applied",
        "completed",
        "failed",
      ]),
      sourceUsagePackUsd: usagePackUsdSchema.nullable(),
      targetUsagePackUsd: usagePackUsdSchema.nullable(),
      immediateAmountCents: z.number().int().nonnegative().nullable(),
      nextRecurringAmountCents: z.number().int().nonnegative().nullable(),
      effectiveAt: nullableDateSchema,
      stripeInvoiceId: z.string().nullable(),
    }),
  ),
  invitationPurchases: z.array(
    z.object({
      id: z.string().uuid(),
      normalizedEmail: z.string(),
      status: z.string(),
      allocationId: z.string().uuid().nullable(),
      expectedAmountCents: z.number().int().nonnegative(),
      amountPaidCents: z.number().int().nonnegative().nullable(),
      purchasedCredits: z.number().int().nonnegative(),
      bonusCredits: z.number().int().nonnegative(),
      stripeCheckoutSessionId: z.string().nullable(),
      stripePaymentIntentId: z.string().nullable(),
      stripeRefundId: z.string().nullable(),
      refundAttempt: z.number().int().positive(),
      clerkInvitationId: z.string().nullable(),
      acceptedUserId: z.string().nullable(),
      currentPeriodEnd: z.iso.datetime(),
    }),
  ),
  grants: z.array(
    z.object({
      userId: z.string(),
      grantType: z.enum(["purchased", "bonus"]),
      originalAmount: z.number().int().positive(),
      expiresAt: z.iso.datetime(),
    }),
  ),
  refunds: z.array(
    z.object({
      creditGrantId: z.string().uuid(),
      userId: z.string(),
      sourceType: z.enum(["invoice", "payment_intent"]),
      stripeInvoiceId: z.string().nullable(),
      stripeInvoiceLineId: z.string().nullable(),
      stripePaymentIntentId: z.string().nullable(),
      sourceAmountCents: z.number().int().nonnegative(),
      status: z.enum([
        "available",
        "pending",
        "processing",
        "succeeded",
        "failed",
      ]),
      refundCredits: z.number().int().positive().nullable(),
      requestedAmountCents: z.number().int().positive().nullable(),
      refundedAmountCents: z.number().int().nonnegative().nullable(),
      stripeCreditNoteId: z.string().nullable(),
      stripeRefundId: z.string().nullable(),
      attempt: z.number().int().positive(),
      failureReason: z.string().nullable(),
    }),
  ),
  fulfillmentInvoiceIds: z.array(z.string()),
  remainingCredits: z.array(
    z.object({
      userId: z.string(),
      amount: z.number().int().nonnegative(),
    }),
  ),
  migrations: z.array(
    z.object({
      id: z.string().uuid(),
      status: z.enum(USAGE_PACK_SUBSCRIPTION_MIGRATION_STATUSES),
      failureReason: z.string().nullable(),
    }),
  ),
  legacyCredits: z.array(
    z.object({
      stripeInvoiceId: z.string().nullable(),
      amount: z.number().int().nonnegative(),
      remaining: z.number().int().nonnegative(),
      expiresAt: z.iso.datetime(),
    }),
  ),
  org: z
    .object({
      tier: z.string(),
      credits: z.number().int(),
      stripeSubscriptionId: z.string().nullable(),
      subscriptionStatus: z.string().nullable(),
      currentPeriodEnd: nullableDateSchema,
      cancelAtPeriodEnd: z.boolean(),
      showUsagePack: z.boolean(),
    })
    .nullable(),
});

const actionResponseSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("seeded"),
    usagePackSubscriptionId: z.string().uuid(),
  }),
  z.object({ action: z.literal("read"), state: readStateSchema }),
  z.object({
    action: z.literal("billing-purchase-lock-state"),
    held: z.boolean(),
    waiterCount: z.number().int().nonnegative(),
  }),
  z.object({ action: z.literal("ok") }),
]);

const c = initContract();
export const testUsagePackSubscriptionStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/usage-pack-subscription-state/action",
    body: actionBodySchema,
    responses: {
      200: actionResponseSchema,
      400: z.object({
        error: z.object({ code: z.string(), message: z.string() }),
      }),
      404: z.string(),
      500: z.object({ error: z.string() }),
    },
  },
});

export type TestUsagePackSubscriptionStateAction = z.infer<
  typeof actionBodySchema
>;
export type TestUsagePackSubscriptionStateResponse = z.infer<
  typeof actionResponseSchema
>;

type SeedAction = Extract<
  TestUsagePackSubscriptionStateAction,
  { readonly action: "seed" }
>;
type SeedLegacyMigrationAction = Extract<
  TestUsagePackSubscriptionStateAction,
  { readonly action: "seed-legacy-migration" }
>;
type HoldBillingPurchaseLockAction = Extract<
  TestUsagePackSubscriptionStateAction,
  { readonly action: "hold-billing-purchase-lock" }
>;
type CorrelateLegacyCheckoutSessionAction = Extract<
  TestUsagePackSubscriptionStateAction,
  { readonly action: "correlate-legacy-checkout-session" }
>;

interface BillingPurchaseLockGate {
  readonly orgId: string;
  holderPid: number | null;
  readonly released: ReturnType<typeof createDeferredPromise<void>>;
  readonly release: () => void;
}

const billingPurchaseLockGate = testOverride<BillingPurchaseLockGate | null>(
  () => {
    return null;
  },
);

const lockHolderRowSchema = z.object({ holderPid: z.int() });
const lockStateRowSchema = z.object({
  held: z.boolean(),
  waiterCount: z.int().nonnegative(),
});

function clearBillingPurchaseLockGate(gate: BillingPurchaseLockGate): void {
  if (billingPurchaseLockGate.get() === gate) {
    billingPurchaseLockGate.clear();
  }
}

async function correlateLegacyCheckoutSession(
  db: Db,
  body: CorrelateLegacyCheckoutSessionAction,
  signal: AbortSignal,
): Promise<void> {
  // The previous production writer correlates after releasing the organization
  // lock and only filters by snapshot ID. Production has no endpoint that can
  // pause and resume that deployed flow, so this test-only action reproduces
  // its unconditional update exactly while retaining org scoping for cleanup.
  const correlated = await db
    .update(usagePackSubscriptions)
    .set({
      stripeCheckoutSessionId: body.stripeCheckoutSessionId,
      updatedAt: new Date(body.updatedAt),
    })
    .where(
      and(
        eq(usagePackSubscriptions.id, body.usagePackSubscriptionId),
        eq(usagePackSubscriptions.orgId, body.orgId),
      ),
    )
    .returning({ id: usagePackSubscriptions.id });
  signal.throwIfAborted();
  if (correlated.length !== 1) {
    throw new Error("Failed to correlate the legacy Checkout Session");
  }
}

async function holdBillingPurchaseLock(
  db: Db,
  body: HoldBillingPurchaseLockAction,
  signal: AbortSignal,
): Promise<void> {
  if (billingPurchaseLockGate.get()) {
    throw new Error("A billing purchase lock gate is already active");
  }
  const released = createDeferredPromise<void>(signal);
  const gate: BillingPurchaseLockGate = {
    orgId: body.orgId,
    holderPid: null,
    released,
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
  };
  billingPurchaseLockGate.set(gate);
  await onRejection(
    db.transaction(async (tx) => {
      await lockBillingPurchaseOrg(tx, body.orgId);
      signal.throwIfAborted();
      const rows = await executeRawRows(
        tx,
        sql`SELECT pg_backend_pid() AS "holderPid"`,
        lockHolderRowSchema,
      );
      signal.throwIfAborted();
      const holder = rows[0];
      if (!holder) {
        throw new Error("Failed to read billing purchase lock holder");
      }
      gate.holderPid = holder.holderPid;
      await gate.released.promise;
      const correlated = await tx
        .update(usagePackSubscriptions)
        .set({
          stripeCheckoutSessionId: body.stripeCheckoutSessionId,
          updatedAt: new Date(body.updatedAt),
        })
        .where(
          and(
            eq(usagePackSubscriptions.id, body.usagePackSubscriptionId),
            eq(usagePackSubscriptions.orgId, body.orgId),
            eq(usagePackSubscriptions.subscriptionStatus, "checkout_pending"),
            isNull(usagePackSubscriptions.stripeCheckoutSessionId),
            isNull(usagePackSubscriptions.stripeSubscriptionId),
          ),
        )
        .returning({ id: usagePackSubscriptions.id });
      if (correlated.length !== 1) {
        throw new Error("Failed to correlate the usage pack Checkout Session");
      }
    }),
    () => {
      clearBillingPurchaseLockGate(gate);
    },
  );
  clearBillingPurchaseLockGate(gate);
}

async function readBillingPurchaseLockState(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<{ readonly held: boolean; readonly waiterCount: number }> {
  const gate = billingPurchaseLockGate.get();
  const holderPid = gate?.orgId === orgId ? gate.holderPid : null;
  if (holderPid === null || holderPid === undefined) {
    return { held: false, waiterCount: 0 };
  }
  const rows = await executeRawRows(
    db,
    sql`
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_locks held
          WHERE
            held.pid = ${holderPid}
            AND held.locktype = 'advisory'
            AND held.granted
        ) AS "held",
        (
          SELECT ${count()}::int
          FROM pg_locks held
          INNER JOIN pg_locks waiting
            ON waiting.locktype = held.locktype
            AND waiting.database IS NOT DISTINCT FROM held.database
            AND waiting.classid IS NOT DISTINCT FROM held.classid
            AND waiting.objid IS NOT DISTINCT FROM held.objid
            AND waiting.objsubid IS NOT DISTINCT FROM held.objsubid
          WHERE
            held.pid = ${holderPid}
            AND held.locktype = 'advisory'
            AND held.granted
            AND NOT waiting.granted
        ) AS "waiterCount"
    `,
    lockStateRowSchema,
  );
  signal.throwIfAborted();
  const state = rows[0];
  if (!state) {
    throw new Error("Failed to read billing purchase lock state");
  }
  return state;
}

function releaseBillingPurchaseLock(orgId: string): void {
  const gate = billingPurchaseLockGate.get();
  if (!gate || gate.orgId !== orgId) {
    throw new Error(`No billing purchase lock gate for ${orgId}`);
  }
  gate.release();
}

// Stripe callbacks and cron are production ingress surfaces, but production
// deliberately has no API for constructing a pending local correlation row or
// reading its per-member fulfillment ledger. This narrowly scoped, test-only
// boundary exposes only the state required to verify those external lifecycles.
async function seedUsagePackState(
  db: Db,
  body: SeedAction,
  signal: AbortSignal,
): Promise<string> {
  const seed = async (tx: Tx) => {
    const orgRows = await tx
      .update(orgMetadata)
      .set({ stripeCustomerId: body.stripeCustomerId })
      .where(eq(orgMetadata.orgId, body.orgId))
      .returning({ orgId: orgMetadata.orgId });
    if (orgRows.length !== 1) {
      throw new Error(`Missing organization fixture ${body.orgId}`);
    }
    if (body.preSerializationCutover === true) {
      // Let this test-only write bypass the post-0952 claim, then reconstruct
      // the exact count that the migration would have backfilled.
      await tx
        .delete(usagePackPendingSnapshotGuards)
        .where(eq(usagePackPendingSnapshotGuards.orgId, body.orgId));
    }
    const [subscription] = await tx
      .insert(usagePackSubscriptions)
      .values({
        orgId: body.orgId,
        tier: body.tier,
        stripePlanPriceId: body.stripePlanPriceId,
        stripeCustomerId: body.stripeCustomerId,
        stripeCheckoutSessionId: body.stripeCheckoutSessionId,
      })
      .returning({ id: usagePackSubscriptions.id });
    if (!subscription) {
      throw new Error("Failed to seed usage pack subscription state");
    }
    if (body.preSerializationCutover === true) {
      await repairUsagePackPendingSnapshotGuards(tx, [body.orgId]);
    }
    await tx.insert(usagePackAllocations).values(
      body.allocations.map((allocation) => {
        return {
          usagePackSubscriptionId: subscription.id,
          orgId: body.orgId,
          ...allocation,
        };
      }),
    );
    signal.throwIfAborted();
    return subscription.id;
  };
  // This fixture intentionally models rows predating admission serialization;
  // current setup writes use the same explicit boundary as product writers.
  if (body.preSerializationCutover === true) {
    return await db.transaction(seed);
  }
  return await writeUsagePackPendingSnapshots(db, [body.orgId], seed);
}

async function seedLegacyMigrationState(
  db: Db,
  body: SeedLegacyMigrationAction,
  signal: AbortSignal,
): Promise<void> {
  await db.transaction(async (tx) => {
    const currentPeriodEnd = new Date(body.currentPeriodEnd);
    const orgRows = await tx
      .update(orgMetadata)
      .set({
        tier: body.tier,
        credits: body.credits,
        stripeCustomerId: body.stripeCustomerId,
        stripeSubscriptionId: body.stripeSubscriptionId,
        subscriptionStatus: "active",
        currentPeriodEnd,
        cancelAtPeriodEnd: false,
        pendingSubscriptionScheduleId: null,
        pendingSubscriptionTargetTier: null,
        pendingSubscriptionChangeAt: null,
      })
      .where(eq(orgMetadata.orgId, body.orgId))
      .returning({ orgId: orgMetadata.orgId });
    if (orgRows.length !== 1) {
      throw new Error(`Missing organization fixture ${body.orgId}`);
    }
    await tx.insert(creditExpiresRecord).values({
      orgId: body.orgId,
      source: "subscription_renewal",
      stripeInvoiceId: body.legacyCreditInvoiceId,
      amount: body.credits,
      remaining: body.credits,
      expiresAt: currentPeriodEnd,
    });
    signal.throwIfAborted();
  });
}

function isoDate(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

interface UsagePackRelatedStateRows {
  readonly allocations: (typeof usagePackAllocations.$inferSelect)[];
  readonly fulfillments: { readonly invoiceId: string }[];
  readonly changes: (typeof usagePackAllocationChanges.$inferSelect)[];
  readonly invitationPurchases: (typeof usagePackInvitationPurchases.$inferSelect)[];
}

async function readUsagePackRelatedStateRows(
  db: Db,
  usagePackSubscriptionId: string | undefined,
): Promise<UsagePackRelatedStateRows> {
  if (!usagePackSubscriptionId) {
    return {
      allocations: [],
      fulfillments: [],
      changes: [],
      invitationPurchases: [],
    };
  }
  const [allocations, fulfillments, changes, invitationPurchases] =
    await Promise.all([
      db
        .select()
        .from(usagePackAllocations)
        .where(
          eq(
            usagePackAllocations.usagePackSubscriptionId,
            usagePackSubscriptionId,
          ),
        )
        .orderBy(asc(usagePackAllocations.id)),
      db
        .select({ invoiceId: usagePackInvoiceFulfillments.stripeInvoiceId })
        .from(usagePackInvoiceFulfillments)
        .where(
          eq(
            usagePackInvoiceFulfillments.usagePackSubscriptionId,
            usagePackSubscriptionId,
          ),
        )
        .orderBy(asc(usagePackInvoiceFulfillments.stripeInvoiceId)),
      db
        .select()
        .from(usagePackAllocationChanges)
        .where(
          eq(
            usagePackAllocationChanges.usagePackSubscriptionId,
            usagePackSubscriptionId,
          ),
        )
        .orderBy(asc(usagePackAllocationChanges.createdAt)),
      db
        .select()
        .from(usagePackInvitationPurchases)
        .where(
          eq(
            usagePackInvitationPurchases.usagePackSubscriptionId,
            usagePackSubscriptionId,
          ),
        )
        .orderBy(asc(usagePackInvitationPurchases.createdAt)),
    ]);
  return { allocations, fulfillments, changes, invitationPurchases };
}

function remainingCreditsByUser(
  grants: readonly UsagePackCreditGrantRow[],
): readonly { readonly userId: string; readonly amount: number }[] {
  const totals = new Map<string, number>();
  for (const grant of grants) {
    totals.set(
      grant.userId,
      (totals.get(grant.userId) ?? 0) + grant.remainingAmount,
    );
  }
  return [...totals].map(([userId, amount]) => {
    return { userId, amount };
  });
}

async function readUsagePackCreditRefunds(db: Db, orgId: string) {
  const refunds = await db
    .select()
    .from(usagePackCreditRefunds)
    .where(eq(usagePackCreditRefunds.orgId, orgId))
    .orderBy(asc(usagePackCreditRefunds.createdAt));
  return refunds.map((refund) => {
    return {
      creditGrantId: refund.creditGrantId,
      userId: refund.userId,
      sourceType: refund.sourceType,
      stripeInvoiceId: refund.stripeInvoiceId,
      stripeInvoiceLineId: refund.stripeInvoiceLineId,
      stripePaymentIntentId: refund.stripePaymentIntentId,
      sourceAmountCents: refund.sourceAmountCents,
      status: refund.status,
      refundCredits: refund.refundCredits,
      requestedAmountCents: refund.requestedAmountCents,
      refundedAmountCents: refund.refundedAmountCents,
      stripeCreditNoteId: refund.stripeCreditNoteId,
      stripeRefundId: refund.stripeRefundId,
      attempt: refund.attempt,
      failureReason: refund.failureReason,
    };
  });
}

async function readOrgUsagePackStateRows(db: Db, orgId: string) {
  const [grants, migrations, legacyCredits, orgRows] = await Promise.all([
    db
      .select()
      .from(usagePackCreditGrants)
      .where(eq(usagePackCreditGrants.orgId, orgId))
      .orderBy(
        asc(usagePackCreditGrants.expiresAt),
        asc(usagePackCreditGrants.grantType),
      ),
    db
      .select({
        id: usagePackSubscriptionMigrations.id,
        status: usagePackSubscriptionMigrations.status,
        failureReason: usagePackSubscriptionMigrations.failureReason,
      })
      .from(usagePackSubscriptionMigrations)
      .where(eq(usagePackSubscriptionMigrations.orgId, orgId))
      .orderBy(asc(usagePackSubscriptionMigrations.createdAt)),
    db
      .select({
        stripeInvoiceId: creditExpiresRecord.stripeInvoiceId,
        amount: creditExpiresRecord.amount,
        remaining: creditExpiresRecord.remaining,
        expiresAt: creditExpiresRecord.expiresAt,
      })
      .from(creditExpiresRecord)
      .where(eq(creditExpiresRecord.orgId, orgId))
      .orderBy(asc(creditExpiresRecord.createdAt)),
    db.select().from(orgMetadata).where(eq(orgMetadata.orgId, orgId)).limit(1),
  ]);
  return { grants, migrations, legacyCredits, org: orgRows[0] ?? null };
}

async function readUsagePackState(
  db: Db,
  orgId: string,
  usagePackSubscriptionId: string | undefined,
  signal: AbortSignal,
) {
  const subscriptions = await db
    .select({ id: usagePackSubscriptions.id })
    .from(usagePackSubscriptions)
    .where(eq(usagePackSubscriptions.orgId, orgId))
    .orderBy(asc(usagePackSubscriptions.createdAt));
  const subscriptionCount = subscriptions.length;
  const [subscription] = usagePackSubscriptionId
    ? await db
        .select()
        .from(usagePackSubscriptions)
        .where(
          and(
            eq(usagePackSubscriptions.id, usagePackSubscriptionId),
            eq(usagePackSubscriptions.orgId, orgId),
          ),
        )
        .limit(1)
    : [];
  const { allocations, fulfillments, changes, invitationPurchases } =
    await readUsagePackRelatedStateRows(db, subscription?.id);
  const refunds = await readUsagePackCreditRefunds(db, orgId);
  const { grants, migrations, legacyCredits, org } =
    await readOrgUsagePackStateRows(db, orgId);
  const capabilities = await loadOrgPlanCapabilities(db, orgId);
  signal.throwIfAborted();

  return {
    subscriptionCount,
    subscriptionIds: subscriptions.map((row) => {
      return row.id;
    }),
    subscription: subscription
      ? {
          id: subscription.id,
          stripeCheckoutSessionId: subscription.stripeCheckoutSessionId,
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          subscriptionStatus: subscription.subscriptionStatus,
          currentPeriodStart: isoDate(subscription.currentPeriodStart),
          currentPeriodEnd: isoDate(subscription.currentPeriodEnd),
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        }
      : null,
    allocations: allocations.map((allocation) => {
      return {
        id: allocation.id,
        userId: allocation.userId,
        invitationId: allocation.invitationId,
        usagePackUsd: allocation.usagePackUsd as 20 | 50 | 100 | 200,
        stripePriceId: allocation.stripePriceId,
        status: allocation.status,
        currentPeriodStart: isoDate(allocation.currentPeriodStart),
        currentPeriodEnd: isoDate(allocation.currentPeriodEnd),
      };
    }),
    changes: changes.map((change) => {
      return {
        id: change.id,
        userId: change.userId,
        kind: change.kind,
        status: change.status,
        sourceUsagePackUsd: change.sourceUsagePackUsd as UsagePackUsd | null,
        targetUsagePackUsd: change.targetUsagePackUsd as UsagePackUsd | null,
        immediateAmountCents: change.immediateAmountCents,
        nextRecurringAmountCents: change.nextRecurringAmountCents,
        effectiveAt: isoDate(change.effectiveAt),
        stripeInvoiceId: change.stripeInvoiceId,
      };
    }),
    invitationPurchases: invitationPurchases.map((purchase) => {
      return {
        id: purchase.id,
        normalizedEmail: purchase.normalizedEmail,
        status: purchase.status,
        allocationId: purchase.allocationId,
        expectedAmountCents: purchase.expectedAmountCents,
        amountPaidCents: purchase.amountPaidCents,
        purchasedCredits: purchase.purchasedCredits,
        bonusCredits: purchase.bonusCredits,
        stripeCheckoutSessionId: purchase.stripeCheckoutSessionId,
        stripePaymentIntentId: purchase.stripePaymentIntentId,
        stripeRefundId: purchase.stripeRefundId,
        refundAttempt: purchase.refundAttempt,
        clerkInvitationId: purchase.clerkInvitationId,
        acceptedUserId: purchase.acceptedUserId,
        currentPeriodEnd: purchase.currentPeriodEnd.toISOString(),
      };
    }),
    grants: grants.map((grant) => {
      return {
        userId: grant.userId,
        grantType: grant.grantType,
        originalAmount: grant.originalAmount,
        expiresAt: grant.expiresAt.toISOString(),
      };
    }),
    refunds,
    fulfillmentInvoiceIds: fulfillments.map((row) => {
      return row.invoiceId;
    }),
    remainingCredits: remainingCreditsByUser(grants),
    migrations,
    legacyCredits: legacyCredits.map((credit) => {
      return { ...credit, expiresAt: credit.expiresAt.toISOString() };
    }),
    org: org
      ? {
          tier: org.tier,
          credits: org.credits,
          stripeSubscriptionId: org.stripeSubscriptionId,
          subscriptionStatus: org.subscriptionStatus,
          currentPeriodEnd: isoDate(org.currentPeriodEnd),
          cancelAtPeriodEnd: org.cancelAtPeriodEnd,
          showUsagePack: capabilities?.showUsagePack ?? false,
        }
      : null,
  };
}

async function cleanupMigrationState(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  await writeUsagePackPendingSnapshots(db, [orgId], async (tx) => {
    await tx
      .delete(usagePackCreditGrants)
      .where(eq(usagePackCreditGrants.orgId, orgId));
    await tx
      .delete(usagePackSubscriptions)
      .where(eq(usagePackSubscriptions.orgId, orgId));
    await tx
      .delete(usagePackSubscriptionMigrations)
      .where(eq(usagePackSubscriptionMigrations.orgId, orgId));
    await tx
      .delete(creditExpiresRecord)
      .where(eq(creditExpiresRecord.orgId, orgId));
    signal.throwIfAborted();
  });
}

async function cleanupUsagePackState(
  db: Db,
  body: Extract<
    TestUsagePackSubscriptionStateAction,
    { readonly action: "cleanup" }
  >,
  signal: AbortSignal,
): Promise<void> {
  await writeUsagePackPendingSnapshots(db, [body.orgId], async (tx) => {
    if (body.deleteGrants) {
      await tx
        .delete(usagePackCreditGrants)
        .where(eq(usagePackCreditGrants.orgId, body.orgId));
    }
    await tx
      .delete(usagePackSubscriptions)
      .where(
        and(
          eq(usagePackSubscriptions.id, body.usagePackSubscriptionId),
          eq(usagePackSubscriptions.orgId, body.orgId),
        ),
      );
    if (body.deleteOrgMetadata) {
      await tx.delete(orgMetadata).where(eq(orgMetadata.orgId, body.orgId));
    }
    signal.throwIfAborted();
  });
}

async function setGrantRemaining(
  db: Db,
  body: SetGrantRemainingBody,
  signal: AbortSignal,
): Promise<void> {
  const rows = await db
    .update(usagePackCreditGrants)
    .set({ remainingAmount: body.remainingAmount })
    .where(
      and(
        eq(usagePackCreditGrants.orgId, body.orgId),
        eq(usagePackCreditGrants.userId, body.userId),
        eq(usagePackCreditGrants.grantType, body.grantType),
      ),
    )
    .returning({ id: usagePackCreditGrants.id });
  signal.throwIfAborted();
  if (rows.length !== 1) {
    throw new Error("Expected one usage pack credit grant to update");
  }
  if (body.prepareRefund) {
    await prepareUsagePackMemberCreditRefunds(db, body);
    signal.throwIfAborted();
  }
  if (body.refundState) {
    const refunds = await db
      .update(usagePackCreditRefunds)
      .set({
        ...body.refundState,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(usagePackCreditRefunds.orgId, body.orgId),
          eq(usagePackCreditRefunds.userId, body.userId),
        ),
      )
      .returning({ creditGrantId: usagePackCreditRefunds.creditGrantId });
    signal.throwIfAborted();
    if (refunds.length !== 1) {
      throw new Error("Expected one usage pack credit refund to update");
    }
  }
}

const actionBody$ = bodyResultOf(testUsagePackSubscriptionStateContract.action);

const mutateTestUsagePackSubscriptionState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const body = bodyResult.data;
    switch (body.action) {
      case "seed": {
        const usagePackSubscriptionId = await seedUsagePackState(
          db,
          body,
          signal,
        );
        return {
          status: 200 as const,
          body: { action: "seeded" as const, usagePackSubscriptionId },
        };
      }
      case "read": {
        const state = await readUsagePackState(
          db,
          body.orgId,
          body.usagePackSubscriptionId,
          signal,
        );
        return {
          status: 200 as const,
          body: { action: "read" as const, state },
        };
      }
      case "set-updated-at": {
        await db
          .update(usagePackSubscriptions)
          .set({ updatedAt: new Date(body.updatedAt) })
          .where(
            and(
              eq(usagePackSubscriptions.id, body.usagePackSubscriptionId),
              eq(usagePackSubscriptions.orgId, body.orgId),
            ),
          );
        signal.throwIfAborted();
        return { status: 200 as const, body: { action: "ok" as const } };
      }
      case "correlate-legacy-checkout-session": {
        await correlateLegacyCheckoutSession(db, body, signal);
        return { status: 200 as const, body: { action: "ok" as const } };
      }
      case "hold-billing-purchase-lock": {
        await holdBillingPurchaseLock(db, body, signal);
        return { status: 200 as const, body: { action: "ok" as const } };
      }
      case "read-billing-purchase-lock-state": {
        const state = await readBillingPurchaseLockState(
          db,
          body.orgId,
          signal,
        );
        return {
          status: 200 as const,
          body: {
            action: "billing-purchase-lock-state" as const,
            ...state,
          },
        };
      }
      case "release-billing-purchase-lock": {
        releaseBillingPurchaseLock(body.orgId);
        return { status: 200 as const, body: { action: "ok" as const } };
      }
      case "set-grant-remaining": {
        await setGrantRemaining(db, body, signal);
        return { status: 200 as const, body: { action: "ok" as const } };
      }
      case "delete-refund-source": {
        const rows = await db
          .delete(usagePackCreditRefunds)
          .where(
            and(
              eq(usagePackCreditRefunds.orgId, body.orgId),
              eq(usagePackCreditRefunds.userId, body.userId),
            ),
          )
          .returning({ creditGrantId: usagePackCreditRefunds.creditGrantId });
        signal.throwIfAborted();
        if (rows.length !== 1) {
          throw new Error("Expected one usage pack refund source to delete");
        }
        return { status: 200 as const, body: { action: "ok" as const } };
      }
      case "seed-legacy-migration": {
        await seedLegacyMigrationState(db, body, signal);
        return { status: 200 as const, body: { action: "ok" as const } };
      }
      case "cleanup-migration": {
        await cleanupMigrationState(db, body.orgId, signal);
        return { status: 200 as const, body: { action: "ok" as const } };
      }
      case "cleanup": {
        await cleanupUsagePackState(db, body, signal);
        return { status: 200 as const, body: { action: "ok" as const } };
      }
    }
  },
);

export const testUsagePackSubscriptionStateRoutes: readonly RouteEntry[] = [
  {
    route: testUsagePackSubscriptionStateContract.action,
    handler: mutateTestUsagePackSubscriptionState$,
  },
];
