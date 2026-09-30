import {
  prepareGetStartedInvitation$,
  linkGetStartedInvitation$,
} from "./get-started-invitation.service";
import type {
  OrgInvitationPurchasePreviewResponse,
  OrgRole,
} from "@okouai/api-contracts/contracts/org-members";
import type { UsagePackUsd } from "@okouai/api-contracts/contracts/billing";
import {
  usagePackAllocations,
  usagePackInvitationPurchases,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { command } from "ccstate";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import {
  clerk$,
  createClerkReadContext,
  type ClerkClient,
  type ClerkReadContext,
} from "../external/clerk";
import { writeDb$ } from "../external/db";
import {
  getStripeClient,
  type StripeClient,
  type StripeInvoice,
  type StripePaymentIntent,
  type StripePrice,
  type StripeRefund,
} from "../external/stripe-client";
import {
  calculateUsagePackAdditionCreditGrant,
  usagePackBillingCompatibilityLockSql,
  previewUsagePackAllocationAddition$,
  syncUsagePackSubscriptionConfiguration$,
  type UsagePackAllocationAdditionChargePreview,
  type UsagePackAllocationAdditionPreview,
} from "./usage-pack-allocation-change.service";
import { invitationActivationGrantSql } from "./usage-pack-invitation-grants";
import {
  conflictingUsagePackMutationSql,
  invitationMutationSubscriptionSql,
} from "./usage-pack-mutation-admission";
import { acceptGetStartedInvitation$ } from "./get-started-invitation-acceptance.service";
import type { BillingReconciliationScope } from "./billing-reconciliation-scope";
import { completeBillingOperationInvoice } from "./billing-operation-invoice.service";
import {
  isCurrentStripePreviewMetadata,
  stripePreviewMetadata,
} from "./stripe-preview-metadata.service";
import { activeUsagePackPriceId } from "./billing-checkout.service";
import {
  resolveBillingPurchaseRoute,
  stripeBillingPurchasePaymentParams,
  type BillingPurchasePaymentMethod,
} from "./billing-payment-method.service";
import {
  BillingClerkReadRateLimitError,
  loadBillingOrganizationDirectory,
  loadBillingOrganizationMemberships,
  loadBillingOrganizationPendingInvitations,
} from "./billing-clerk-directory.service";
import { onRejection, settle } from "../utils";
import { memberRewardWalletQuery } from "./get-started-member-reward";

const PURPOSE = "usage_pack_invitation_purchase";
const PURCHASE_ID_METADATA_KEY = "usagePackInvitationPurchaseId";
const RECONCILIATION_DELAY_MS = 5 * 60 * 1000;
const RECONCILIATION_BATCH_SIZE = 100;
const MIN_CHECKOUT_DURATION_SECONDS = 30 * 60;
const MAX_CHECKOUT_DURATION_SECONDS = 24 * 60 * 60;
const L = logger("UsagePackInvitationPurchase");
const OPEN_INVITATION_PURCHASE_STATUSES = [
  "checkout_pending",
  "payment_succeeded",
  "creating_invitation",
  "invitation_pending",
  "accepted_pending_activation",
  "activating",
] as const;
const TERMINAL_SUBSCRIPTION_STATUSES = [
  "canceled",
  "incomplete_expired",
  "invalid",
] as const;

type UsagePackSubscriptionRow = typeof usagePackSubscriptions.$inferSelect;
type UsagePackInvitationPurchaseRow =
  typeof usagePackInvitationPurchases.$inferSelect;
type UsagePackInvitationPurchaseStatus =
  UsagePackInvitationPurchaseRow["status"];
type StripeObjectReference = string | { readonly id: string };

export type UsagePackInvitationPurchaseConflictReason =
  | "billing_period_ending"
  | "billing_state_changed"
  | "invitee_unavailable"
  | "no_credits"
  | "payment_method_changed"
  | "purchase_in_progress"
  | "purchase_inactive"
  | "subscription_canceling"
  | "subscription_changed"
  | "subscription_unavailable";

type UsagePackInvitationPurchaseDiagnostics = Readonly<
  Record<string, string | number | boolean | null>
>;

interface UsagePackInvitationPurchaseConflictResult {
  readonly status: "conflict";
  readonly reason: UsagePackInvitationPurchaseConflictReason;
  readonly diagnostics: UsagePackInvitationPurchaseDiagnostics;
}

interface PendingInvitationPurchaseArgs {
  readonly subscription: UsagePackSubscriptionRow;
  readonly orgId: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly inviterUserId: string;
  readonly usagePackUsd: UsagePackUsd;
  readonly stripePriceId: string;
  readonly preview: UsagePackAllocationAdditionPreview;
  readonly unitAmountCents: number;
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
  readonly checkoutExpiresAt: number;
}

interface SuccessfulPaymentArgs {
  readonly purchaseId: string;
  readonly checkoutSessionId?: string;
  readonly paymentIntentId: string | null;
  readonly customerId: string;
  readonly amountPaidCents: number;
  readonly currency: string;
  readonly paidAt: Date;
}

interface UsagePackInvitationAcceptanceArgs {
  readonly orgId: string;
  readonly invitationId?: string;
  readonly userId: string;
  readonly acceptedAt: Date;
  readonly normalizedEmail?: string;
  readonly purchaseId?: string;
}

interface UsagePackInvitationCheckoutSessionInput {
  readonly id: string;
  readonly customer: StripeObjectReference | null;
  readonly payment_intent?: StripeObjectReference | null;
  readonly metadata: Record<string, string> | null;
  readonly mode?: string | null;
  readonly payment_status?: string | null;
  readonly amount_total?: number | null;
  readonly currency?: string | null;
}

type CreateUsagePackInvitationPreviewResult =
  | {
      readonly status: "ready";
      readonly preview: OrgInvitationPurchasePreviewResponse;
    }
  | { readonly status: "not_found" }
  | UsagePackInvitationPurchaseConflictResult;

type ConfirmUsagePackInvitationPurchaseResult =
  | { readonly status: "confirmed" }
  | { readonly status: "pending_payment"; readonly hostedInvoiceUrl: string }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | UsagePackInvitationPurchaseConflictResult;

interface PreparedUsagePackInvitationPurchase {
  readonly preview: UsagePackAllocationAdditionPreview;
  readonly purchaseId: string;
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
  readonly expiresAt: Date;
}

interface PrepareUsagePackInvitationPurchaseArgs {
  readonly orgId: string;
  readonly inviterUserId: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly usagePackUsd: UsagePackUsd;
}

interface NewUsagePackInvitationPurchaseInput {
  readonly email: string;
  readonly stripePriceId: string;
}

type PrepareUsagePackInvitationPurchaseResult =
  | {
      readonly status: "ready";
      readonly purchase: PreparedUsagePackInvitationPurchase;
    }
  | { readonly status: "not_found" }
  | UsagePackInvitationPurchaseConflictResult;

type RevokeUsagePackInvitationResult =
  | { readonly status: "not_found" }
  | { readonly status: "accepted" }
  | { readonly status: "revoked" };

interface ClerkMembershipIdentity {
  readonly email: string;
  readonly userId: string;
  readonly createdAt: Date;
}

const ACCEPTABLE_INVITATION_PURCHASE_STATUSES: ReadonlySet<UsagePackInvitationPurchaseStatus> =
  Object.freeze(
    new Set<UsagePackInvitationPurchaseStatus>([
      "payment_succeeded",
      "creating_invitation",
      "invitation_pending",
    ]),
  );
const ACCEPTANCE_IN_PROGRESS_STATUSES: ReadonlySet<UsagePackInvitationPurchaseStatus> =
  Object.freeze(
    new Set<UsagePackInvitationPurchaseStatus>([
      "accepted_pending_activation",
      "activating",
    ]),
  );
const ACCEPTED_PURCHASE_STATUSES: ReadonlySet<UsagePackInvitationPurchaseStatus> =
  Object.freeze(
    new Set<UsagePackInvitationPurchaseStatus>([
      "accepted",
      "accepted_pending_activation",
      "activating",
    ]),
  );
const IGNORED_ACCEPTANCE_STATUSES: ReadonlySet<UsagePackInvitationPurchaseStatus> =
  Object.freeze(
    new Set<UsagePackInvitationPurchaseStatus>([
      "checkout_pending",
      "failed",
      "refund_pending",
      "refunding",
      "refunded",
      "accepted",
    ]),
  );
const REFUND_STATUSES: ReadonlySet<UsagePackInvitationPurchaseStatus> =
  Object.freeze(
    new Set<UsagePackInvitationPurchaseStatus>([
      "refund_pending",
      "refunding",
      "refunded",
    ]),
  );

function stripeObjectId(
  value: StripeObjectReference | null | undefined,
): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function propertyOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return Reflect.get(value, key);
}

function stringPropertyOf(value: unknown, key: string): string | null {
  const property = propertyOf(value, key);
  return typeof property === "string" ? property : null;
}

function numberPropertyOf(value: unknown, key: string): number | null {
  const property = propertyOf(value, key);
  return typeof property === "number" && Number.isFinite(property)
    ? property
    : null;
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function purchaseIdFromMetadata(
  metadata: Readonly<Record<string, string>> | null | undefined,
): string | null {
  return metadata?.purpose === PURPOSE
    ? (metadata[PURCHASE_ID_METADATA_KEY] ?? null)
    : null;
}

function clerkInvitationPurchaseId(invitation: unknown): string | null {
  const metadata =
    propertyOf(invitation, "privateMetadata") ??
    propertyOf(invitation, "private_metadata");
  return stringPropertyOf(metadata, PURCHASE_ID_METADATA_KEY);
}

function clerkMembershipIdentity(
  membership: unknown,
): ClerkMembershipIdentity | null {
  const publicUserData =
    propertyOf(membership, "publicUserData") ??
    propertyOf(membership, "public_user_data");
  const email = stringPropertyOf(publicUserData, "identifier");
  const userId =
    stringPropertyOf(publicUserData, "userId") ??
    stringPropertyOf(publicUserData, "user_id");
  const createdAt =
    numberPropertyOf(membership, "createdAt") ??
    numberPropertyOf(membership, "created_at");
  return email && userId && createdAt !== null
    ? { email: normalizedEmail(email), userId, createdAt: new Date(createdAt) }
    : null;
}

function checkoutExpiration(currentPeriodEnd: Date): number | null {
  const current = Math.floor(nowDate().getTime() / 1000);
  const expiration = Math.min(
    Math.floor(currentPeriodEnd.getTime() / 1000),
    current + MAX_CHECKOUT_DURATION_SECONDS,
  );
  return expiration >= current + MIN_CHECKOUT_DURATION_SECONDS
    ? expiration
    : null;
}

const currentUsagePackSubscriptionForOrg$ = command(
  async (
    { set },
    orgId: string,
    signal?: AbortSignal,
  ): Promise<UsagePackSubscriptionRow | null> => {
    const db = set(writeDb$);
    const [subscription] = await db
      .select()
      .from(usagePackSubscriptions)
      .where(
        and(
          eq(usagePackSubscriptions.orgId, orgId),
          isNotNull(usagePackSubscriptions.stripeSubscriptionId),
          notInArray(usagePackSubscriptions.subscriptionStatus, [
            ...TERMINAL_SUBSCRIPTION_STATUSES,
          ]),
        ),
      )
      .orderBy(desc(usagePackSubscriptions.updatedAt))
      .limit(1);
    signal?.throwIfAborted();
    return subscription ?? null;
  },
);

async function emailAlreadyBelongsToOrg(
  clerk: ClerkClient,
  orgId: string,
  email: string,
  signal: AbortSignal,
): Promise<boolean> {
  const { memberships, invitations } = await loadBillingOrganizationDirectory(
    clerk,
    orgId,
    signal,
  );
  return (
    memberships.some((membership) => {
      return clerkMembershipIdentity(membership)?.email === email;
    }) ||
    invitations.some((invitation) => {
      return normalizedEmail(invitation.emailAddress) === email;
    })
  );
}

function checkoutMetadata(
  purchase: UsagePackInvitationPurchaseRow,
): Record<string, string> {
  return {
    ...stripePreviewMetadata(),
    purpose: PURPOSE,
    [PURCHASE_ID_METADATA_KEY]: purchase.id,
    purchaseCreatedAt: purchase.createdAt.toISOString(),
  };
}

const insertPendingInvitationPurchase$ = command(
  async (
    { set },
    args: PendingInvitationPurchaseArgs,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      signal.throwIfAborted();
      await tx
        .update(usagePackInvitationPurchases)
        .set({
          status: "failed",
          failureReason: "superseded_by_new_preview",
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(usagePackInvitationPurchases.orgId, args.orgId),
            eq(usagePackInvitationPurchases.normalizedEmail, args.email),
            eq(usagePackInvitationPurchases.status, "checkout_pending"),
            isNull(usagePackInvitationPurchases.stripeCheckoutSessionId),
          ),
        );
      const [created] = await tx
        .insert(usagePackInvitationPurchases)
        .values({
          usagePackSubscriptionId: args.subscription.id,
          orgId: args.orgId,
          normalizedEmail: args.email,
          role: args.role,
          inviterUserId: args.inviterUserId,
          usagePackUsd: args.usagePackUsd,
          stripePriceId: args.stripePriceId,
          currentPeriodStart: args.preview.currentPeriodStart,
          currentPeriodEnd: args.preview.currentPeriodEnd,
          prorationTimestamp: args.preview.prorationTimestamp,
          unitAmountCents: args.unitAmountCents,
          expectedAmountCents: args.preview.amountCents,
          currency: args.preview.currency,
          purchasedCredits: args.purchasedCredits,
          bonusCredits: args.bonusCredits,
          stripeCheckoutExpiresAt: new Date(args.checkoutExpiresAt * 1000),
        })
        .onConflictDoNothing()
        .returning({ id: usagePackInvitationPurchases.id });
      return created?.id ?? null;
    });
  },
);

const reusablePendingInvitationPurchase$ = command(
  async (
    { set },
    args: {
      readonly subscriptionId: string;
      readonly orgId: string;
      readonly email: string;
      readonly role: OrgRole;
      readonly inviterUserId: string;
      readonly usagePackUsd: UsagePackUsd;
      readonly stripePriceId: string;
    },
    signal: AbortSignal,
  ): Promise<UsagePackInvitationPurchaseRow | null> => {
    const db = set(writeDb$);
    const [purchase] = await db
      .select()
      .from(usagePackInvitationPurchases)
      .where(
        and(
          eq(
            usagePackInvitationPurchases.usagePackSubscriptionId,
            args.subscriptionId,
          ),
          eq(usagePackInvitationPurchases.orgId, args.orgId),
          eq(usagePackInvitationPurchases.normalizedEmail, args.email),
          eq(usagePackInvitationPurchases.role, args.role),
          eq(usagePackInvitationPurchases.inviterUserId, args.inviterUserId),
          eq(usagePackInvitationPurchases.usagePackUsd, args.usagePackUsd),
          eq(usagePackInvitationPurchases.stripePriceId, args.stripePriceId),
          eq(usagePackInvitationPurchases.status, "checkout_pending"),
          isNull(usagePackInvitationPurchases.stripeCheckoutSessionId),
          gt(usagePackInvitationPurchases.stripeCheckoutExpiresAt, nowDate()),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return purchase ?? null;
  },
);

function preparedInvitationPurchaseFromRow(
  purchase: UsagePackInvitationPurchaseRow,
  expiresAt: Date,
): PreparedUsagePackInvitationPurchase {
  return {
    preview: {
      amountCents: purchase.expectedAmountCents,
      currency: purchase.currency,
      currentPeriodStart: purchase.currentPeriodStart,
      currentPeriodEnd: purchase.currentPeriodEnd,
      prorationTimestamp: purchase.prorationTimestamp,
    },
    purchaseId: purchase.id,
    purchasedCredits: purchase.purchasedCredits,
    bonusCredits: purchase.bonusCredits,
    expiresAt,
  };
}

const prepareNewUsagePackInvitationPurchase$ = command(
  async (
    { set },
    subscription: UsagePackSubscriptionRow,
    args: PrepareUsagePackInvitationPurchaseArgs,
    input: NewUsagePackInvitationPurchaseInput,
    signal: AbortSignal,
  ): Promise<PrepareUsagePackInvitationPurchaseResult> => {
    const { email, stripePriceId } = input;
    const preview = await set(
      previewUsagePackAllocationAddition$,
      {
        usagePackSubscriptionId: subscription.id,
        stripePriceId,
      },
      signal,
    );
    const stripe = getStripeClient();
    const [price, creditGrant] = await Promise.all([
      stripe.prices.retrieve(stripePriceId, { expand: ["product"] }),
      calculateUsagePackAdditionCreditGrant(
        stripePriceId,
        {
          start: Math.floor(preview.currentPeriodStart.getTime() / 1000),
          end: Math.floor(preview.currentPeriodEnd.getTime() / 1000),
        },
        preview.prorationTimestamp,
      ),
    ]);
    signal.throwIfAborted();
    if (
      price.currency !== preview.currency ||
      price.unit_amount === null ||
      price.unit_amount <= 0
    ) {
      throw new Error("Usage pack invitation Price does not match its preview");
    }
    const unitAmountCents = price.unit_amount;
    const { purchasedCredits, bonusCredits } = creditGrant;
    if (purchasedCredits <= 0) {
      return {
        status: "conflict",
        reason: "no_credits",
        diagnostics: {
          amountCents: preview.amountCents,
          unitAmountCents,
          purchasedCredits,
        },
      };
    }
    const checkoutExpiresAt = checkoutExpiration(preview.currentPeriodEnd);
    if (checkoutExpiresAt === null) {
      return {
        status: "conflict",
        reason: "billing_period_ending",
        diagnostics: {
          currentPeriodEnd: preview.currentPeriodEnd.toISOString(),
        },
      };
    }

    const purchaseId = await set(
      insertPendingInvitationPurchase$,
      {
        subscription,
        orgId: args.orgId,
        email,
        role: args.role,
        inviterUserId: args.inviterUserId,
        usagePackUsd: args.usagePackUsd,
        stripePriceId,
        preview,
        unitAmountCents,
        purchasedCredits,
        bonusCredits,
        checkoutExpiresAt,
      },
      signal,
    );
    if (!purchaseId) {
      return {
        status: "conflict",
        reason: "purchase_in_progress",
        diagnostics: {},
      };
    }
    signal.throwIfAborted();
    return {
      status: "ready",
      purchase: {
        preview,
        purchaseId,
        purchasedCredits,
        bonusCredits,
        expiresAt: new Date(checkoutExpiresAt * 1000),
      },
    };
  },
);

const prepareUsagePackInvitationPurchase$ = command(
  async (
    { get, set },
    args: PrepareUsagePackInvitationPurchaseArgs,
    signal: AbortSignal,
  ): Promise<PrepareUsagePackInvitationPurchaseResult> => {
    const db = set(writeDb$);
    const [subscription] = await db
      .select()
      .from(usagePackSubscriptions)
      .where(
        and(
          eq(usagePackSubscriptions.orgId, args.orgId),
          isNotNull(usagePackSubscriptions.stripeSubscriptionId),
          notInArray(usagePackSubscriptions.subscriptionStatus, [
            ...TERMINAL_SUBSCRIPTION_STATUSES,
          ]),
        ),
      )
      .orderBy(desc(usagePackSubscriptions.updatedAt))
      .limit(1);
    signal.throwIfAborted();
    if (!subscription?.stripeSubscriptionId) {
      return { status: "not_found" };
    }
    if (subscription.cancelAtPeriodEnd) {
      return {
        status: "conflict",
        reason: "subscription_canceling",
        diagnostics: {
          subscriptionStatus: subscription.subscriptionStatus,
          cancelAtPeriodEnd: true,
        },
      };
    }
    const email = normalizedEmail(args.email);
    if (
      await emailAlreadyBelongsToOrg(get(clerk$), args.orgId, email, signal)
    ) {
      return {
        status: "conflict",
        reason: "invitee_unavailable",
        diagnostics: {},
      };
    }
    signal.throwIfAborted();

    const stripePriceId = activeUsagePackPriceId(args.usagePackUsd);
    if (!stripePriceId) {
      throw new Error(
        `Usage pack $${args.usagePackUsd} Price is not configured`,
      );
    }
    const reusablePurchase = await set(
      reusablePendingInvitationPurchase$,
      {
        subscriptionId: subscription.id,
        orgId: args.orgId,
        email,
        role: args.role,
        inviterUserId: args.inviterUserId,
        usagePackUsd: args.usagePackUsd,
        stripePriceId,
      },
      signal,
    );
    if (reusablePurchase?.stripeCheckoutExpiresAt) {
      return {
        status: "ready",
        purchase: preparedInvitationPurchaseFromRow(
          reusablePurchase,
          reusablePurchase.stripeCheckoutExpiresAt,
        ),
      };
    }
    return await set(
      prepareNewUsagePackInvitationPurchase$,
      subscription,
      args,
      { email, stripePriceId },
      signal,
    );
  },
);

export const createUsagePackInvitationPreview$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly inviterUserId: string;
      readonly email: string;
      readonly role: OrgRole;
      readonly usagePackUsd: UsagePackUsd;
    },
    signal: AbortSignal,
  ): Promise<CreateUsagePackInvitationPreviewResult> => {
    const result = await set(prepareUsagePackInvitationPurchase$, args, signal);
    if (result.status !== "ready") {
      return result;
    }
    const { purchase } = result;
    return {
      status: "ready",
      preview: {
        purchaseId: purchase.purchaseId,
        usagePackUsd: args.usagePackUsd,
        immediateAmountCents: purchase.preview.amountCents,
        currency: purchase.preview.currency,
        purchasedCredits: purchase.purchasedCredits,
        bonusCredits: purchase.bonusCredits,
        totalCredits: purchase.purchasedCredits + purchase.bonusCredits,
        currentPeriodEnd: purchase.preview.currentPeriodEnd.toISOString(),
        expiresAt: purchase.expiresAt.toISOString(),
      },
    };
  },
);

const loadPurchase$ = command(
  async (
    { set },
    purchaseId: string,
    signal?: AbortSignal,
  ): Promise<UsagePackInvitationPurchaseRow | null> => {
    const db = set(writeDb$);
    const [purchase] = await db
      .select()
      .from(usagePackInvitationPurchases)
      .where(eq(usagePackInvitationPurchases.id, purchaseId))
      .limit(1);
    signal?.throwIfAborted();
    return purchase ?? null;
  },
);

function validateSuccessfulPayment(
  purchase: UsagePackInvitationPurchaseRow,
  stripeCustomerId: string | null | undefined,
  args: SuccessfulPaymentArgs,
): void {
  if (
    stripeCustomerId !== args.customerId ||
    (args.checkoutSessionId &&
      purchase.stripeCheckoutSessionId &&
      purchase.stripeCheckoutSessionId !== args.checkoutSessionId) ||
    purchase.currency !== args.currency
  ) {
    throw new Error("Stripe invitation payment does not match local billing");
  }
  if (
    (args.amountPaidCents > 0 && !args.paymentIntentId) ||
    (purchase.stripePaymentIntentId &&
      purchase.stripePaymentIntentId !== args.paymentIntentId)
  ) {
    throw new Error("Invitation purchase has a different PaymentIntent");
  }
  if (
    purchase.amountPaidCents !== null &&
    purchase.amountPaidCents !== args.amountPaidCents
  ) {
    throw new Error("Invitation purchase has a different paid amount");
  }
}

const persistSuccessfulPayment$ = command(
  async (
    { set },
    args: SuccessfulPaymentArgs,
    signal?: AbortSignal,
  ): Promise<UsagePackInvitationPurchaseRow> => {
    signal?.throwIfAborted();
    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      const [purchase] = await tx
        .select()
        .from(usagePackInvitationPurchases)
        .where(eq(usagePackInvitationPurchases.id, args.purchaseId))
        .limit(1);
      if (!purchase) {
        throw new Error(
          `Unknown usage pack invitation purchase ${args.purchaseId}`,
        );
      }
      const [subscription] = await tx
        .select({ stripeCustomerId: usagePackSubscriptions.stripeCustomerId })
        .from(usagePackSubscriptions)
        .where(eq(usagePackSubscriptions.id, purchase.usagePackSubscriptionId))
        .limit(1);
      validateSuccessfulPayment(purchase, subscription?.stripeCustomerId, args);
      if (purchase.status === "refunded") {
        return purchase;
      }
      if (
        purchase.status !== "checkout_pending" &&
        purchase.status !== "failed" &&
        purchase.status !== "payment_succeeded"
      ) {
        return purchase;
      }
      const [competing] = await tx
        .select({
          id: usagePackInvitationPurchases.id,
          status: usagePackInvitationPurchases.status,
        })
        .from(usagePackInvitationPurchases)
        .where(
          and(
            ne(usagePackInvitationPurchases.id, purchase.id),
            eq(usagePackInvitationPurchases.orgId, purchase.orgId),
            eq(
              usagePackInvitationPurchases.normalizedEmail,
              purchase.normalizedEmail,
            ),
            inArray(
              usagePackInvitationPurchases.status,
              OPEN_INVITATION_PURCHASE_STATUSES,
            ),
          ),
        )
        .limit(1);
      let superseded =
        competing !== undefined && competing.status !== "checkout_pending";
      if (competing?.status === "checkout_pending") {
        const [retired] = await tx
          .update(usagePackInvitationPurchases)
          .set({
            status: "failed",
            failureReason: "superseded_by_paid_purchase",
            updatedAt: nowDate(),
          })
          .where(
            and(
              eq(usagePackInvitationPurchases.id, competing.id),
              eq(usagePackInvitationPurchases.status, "checkout_pending"),
            ),
          )
          .returning({ id: usagePackInvitationPurchases.id });
        superseded = !retired;
      }
      const invalidPayment =
        args.amountPaidCents !== purchase.expectedAmountCents ||
        args.paidAt >= purchase.currentPeriodEnd;
      const requiresRefund = superseded || invalidPayment;
      const [updated] = await tx
        .update(usagePackInvitationPurchases)
        .set({
          stripeCheckoutSessionId:
            args.checkoutSessionId ?? purchase.stripeCheckoutSessionId,
          stripePaymentIntentId: args.paymentIntentId,
          amountPaidCents: args.amountPaidCents,
          paidAt: args.paidAt,
          status: requiresRefund ? "refund_pending" : "payment_succeeded",
          failureReason: superseded
            ? "superseded_invitation_payment"
            : invalidPayment
              ? "invalid_or_expired_payment"
              : null,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(usagePackInvitationPurchases.id, purchase.id),
            inArray(usagePackInvitationPurchases.status, [
              "checkout_pending",
              "failed",
              "payment_succeeded",
            ]),
            args.paymentIntentId === null
              ? isNull(usagePackInvitationPurchases.stripePaymentIntentId)
              : or(
                  isNull(usagePackInvitationPurchases.stripePaymentIntentId),
                  eq(
                    usagePackInvitationPurchases.stripePaymentIntentId,
                    args.paymentIntentId,
                  ),
                ),
            or(
              isNull(usagePackInvitationPurchases.amountPaidCents),
              eq(
                usagePackInvitationPurchases.amountPaidCents,
                args.amountPaidCents,
              ),
            ),
          ),
        )
        .returning();
      if (!updated) {
        throw new Error("Failed to record invitation payment");
      }
      return updated;
    });
  },
);

/**
 * One conditional publication of a payment. When a concurrent paid purchase
 * fills the same email slot first, the unique index
 * uq_usage_pack_invitation_purchases_current_email rejects this transaction
 * as a whole; the delivery fails and Stripe's redelivery (or reconciliation)
 * observes the committed winner and records this payment as refund_pending.
 * No in-process re-run.
 */
const recordSuccessfulPayment$ = command(
  async (
    { set },
    args: SuccessfulPaymentArgs,
    signal?: AbortSignal,
  ): Promise<UsagePackInvitationPurchaseRow> => {
    return await set(persistSuccessfulPayment$, args, signal);
  },
);

const claimInvitationCreation$ = command(
  async (
    { set },
    purchaseId: string,
    allowRecovery: boolean,
    signal?: AbortSignal,
  ): Promise<UsagePackInvitationPurchaseRow | null> => {
    signal?.throwIfAborted();
    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      const staleBefore = new Date(
        nowDate().getTime() - RECONCILIATION_DELAY_MS,
      );
      const [claimed] = await tx
        .update(usagePackInvitationPurchases)
        .set({ status: "creating_invitation", updatedAt: nowDate() })
        .where(
          and(
            eq(usagePackInvitationPurchases.id, purchaseId),
            isNull(usagePackInvitationPurchases.clerkInvitationId),
            isNull(usagePackInvitationPurchases.allocationId),
            or(
              eq(usagePackInvitationPurchases.status, "payment_succeeded"),
              ...(allowRecovery
                ? [
                    and(
                      eq(
                        usagePackInvitationPurchases.status,
                        "creating_invitation",
                      ),
                      lte(usagePackInvitationPurchases.updatedAt, staleBefore),
                    ),
                  ]
                : []),
            ),
          ),
        )
        .returning();
      return claimed ?? null;
    });
  },
);

const persistInvitation$ = command(
  async (
    { set },
    purchase: UsagePackInvitationPurchaseRow,
    invitationId: string,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    signal?.throwIfAborted();
    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      // Allocation publication and the purchase transition commit together;
      // a lost status transition rolls back the allocation.
      const [current] = await tx
        .select()
        .from(usagePackInvitationPurchases)
        .where(eq(usagePackInvitationPurchases.id, purchase.id))
        .limit(1);
      if (!current) {
        throw new Error(
          `Unknown usage pack invitation purchase ${purchase.id}`,
        );
      }
      if (current.clerkInvitationId) {
        if (current.clerkInvitationId !== invitationId) {
          throw new Error(
            "Invitation purchase resolved a different Clerk invite",
          );
        }
        return true;
      }
      if (
        current.status !== "creating_invitation" ||
        current.updatedAt.getTime() !== purchase.updatedAt.getTime()
      ) {
        return false;
      }
      const [inserted] = await tx
        .insert(usagePackAllocations)
        .values({
          usagePackSubscriptionId: current.usagePackSubscriptionId,
          orgId: current.orgId,
          invitationId,
          usagePackUsd: current.usagePackUsd,
          stripePriceId: current.stripePriceId,
          status: "paid_pending_invitation",
          currentPeriodStart: current.currentPeriodStart,
          currentPeriodEnd: current.currentPeriodEnd,
        })
        .onConflictDoNothing()
        .returning({ id: usagePackAllocations.id });
      const allocation =
        inserted ??
        (
          await tx
            .select({ id: usagePackAllocations.id })
            .from(usagePackAllocations)
            .where(
              and(
                eq(usagePackAllocations.orgId, current.orgId),
                eq(usagePackAllocations.invitationId, invitationId),
                eq(usagePackAllocations.status, "paid_pending_invitation"),
              ),
            )
            .limit(1)
        )[0];
      if (!allocation) {
        throw new Error("Failed to create paid pending invitation allocation");
      }
      const [published] = await tx
        .update(usagePackInvitationPurchases)
        .set({
          allocationId: allocation.id,
          clerkInvitationId: invitationId,
          status: "invitation_pending",
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(usagePackInvitationPurchases.id, current.id),
            eq(usagePackInvitationPurchases.status, current.status),
            isNull(usagePackInvitationPurchases.clerkInvitationId),
          ),
        )
        .returning({ id: usagePackInvitationPurchases.id });
      if (!published) {
        // Roll back the allocation; the caller re-reads the purchase.
        throw new Error(
          "Invitation purchase changed during invite publication",
        );
      }
      return true;
    });
  },
);

const releaseInvitationCreationClaimAfterReadLimit$ = command(
  async (
    { set },
    purchase: UsagePackInvitationPurchaseRow,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted();
    const db = set(writeDb$);
    if (!(error instanceof BillingClerkReadRateLimitError)) {
      return;
    }
    await db
      .update(usagePackInvitationPurchases)
      .set({ status: "payment_succeeded", updatedAt: nowDate() })
      .where(
        and(
          eq(usagePackInvitationPurchases.id, purchase.id),
          eq(usagePackInvitationPurchases.updatedAt, purchase.updatedAt),
          eq(usagePackInvitationPurchases.status, "creating_invitation"),
          isNull(usagePackInvitationPurchases.clerkInvitationId),
          isNull(usagePackInvitationPurchases.allocationId),
        ),
      );
  },
);

function paidInvitationCreationParams(
  purchase: UsagePackInvitationPurchaseRow,
  rewardClaimId: string,
) {
  return {
    organizationId: purchase.orgId,
    emailAddress: purchase.normalizedEmail,
    inviterUserId: purchase.inviterUserId,
    role: purchase.role === "admin" ? "org:admin" : "org:member",
    redirectUrl: env("APP_URL"),
    expiresInDays: Math.max(
      1,
      Math.ceil(
        (purchase.currentPeriodEnd.getTime() - nowDate().getTime()) /
          (24 * 60 * 60 * 1000),
      ),
    ),
    privateMetadata: {
      [PURCHASE_ID_METADATA_KEY]: purchase.id,
      getStartedClaimId: rewardClaimId,
    },
  };
}

const ensurePaidInvitationCreated$ = command(
  async (
    { get, set },
    purchaseId: string,
    allowRecovery: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const clerk = get(clerk$);
    signal.throwIfAborted();
    const purchase = await set(
      claimInvitationCreation$,
      purchaseId,
      allowRecovery,
      signal,
    );
    if (!purchase) {
      return;
    }
    signal.throwIfAborted();
    const readContext = createClerkReadContext();
    const membership = await onRejection(
      membershipForPurchase(clerk, purchase, readContext, signal),
      async (error) => {
        await set(
          releaseInvitationCreationClaimAfterReadLimit$,
          purchase,
          error,
          signal,
        );
      },
    );
    signal.throwIfAborted();
    if (membership) {
      await set(
        handleUsagePackInvitationAccepted$,
        {
          orgId: purchase.orgId,
          ...(purchase.clerkInvitationId
            ? { invitationId: purchase.clerkInvitationId }
            : {}),
          purchaseId: purchase.id,
          userId: membership.userId,
          acceptedAt: membership.createdAt,
          normalizedEmail: membership.email,
        },
        signal,
      );
      return;
    }
    const pending = await onRejection(
      loadBillingOrganizationPendingInvitations(
        clerk,
        purchase.orgId,
        readContext,
        signal,
      ),
      async (error) => {
        await set(
          releaseInvitationCreationClaimAfterReadLimit$,
          purchase,
          error,
          signal,
        );
      },
    );
    signal.throwIfAborted();
    const existing = pending.find((invitation) => {
      return clerkInvitationPurchaseId(invitation) === purchase.id;
    });
    if (nowDate() >= purchase.currentPeriodEnd) {
      if (existing) {
        await clerk.organizations.revokeOrganizationInvitation({
          organizationId: purchase.orgId,
          invitationId: existing.id,
        });
      }
      const [expired] = await db
        .update(usagePackInvitationPurchases)
        .set({
          status: "refund_pending",
          ...(existing ? { clerkInvitationId: existing.id } : {}),
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(usagePackInvitationPurchases.id, purchase.id),
            eq(usagePackInvitationPurchases.status, "creating_invitation"),
            eq(usagePackInvitationPurchases.updatedAt, purchase.updatedAt),
          ),
        )
        .returning({ id: usagePackInvitationPurchases.id });
      signal.throwIfAborted();
      if (expired) {
        await set(refundPurchase$, purchase.id, allowRecovery, signal);
      }
      return;
    }
    const rewardClaim = await set(
      prepareGetStartedInvitation$,
      {
        orgId: purchase.orgId,
        userId: purchase.inviterUserId,
        purchaseId: purchase.id,
      },
      signal,
    );
    signal.throwIfAborted();
    const invitation =
      existing ??
      (await clerk.organizations.createOrganizationInvitation(
        paidInvitationCreationParams(purchase, rewardClaim.id),
      ));
    if (await set(persistInvitation$, purchase, invitation.id, signal)) {
      await set(
        linkGetStartedInvitation$,
        rewardClaim.id,
        invitation.id,
        signal,
      );
    }
  },
);

const finalizeRefund$ = command(
  async (
    { set },
    claimedPurchase: UsagePackInvitationPurchaseRow,
    refundId: string | null,
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted();
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      // Conditional transition first: only the claimed refund attempt that is
      // still refunding completes; a lost or stale attempt is a no-op.
      const at = nowDate();
      const [refunded] = await tx
        .update(usagePackInvitationPurchases)
        .set({
          status: "refunded",
          stripeRefundId: refundId,
          refundedAt: at,
          updatedAt: at,
        })
        .where(
          and(
            eq(usagePackInvitationPurchases.id, claimedPurchase.id),
            eq(usagePackInvitationPurchases.status, "refunding"),
            eq(
              usagePackInvitationPurchases.refundAttempt,
              claimedPurchase.refundAttempt,
            ),
          ),
        )
        .returning({
          allocationId: usagePackInvitationPurchases.allocationId,
        });
      if (!refunded) {
        return;
      }
      if (refunded.allocationId) {
        await tx
          .update(usagePackAllocations)
          .set({ status: "inactive", updatedAt: at })
          .where(eq(usagePackAllocations.id, refunded.allocationId));
      }
    });
  },
);

/**
 * Best-effort post-commit Stripe convergence for an invitation's recurring
 * package quantity. The committed allocation is the declared intent; a failed
 * or skipped sync is repaired by the daily configuration reconciliation.
 */
const syncInvitationSubscriptionConfiguration$ = command(
  async (
    { set },
    usagePackSubscriptionId: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    const result = await settle(
      set(
        syncUsagePackSubscriptionConfiguration$,
        usagePackSubscriptionId,
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      L.warn("usage pack invitation configuration sync failed", {
        usagePackSubscriptionId,
        error: result.error,
      });
    }
  },
);

const removeRefundedInvitationProjection$ = command(
  async (
    { set },
    purchase: UsagePackInvitationPurchaseRow,
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted();
    const db = set(writeDb$);
    if (purchase.stripeCheckoutSessionId || !purchase.allocationId) {
      return;
    }
    const allocationId = purchase.allocationId;
    await db.transaction(async (tx) => {
      // The org-level financial protocol remains separate. Refund attempt
      // identity and status are rechecked before retiring the allocation.
      await tx.execute(usagePackBillingCompatibilityLockSql(purchase.orgId));
      const [current] = await tx
        .select()
        .from(usagePackInvitationPurchases)
        .where(eq(usagePackInvitationPurchases.id, purchase.id))
        .limit(1);
      if (
        !current ||
        current.status === "refunded" ||
        current.refundAttempt !== purchase.refundAttempt ||
        current.allocationId !== purchase.allocationId
      ) {
        return;
      }
      if (current.status !== "refunding") {
        throw new Error("Invitation refund changed during projection removal");
      }
      await tx
        .update(usagePackAllocations)
        .set({ status: "inactive", updatedAt: nowDate() })
        .where(eq(usagePackAllocations.id, allocationId));
    });
    signal?.throwIfAborted();
    await set(
      syncInvitationSubscriptionConfiguration$,
      purchase.usagePackSubscriptionId,
      signal,
    );
    signal?.throwIfAborted();
  },
);

const completeSuccessfulRefund$ = command(
  async (
    { set },
    purchase: UsagePackInvitationPurchaseRow,
    refundId: string | null,
    signal?: AbortSignal,
  ): Promise<void> => {
    await set(removeRefundedInvitationProjection$, purchase, signal);
    await set(finalizeRefund$, purchase, refundId, signal);
  },
);

const recordFailedRefund$ = command(
  async (
    { set },
    purchase: UsagePackInvitationPurchaseRow,
    refundId: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted();
    const db = set(writeDb$);
    await db
      .update(usagePackInvitationPurchases)
      .set({
        status: "refund_pending",
        stripeRefundId: null,
        refundAttempt: purchase.refundAttempt + 1,
        failureReason: `stripe_refund_failed:${refundId}`,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(usagePackInvitationPurchases.id, purchase.id),
          eq(usagePackInvitationPurchases.status, "refunding"),
          eq(
            usagePackInvitationPurchases.refundAttempt,
            purchase.refundAttempt,
          ),
        ),
      );
  },
);

const applyStripeRefundState$ = command(
  async (
    { set },
    purchase: UsagePackInvitationPurchaseRow,
    refund: StripeRefund,
    signal?: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    if (refund.status === "succeeded") {
      await set(completeSuccessfulRefund$, purchase, refund.id, signal);
      return;
    }
    if (refund.status === "failed" || refund.status === "canceled") {
      await set(recordFailedRefund$, purchase, refund.id, signal);
      return;
    }
    await db
      .update(usagePackInvitationPurchases)
      .set({
        status: "refunding",
        stripeRefundId: refund.id,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(usagePackInvitationPurchases.id, purchase.id),
          eq(usagePackInvitationPurchases.status, "refunding"),
          eq(
            usagePackInvitationPurchases.refundAttempt,
            purchase.refundAttempt,
          ),
        ),
      );
  },
);

const refundPurchase$ = command(
  async (
    { set },
    purchaseId: string,
    allowRecovery: boolean,
    signal?: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const purchase = await db.transaction(async (tx) => {
      const [identity] = await tx
        .select({
          orgId: usagePackInvitationPurchases.orgId,
          subscriptionId: usagePackInvitationPurchases.usagePackSubscriptionId,
        })
        .from(usagePackInvitationPurchases)
        .where(eq(usagePackInvitationPurchases.id, purchaseId))
        .limit(1);
      if (!identity) {
        return null;
      }
      await tx.execute(usagePackBillingCompatibilityLockSql(identity.orgId));
      const parentCount = (
        await tx.execute(invitationMutationSubscriptionSql(purchaseId))
      ).rowCount;
      if (parentCount !== 1) {
        return null;
      }
      if (
        (
          await tx.execute(
            conflictingUsagePackMutationSql({
              subscriptionId: identity.subscriptionId,
              invitationPurchaseId: purchaseId,
            }),
          )
        ).rowCount
      ) {
        return null;
      }
      const staleBefore = new Date(
        nowDate().getTime() - RECONCILIATION_DELAY_MS,
      );
      const [claimed] = await tx
        .update(usagePackInvitationPurchases)
        .set({ status: "refunding", updatedAt: nowDate() })
        .where(
          and(
            eq(usagePackInvitationPurchases.id, purchaseId),
            or(
              eq(usagePackInvitationPurchases.status, "refund_pending"),
              ...(allowRecovery
                ? [
                    and(
                      eq(usagePackInvitationPurchases.status, "refunding"),
                      lte(usagePackInvitationPurchases.updatedAt, staleBefore),
                    ),
                  ]
                : []),
            ),
          ),
        )
        .returning();
      return claimed ?? null;
    });
    signal?.throwIfAborted();
    if (!purchase) {
      return;
    }
    if (purchase.amountPaidCents === 0) {
      await set(completeSuccessfulRefund$, purchase, null, signal);
      return;
    }
    if (purchase.amountPaidCents === null || !purchase.stripePaymentIntentId) {
      throw new Error("Paid invitation is missing its PaymentIntent");
    }
    const stripe = getStripeClient();
    if (purchase.stripeRefundId) {
      const refund = await stripe.refunds.retrieve(purchase.stripeRefundId);
      signal?.throwIfAborted();
      await set(applyStripeRefundState$, purchase, refund, signal);
      return;
    }
    const refund = await stripe.refunds.create(
      {
        payment_intent: purchase.stripePaymentIntentId,
        amount: purchase.amountPaidCents,
        metadata: checkoutMetadata(purchase),
      },
      {
        idempotencyKey: `usage-pack-invitation:${purchase.id}:refund:${purchase.refundAttempt}`,
      },
    );
    signal?.throwIfAborted();
    await set(applyStripeRefundState$, purchase, refund, signal);
  },
);

const handleRecordedPayment$ = command(
  async (
    { set },
    purchase: UsagePackInvitationPurchaseRow,
    signal: AbortSignal,
  ): Promise<void> => {
    if (purchase.status === "refund_pending") {
      await set(refundPurchase$, purchase.id, false, signal);
      return;
    }
    await set(ensurePaidInvitationCreated$, purchase.id, false, signal);
  },
);

export const handleUsagePackInvitationCheckoutPaid$ = command(
  async (
    { set },
    session: UsagePackInvitationCheckoutSessionInput,
    paidAt: Date,
    signal: AbortSignal,
  ): Promise<{ readonly handled: boolean; readonly orgId: string | null }> => {
    const purchaseId = purchaseIdFromMetadata(session.metadata);
    if (!purchaseId) {
      return { handled: false, orgId: null };
    }
    if (session.mode !== "payment" || session.payment_status !== "paid") {
      return { handled: true, orgId: null };
    }
    const paymentIntentId = stripeObjectId(session.payment_intent);
    const customerId = stripeObjectId(session.customer);
    const amountTotal = session.amount_total;
    if (
      !paymentIntentId ||
      !customerId ||
      typeof amountTotal !== "number" ||
      !Number.isSafeInteger(amountTotal) ||
      amountTotal < 0 ||
      !session.currency
    ) {
      throw new Error("Paid invitation Checkout Session is incomplete");
    }
    const purchase = await set(
      recordSuccessfulPayment$,
      {
        purchaseId,
        checkoutSessionId: session.id,
        paymentIntentId,
        customerId,
        amountPaidCents: amountTotal,
        currency: session.currency,
        paidAt,
      },
      signal,
    );
    await set(handleRecordedPayment$, purchase, signal);
    return { handled: true, orgId: purchase.orgId };
  },
);

export const handleUsagePackInvitationPaymentIntentSucceeded$ = command(
  async (
    { set },
    paymentIntent: StripePaymentIntent,
    paidAt: Date,
    signal: AbortSignal,
  ): Promise<{ readonly handled: boolean; readonly orgId: string | null }> => {
    const purchaseId = purchaseIdFromMetadata(paymentIntent.metadata);
    if (!purchaseId) {
      return { handled: false, orgId: null };
    }
    if (!isCurrentStripePreviewMetadata(paymentIntent.metadata)) {
      return { handled: true, orgId: null };
    }
    const customerId = stripeObjectId(paymentIntent.customer);
    if (!customerId || paymentIntent.status !== "succeeded") {
      return { handled: true, orgId: null };
    }
    const purchase = await set(
      recordSuccessfulPayment$,
      {
        purchaseId,
        paymentIntentId: paymentIntent.id,
        customerId,
        amountPaidCents: paymentIntent.amount_received,
        currency: paymentIntent.currency,
        paidAt,
      },
      signal,
    );
    await set(handleRecordedPayment$, purchase, signal);
    return { handled: true, orgId: purchase.orgId };
  },
);

function paidInvoicePaymentIntent(invoice: StripeInvoice): {
  readonly id: string;
  readonly amountPaidCents: number;
} | null {
  const payment = invoice.payments?.data.find((candidate) => {
    return (
      candidate.status === "paid" && candidate.payment.type === "payment_intent"
    );
  });
  if (!payment) {
    return null;
  }
  const id = stripeObjectId(payment.payment.payment_intent ?? null);
  if (
    !id ||
    !Number.isSafeInteger(payment.amount_paid) ||
    (payment.amount_paid ?? -1) < 0
  ) {
    throw new Error(`Invitation invoice ${invoice.id} has an invalid payment`);
  }
  return { id, amountPaidCents: payment.amount_paid ?? 0 };
}

export const handleUsagePackInvitationInvoicePaid$ = command(
  async (
    { set },
    invoiceInput: Pick<StripeInvoice, "id" | "metadata">,
    signal: AbortSignal,
  ): Promise<{ readonly handled: boolean; readonly orgId: string | null }> => {
    const purchaseId = purchaseIdFromMetadata(invoiceInput.metadata);
    if (!purchaseId) {
      return { handled: false, orgId: null };
    }
    if (!isCurrentStripePreviewMetadata(invoiceInput.metadata)) {
      return { handled: true, orgId: null };
    }
    const invoice = await getStripeClient().invoices.retrieve(invoiceInput.id, {
      expand: ["payments.data.payment.payment_intent"],
    });
    signal.throwIfAborted();
    if (invoice.status !== "paid" && invoice.paid !== true) {
      return { handled: true, orgId: null };
    }
    const customerId = stripeObjectId(invoice.customer);
    const payment = paidInvoicePaymentIntent(invoice);
    if (!customerId || (!payment && invoice.amount_due !== 0)) {
      throw new Error("Paid invitation invoice is incomplete");
    }
    const paidAtSeconds = invoice.status_transitions?.paid_at;
    const paidAt =
      typeof paidAtSeconds === "number" && Number.isSafeInteger(paidAtSeconds)
        ? new Date(paidAtSeconds * 1000)
        : nowDate();
    const purchase = await set(
      recordSuccessfulPayment$,
      {
        purchaseId,
        paymentIntentId: payment?.id ?? null,
        customerId,
        amountPaidCents: payment?.amountPaidCents ?? 0,
        currency: invoice.currency,
        paidAt,
      },
      signal,
    );
    await set(handleRecordedPayment$, purchase, signal);
    return { handled: true, orgId: purchase.orgId };
  },
);

function invitationPurchaseConfirmState(
  purchase: UsagePackInvitationPurchaseRow | null,
  orgId: string,
):
  | {
      readonly status: "ready";
      readonly purchase: UsagePackInvitationPurchaseRow;
    }
  | {
      readonly status: "complete";
      readonly result: ConfirmUsagePackInvitationPurchaseResult;
    }
  | {
      readonly status: "resume_invitation";
      readonly purchase: UsagePackInvitationPurchaseRow;
    } {
  if (!purchase || purchase.orgId !== orgId) {
    return { status: "complete", result: { status: "not_found" } };
  }
  if (purchase.status === "payment_succeeded") {
    return { status: "resume_invitation", purchase };
  }
  if (
    purchase.status === "creating_invitation" ||
    purchase.status === "invitation_pending" ||
    ACCEPTED_PURCHASE_STATUSES.has(purchase.status)
  ) {
    return { status: "complete", result: { status: "confirmed" } };
  }
  if (
    purchase.status !== "checkout_pending" ||
    purchase.stripeCheckoutSessionId
  ) {
    return {
      status: "complete",
      result: {
        status: "conflict",
        reason: "purchase_inactive",
        diagnostics: {
          purchaseStatus: purchase.status,
          hasCheckoutSession: purchase.stripeCheckoutSessionId !== null,
        },
      },
    };
  }
  return { status: "ready", purchase };
}

interface StructuredInvitationCharge {
  readonly preview: UsagePackAllocationAdditionChargePreview;
  readonly price: StripePrice;
}

function invitationChargeMatchesPurchase(
  purchase: UsagePackInvitationPurchaseRow,
  preview: UsagePackAllocationAdditionChargePreview,
): boolean {
  return (
    preview.amountCents === purchase.expectedAmountCents &&
    preview.currency === purchase.currency &&
    preview.currentPeriodStart.getTime() ===
      purchase.currentPeriodStart.getTime() &&
    preview.currentPeriodEnd.getTime() ===
      purchase.currentPeriodEnd.getTime() &&
    preview.prorationTimestamp === purchase.prorationTimestamp
  );
}

function invitationInvoiceTaxBehavior(
  price: StripePrice,
): "exclusive" | "inclusive" | undefined {
  return price.tax_behavior === "exclusive" ||
    price.tax_behavior === "inclusive"
    ? price.tax_behavior
    : undefined;
}

function invitationInvoiceTaxCode(price: StripePrice): string | undefined {
  if (typeof price.product === "string" || "deleted" in price.product) {
    throw new Error("Usage pack invitation Price has no active Product");
  }
  return stripeObjectId(price.product.tax_code) ?? undefined;
}

const loadStructuredInvitationCharge$ = command(
  async (
    { set },
    purchase: UsagePackInvitationPurchaseRow,
    signal: AbortSignal,
  ): Promise<StructuredInvitationCharge | null> => {
    const stripe = getStripeClient();
    const [preview, price] = await Promise.all([
      set(
        previewUsagePackAllocationAddition$,
        {
          usagePackSubscriptionId: purchase.usagePackSubscriptionId,
          stripePriceId: purchase.stripePriceId,
          prorationTimestamp: purchase.prorationTimestamp,
        },
        signal,
      ),
      stripe.prices.retrieve(purchase.stripePriceId, { expand: ["product"] }),
    ]);
    signal.throwIfAborted();
    if (
      !invitationChargeMatchesPurchase(purchase, preview) ||
      price.id !== purchase.stripePriceId ||
      price.currency !== purchase.currency ||
      price.unit_amount !== purchase.unitAmountCents
    ) {
      return null;
    }
    invitationInvoiceTaxCode(price);
    return { preview, price };
  },
);

async function createStructuredInvitationInvoiceItems(
  stripe: StripeClient,
  args: {
    readonly invoiceId: string;
    readonly customerId: string;
    readonly subscriptionId: string;
    readonly purchase: UsagePackInvitationPurchaseRow;
    readonly charge: StructuredInvitationCharge;
  },
  signal: AbortSignal,
): Promise<void> {
  const taxBehavior = invitationInvoiceTaxBehavior(args.charge.price);
  const taxCode = invitationInvoiceTaxCode(args.charge.price);
  const period = {
    start: args.purchase.prorationTimestamp,
    end: Math.floor(args.purchase.currentPeriodEnd.getTime() / 1000),
  };
  for (const [index, item] of args.charge.preview.invoiceItems.entries()) {
    await stripe.invoiceItems.create(
      {
        invoice: args.invoiceId,
        customer: args.customerId,
        amount: item.amountCents,
        currency: args.purchase.currency,
        description: `Member usage pack for ${args.purchase.normalizedEmail}`,
        discountable: false,
        period,
        subscription: args.subscriptionId,
        ...(taxBehavior ? { tax_behavior: taxBehavior } : {}),
        ...(taxCode ? { tax_code: taxCode } : {}),
        ...(item.taxRateIds.length > 0
          ? { tax_rates: [...item.taxRateIds] }
          : {}),
      },
      {
        idempotencyKey:
          index === 0
            ? `usage-pack-invitation:${args.purchase.id}:invoice-item`
            : `usage-pack-invitation:${args.purchase.id}:invoice-item:${index}`,
      },
    );
    signal.throwIfAborted();
  }
}

type InvitationPurchaseInvoiceCreation =
  | UsagePackInvitationPurchaseConflictResult
  | { readonly status: "created"; readonly invoice: StripeInvoice };

const createInvitationPurchaseInvoice$ = command(
  async (
    { set },
    purchase: UsagePackInvitationPurchaseRow,
    args: {
      readonly customerId: string;
      readonly subscriptionId: string;
      readonly paymentMethod: BillingPurchasePaymentMethod | undefined;
    },
    signal: AbortSignal,
  ): Promise<InvitationPurchaseInvoiceCreation> => {
    const stripe = getStripeClient();
    const structuredCharge = await set(
      loadStructuredInvitationCharge$,
      purchase,
      signal,
    );
    if (!structuredCharge) {
      return {
        status: "conflict",
        reason: "billing_state_changed",
        diagnostics: {},
      };
    }
    const invoice = await stripe.invoices.create(
      {
        customer: args.customerId,
        auto_advance: false,
        ...(args.paymentMethod
          ? stripeBillingPurchasePaymentParams(args.paymentMethod)
          : {}),
        metadata: checkoutMetadata(purchase),
        discounts: "",
        ...(structuredCharge.preview.automaticTax
          ? { automatic_tax: structuredCharge.preview.automaticTax }
          : {}),
      },
      { idempotencyKey: `usage-pack-invitation:${purchase.id}:invoice` },
    );
    signal.throwIfAborted();
    await createStructuredInvitationInvoiceItems(
      stripe,
      {
        invoiceId: invoice.id,
        customerId: args.customerId,
        subscriptionId: args.subscriptionId,
        purchase,
        charge: structuredCharge,
      },
      signal,
    );
    signal.throwIfAborted();
    return { status: "created", invoice };
  },
);

const expireInvitationPurchasePreviewIfNeeded$ = command(
  async (
    { set },
    purchase: UsagePackInvitationPurchaseRow,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const expiresAt = purchase.stripeCheckoutExpiresAt;
    if (expiresAt && expiresAt > nowDate()) {
      return false;
    }
    await db
      .update(usagePackInvitationPurchases)
      .set({
        status: "failed",
        failureReason: "preview_expired",
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(usagePackInvitationPurchases.id, purchase.id),
          eq(usagePackInvitationPurchases.status, "checkout_pending"),
        ),
      );
    signal?.throwIfAborted();
    return true;
  },
);

type InvitationPurchaseSubscriptionState =
  | {
      readonly status: "ready";
      readonly subscription: UsagePackSubscriptionRow;
      readonly stripeSubscriptionId: string;
    }
  | {
      readonly status: "conflict";
      readonly result: UsagePackInvitationPurchaseConflictResult;
    };

function invitationPurchaseSubscriptionState(
  subscription: UsagePackSubscriptionRow | null,
  purchase: UsagePackInvitationPurchaseRow,
): InvitationPurchaseSubscriptionState {
  const stripeSubscriptionId = subscription?.stripeSubscriptionId;
  if (!subscription || !stripeSubscriptionId) {
    return {
      status: "conflict",
      result: {
        status: "conflict",
        reason: "subscription_unavailable",
        diagnostics: {
          subscriptionStatus: subscription?.subscriptionStatus ?? null,
          hasStripeSubscriptionId: Boolean(stripeSubscriptionId),
        },
      },
    };
  }
  if (subscription.id !== purchase.usagePackSubscriptionId) {
    return {
      status: "conflict",
      result: {
        status: "conflict",
        reason: "subscription_changed",
        diagnostics: {
          subscriptionStatus: subscription.subscriptionStatus,
        },
      },
    };
  }
  if (subscription.cancelAtPeriodEnd) {
    return {
      status: "conflict",
      result: {
        status: "conflict",
        reason: "subscription_canceling",
        diagnostics: {
          subscriptionStatus: subscription.subscriptionStatus,
          cancelAtPeriodEnd: true,
        },
      },
    };
  }
  return { status: "ready", subscription, stripeSubscriptionId };
}

function invitationPurchasePaymentMethodConflict(
  paymentMethod: BillingPurchasePaymentMethod | undefined,
  route: Awaited<ReturnType<typeof resolveBillingPurchaseRoute>>,
): UsagePackInvitationPurchaseConflictResult | null {
  if (
    !paymentMethod ||
    (route.kind === "preview" &&
      paymentMethod.paymentMethodId === route.paymentMethodId &&
      paymentMethod.paymentMethodType === route.paymentMethodType)
  ) {
    return null;
  }
  return {
    status: "conflict",
    reason: "payment_method_changed",
    diagnostics: {
      paymentRoute: route.kind,
      expectedPaymentMethodType: paymentMethod.paymentMethodType,
      currentPaymentMethodType:
        route.kind === "preview" ? route.paymentMethodType : null,
    },
  };
}

interface BillUsagePackInvitationPurchaseArgs {
  readonly purchase: UsagePackInvitationPurchaseRow;
  readonly subscription: UsagePackSubscriptionRow;
  readonly stripeSubscriptionId: string;
  readonly paymentMethod: BillingPurchasePaymentMethod | undefined;
}

const billUsagePackInvitationPurchase$ = command(
  async (
    { set },
    args: BillUsagePackInvitationPurchaseArgs,
    signal: AbortSignal,
  ): Promise<ConfirmUsagePackInvitationPurchaseResult> => {
    const { purchase, subscription, stripeSubscriptionId, paymentMethod } =
      args;
    const stripe = getStripeClient();
    const invoiceCreation = await set(
      createInvitationPurchaseInvoice$,
      purchase,
      {
        customerId: subscription.stripeCustomerId,
        subscriptionId: stripeSubscriptionId,
        paymentMethod,
      },
      signal,
    );
    if (invoiceCreation.status === "conflict") {
      return invoiceCreation;
    }
    const { invoice } = invoiceCreation;
    const payment = await completeBillingOperationInvoice(
      stripe,
      invoice,
      `usage-pack-invitation:${purchase.id}`,
      signal,
      { payOpenInvoice: true },
    );
    if (payment.status === "pending_payment") {
      return payment;
    }
    const handled = await set(
      handleUsagePackInvitationInvoicePaid$,
      {
        id: invoice.id,
        metadata: invoice.metadata,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!handled.handled) {
      throw new Error("Invitation invoice payment was not recorded");
    }
    if (!handled.orgId) {
      return {
        status: "conflict",
        reason: "billing_state_changed",
        diagnostics: {},
      };
    }
    return { status: "confirmed" };
  },
);

export const confirmUsagePackInvitationPurchase$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly purchaseId: string;
      readonly paymentMethod?: BillingPurchasePaymentMethod;
    },
    signal: AbortSignal,
  ): Promise<ConfirmUsagePackInvitationPurchaseResult> => {
    const clerk = get(clerk$);
    const purchaseState = invitationPurchaseConfirmState(
      await set(loadPurchase$, args.purchaseId, signal),
      args.orgId,
    );
    if (purchaseState.status === "complete") {
      return purchaseState.result;
    }
    if (purchaseState.status === "resume_invitation") {
      await set(
        ensurePaidInvitationCreated$,
        purchaseState.purchase.id,
        false,
        signal,
      );
      signal.throwIfAborted();
      return { status: "confirmed" };
    }
    const { purchase } = purchaseState;
    if (await set(expireInvitationPurchasePreviewIfNeeded$, purchase, signal)) {
      return { status: "expired" };
    }
    if (
      await emailAlreadyBelongsToOrg(
        clerk,
        purchase.orgId,
        purchase.normalizedEmail,
        signal,
      )
    ) {
      return {
        status: "conflict",
        reason: "invitee_unavailable",
        diagnostics: {},
      };
    }
    signal.throwIfAborted();
    const subscription = await set(
      currentUsagePackSubscriptionForOrg$,
      purchase.orgId,
      signal,
    );
    const subscriptionState = invitationPurchaseSubscriptionState(
      subscription,
      purchase,
    );
    if (subscriptionState.status === "conflict") {
      return subscriptionState.result;
    }
    const { subscription: activeSubscription, stripeSubscriptionId } =
      subscriptionState;
    const stripe = getStripeClient();
    const route = await resolveBillingPurchaseRoute(
      {
        stripe,
        supportsInAppPreview: true,
        customerId: activeSubscription.stripeCustomerId,
        subscriptionId: stripeSubscriptionId,
      },
      signal,
    );
    const paymentMethodConflict = invitationPurchasePaymentMethodConflict(
      args.paymentMethod,
      route,
    );
    if (paymentMethodConflict) {
      return paymentMethodConflict;
    }
    const paymentMethod =
      args.paymentMethod ?? (route.kind === "preview" ? route : undefined);
    return await set(
      billUsagePackInvitationPurchase$,
      {
        purchase,
        subscription: activeSubscription,
        stripeSubscriptionId,
        paymentMethod,
      },
      signal,
    );
  },
);

export const handleUsagePackInvitationCheckoutFailed$ = command(
  async (
    { set },
    session: UsagePackInvitationCheckoutSessionInput,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const purchaseId = purchaseIdFromMetadata(session.metadata);
    if (!purchaseId) {
      return false;
    }
    await db
      .update(usagePackInvitationPurchases)
      .set({
        status: "failed",
        failureReason: "checkout_failed_or_expired",
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(usagePackInvitationPurchases.id, purchaseId),
          eq(usagePackInvitationPurchases.stripeCheckoutSessionId, session.id),
          eq(usagePackInvitationPurchases.status, "checkout_pending"),
        ),
      );
    signal?.throwIfAborted();
    return true;
  },
);

const claimAcceptedPurchaseActivation$ = command(
  async (
    { set },
    purchaseId: string,
    allowRecovery: boolean,
    signal?: AbortSignal,
  ): Promise<UsagePackInvitationPurchaseRow | null> => {
    signal?.throwIfAborted();
    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      const [identity] = await tx
        .select({
          orgId: usagePackInvitationPurchases.orgId,
          subscriptionId: usagePackInvitationPurchases.usagePackSubscriptionId,
        })
        .from(usagePackInvitationPurchases)
        .where(eq(usagePackInvitationPurchases.id, purchaseId))
        .limit(1);
      if (!identity) {
        return null;
      }
      await tx.execute(usagePackBillingCompatibilityLockSql(identity.orgId));
      const parentCount = (
        await tx.execute(invitationMutationSubscriptionSql(purchaseId))
      ).rowCount;
      if (parentCount !== 1) {
        return null;
      }
      if (
        (
          await tx.execute(
            conflictingUsagePackMutationSql({
              subscriptionId: identity.subscriptionId,
              invitationPurchaseId: purchaseId,
            }),
          )
        ).rowCount
      ) {
        return null;
      }
      const staleBefore = new Date(
        nowDate().getTime() - RECONCILIATION_DELAY_MS,
      );
      const [claimed] = await tx
        .update(usagePackInvitationPurchases)
        .set({ status: "activating", updatedAt: nowDate() })
        .where(
          and(
            eq(usagePackInvitationPurchases.id, purchaseId),
            isNotNull(usagePackInvitationPurchases.acceptedUserId),
            isNotNull(usagePackInvitationPurchases.allocationId),
            or(
              eq(
                usagePackInvitationPurchases.status,
                "accepted_pending_activation",
              ),
              ...(allowRecovery
                ? [
                    and(
                      eq(usagePackInvitationPurchases.status, "activating"),
                      lte(usagePackInvitationPurchases.updatedAt, staleBefore),
                    ),
                  ]
                : []),
            ),
          ),
        )
        .returning();
      return claimed ?? null;
    });
  },
);

const activateAcceptedPurchase$ = command(
  async (
    { set },
    purchaseId: string,
    allowRecovery: boolean,
    signal?: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const purchase = await set(
      claimAcceptedPurchaseActivation$,
      purchaseId,
      allowRecovery,
      signal,
    );
    if (!purchase?.acceptedUserId || !purchase.allocationId) {
      return;
    }
    await db.transaction(async (tx) => {
      // Grant receipts and final purchase publication commit atomically;
      // a lost accepted transition rolls back this delivery's grants. The
      // remaining org-level financial protocol is audited separately.
      await tx.execute(usagePackBillingCompatibilityLockSql(purchase.orgId));
      const [current] = await tx
        .select()
        .from(usagePackInvitationPurchases)
        .where(eq(usagePackInvitationPurchases.id, purchase.id))
        .limit(1);
      if (!current || current.status === "accepted") {
        return;
      }
      if (
        current.status !== "activating" ||
        current.acceptedUserId !== purchase.acceptedUserId ||
        current.allocationId !== purchase.allocationId
      ) {
        throw new Error("Invitation acceptance changed during activation");
      }
      const acceptedUserId = current.acceptedUserId;
      const allocationId = current.allocationId;
      if (!acceptedUserId || !allocationId) {
        throw new Error(
          "Invitation acceptance is missing its user or allocation",
        );
      }
      // Publish grants only while owning the same wallet as settlement. The
      // recurring Stripe quantity follows from this commit by identity sync.
      const [wallet] = await tx
        .select()
        .from(memberRewardWalletQuery(current.orgId));
      if (!wallet) {
        throw new Error("Invitation activation has no organization wallet");
      }
      for (const grantSql of invitationActivationGrantSql(
        current,
        acceptedUserId,
      )) {
        if ((await tx.execute(grantSql)).rowCount !== 1) {
          throw new Error("Invitation credit grant payment identity changed");
        }
      }
      const at = nowDate();
      const [activated] = await tx
        .update(usagePackAllocations)
        .set({ status: "active", updatedAt: at })
        .where(
          and(
            eq(usagePackAllocations.id, allocationId),
            eq(usagePackAllocations.userId, acceptedUserId),
            inArray(usagePackAllocations.status, [
              "paid_pending_invitation",
              "active",
            ]),
          ),
        )
        .returning({ id: usagePackAllocations.id });
      if (!activated) {
        throw new Error(
          "Invitation allocation was retired or reassigned during activation",
        );
      }
      const [accepted] = await tx
        .update(usagePackInvitationPurchases)
        .set({ status: "accepted", updatedAt: at })
        .where(
          and(
            eq(usagePackInvitationPurchases.id, current.id),
            eq(usagePackInvitationPurchases.status, "activating"),
            eq(usagePackInvitationPurchases.acceptedUserId, acceptedUserId),
            eq(usagePackInvitationPurchases.allocationId, allocationId),
          ),
        )
        .returning({ id: usagePackInvitationPurchases.id });
      if (!accepted) {
        throw new Error("Invitation acceptance changed during activation");
      }
    });
    signal?.throwIfAborted();
    await set(
      syncInvitationSubscriptionConfiguration$,
      purchase.usagePackSubscriptionId,
      signal,
    );
    signal?.throwIfAborted();
  },
);

const loadAcceptanceCandidate$ = command(
  async (
    { set },
    args: UsagePackInvitationAcceptanceArgs,
    signal?: AbortSignal,
  ): Promise<UsagePackInvitationPurchaseRow | null> => {
    const db = set(writeDb$);
    const purchaseLookup = args.purchaseId
      ? args.invitationId
        ? or(
            eq(usagePackInvitationPurchases.id, args.purchaseId),
            eq(
              usagePackInvitationPurchases.clerkInvitationId,
              args.invitationId,
            ),
          )
        : eq(usagePackInvitationPurchases.id, args.purchaseId)
      : eq(
          usagePackInvitationPurchases.clerkInvitationId,
          args.invitationId ?? "",
        );
    const [candidate] = await db
      .select()
      .from(usagePackInvitationPurchases)
      .where(purchaseLookup)
      .limit(1);
    signal?.throwIfAborted();
    if (!candidate) {
      return null;
    }
    if (
      candidate.orgId !== args.orgId ||
      (args.invitationId &&
        candidate.clerkInvitationId &&
        candidate.clerkInvitationId !== args.invitationId) ||
      (candidate.acceptedUserId && candidate.acceptedUserId !== args.userId) ||
      (args.normalizedEmail &&
        candidate.normalizedEmail !== normalizedEmail(args.normalizedEmail))
    ) {
      throw new Error("Accepted Clerk invitation does not match its purchase");
    }
    return candidate;
  },
);

const markLateAcceptanceForRefund$ = command(
  async (
    { set },
    candidate: UsagePackInvitationPurchaseRow,
    args: UsagePackInvitationAcceptanceArgs,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    signal?.throwIfAborted();
    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      // Conditional transition: only a still-acceptable purchase moves to
      // refund_pending; anything else is a deterministic "not marked".
      const [marked] = await tx
        .update(usagePackInvitationPurchases)
        .set({
          status: "refund_pending",
          failureReason: "invitation_accepted_after_period",
          acceptedUserId: args.userId,
          acceptedAt: args.acceptedAt,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(usagePackInvitationPurchases.id, candidate.id),
            inArray(usagePackInvitationPurchases.status, [
              ...ACCEPTABLE_INVITATION_PURCHASE_STATUSES,
            ]),
          ),
        )
        .returning({ id: usagePackInvitationPurchases.id });
      return marked !== undefined;
    });
  },
);

const recordInvitationAcceptance$ = command(
  async (
    { set },
    candidate: UsagePackInvitationPurchaseRow,
    args: UsagePackInvitationAcceptanceArgs,
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted();
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      // Assignment and the status-conditional purchase publication share one
      // transaction. A lost publication rolls back the assignment.
      const [purchase] = await tx
        .select()
        .from(usagePackInvitationPurchases)
        .where(eq(usagePackInvitationPurchases.id, candidate.id))
        .limit(1);
      if (!purchase || purchase.status === "accepted") {
        return;
      }
      if (ACCEPTANCE_IN_PROGRESS_STATUSES.has(purchase.status)) {
        if (purchase.acceptedUserId !== args.userId) {
          throw new Error("Invitation acceptance resolved a different user");
        }
        return;
      }
      if (!ACCEPTABLE_INVITATION_PURCHASE_STATUSES.has(purchase.status)) {
        return;
      }
      if (
        args.invitationId &&
        purchase.clerkInvitationId &&
        purchase.clerkInvitationId !== args.invitationId
      ) {
        throw new Error(
          "Accepted Clerk invitation does not match its purchase",
        );
      }
      let allocationId = purchase.allocationId;
      if (!allocationId) {
        const [inserted] = await tx
          .insert(usagePackAllocations)
          .values({
            usagePackSubscriptionId: purchase.usagePackSubscriptionId,
            orgId: purchase.orgId,
            userId: args.invitationId ? null : args.userId,
            invitationId: args.invitationId ?? null,
            usagePackUsd: purchase.usagePackUsd,
            stripePriceId: purchase.stripePriceId,
            status: "paid_pending_invitation",
            currentPeriodStart: purchase.currentPeriodStart,
            currentPeriodEnd: purchase.currentPeriodEnd,
          })
          .returning({ id: usagePackAllocations.id });
        if (!inserted) {
          throw new Error("Failed to recover accepted invitation allocation");
        }
        allocationId = inserted.id;
      }
      const [assigned] = await tx
        .update(usagePackAllocations)
        .set({
          userId: args.userId,
          invitationId: null,
          status: "paid_pending_invitation",
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(usagePackAllocations.id, allocationId),
            inArray(usagePackAllocations.status, [
              "paid_pending_invitation",
              "pending_invitation",
              "active",
            ]),
            or(
              isNull(usagePackAllocations.userId),
              eq(usagePackAllocations.userId, args.userId),
            ),
          ),
        )
        .returning({ id: usagePackAllocations.id });
      if (!assigned) {
        throw new Error(
          "Invitation allocation was retired or reassigned before acceptance",
        );
      }
      const [recorded] = await tx
        .update(usagePackInvitationPurchases)
        .set({
          allocationId,
          ...(args.invitationId
            ? { clerkInvitationId: args.invitationId }
            : {}),
          acceptedUserId: args.userId,
          acceptedAt: args.acceptedAt,
          status: "accepted_pending_activation",
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(usagePackInvitationPurchases.id, purchase.id),
            eq(usagePackInvitationPurchases.status, purchase.status),
          ),
        )
        .returning({ id: usagePackInvitationPurchases.id });
      if (!recorded) {
        // Roll back the allocation assignment; the purchase moved on.
        throw new Error("Invitation purchase changed during acceptance");
      }
    });
  },
);

export const handleUsagePackInvitationAccepted$ = command(
  async (
    { set },
    args: UsagePackInvitationAcceptanceArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!args.purchaseId && !args.invitationId) {
      return false;
    }
    const candidate = await set(loadAcceptanceCandidate$, args, signal);
    if (!candidate) {
      return false;
    }
    // Exact membership recovery has the same invitation evidence as the webhook.
    await set(
      acceptGetStartedInvitation$,
      {
        ...args,
        purchaseId: candidate.id,
      },
      signal,
    );
    if (IGNORED_ACCEPTANCE_STATUSES.has(candidate.status)) {
      return true;
    }
    if (args.acceptedAt >= candidate.currentPeriodEnd) {
      const markedForRefund = await set(
        markLateAcceptanceForRefund$,
        candidate,
        args,
        signal,
      );
      if (markedForRefund) {
        await set(refundPurchase$, candidate.id, false, signal);
      }
      return true;
    }
    await set(recordInvitationAcceptance$, candidate, args, signal);
    await set(activateAcceptedPurchase$, candidate.id, false, signal);
    return true;
  },
);

async function membershipForPurchase(
  clerk: ClerkClient,
  purchase: UsagePackInvitationPurchaseRow,
  context: ClerkReadContext,
  signal: AbortSignal,
): Promise<ClerkMembershipIdentity | null> {
  const memberships = await loadBillingOrganizationMemberships(
    clerk,
    purchase.orgId,
    context,
    signal,
  );
  return (
    memberships.map(clerkMembershipIdentity).find((identity) => {
      return identity?.email === purchase.normalizedEmail;
    }) ?? null
  );
}

const revokeAndRefundPurchase$ = command(
  async (
    { get, set },
    purchase: UsagePackInvitationPurchaseRow,
    signal: AbortSignal,
  ): Promise<"accepted" | "revoked"> => {
    const db = set(writeDb$);
    const clerk = get(clerk$);
    const readContext = createClerkReadContext();
    const membership = await membershipForPurchase(
      clerk,
      purchase,
      readContext,
      signal,
    );
    signal.throwIfAborted();
    if (membership) {
      await set(
        handleUsagePackInvitationAccepted$,
        {
          orgId: purchase.orgId,
          ...(purchase.clerkInvitationId
            ? { invitationId: purchase.clerkInvitationId }
            : {}),
          purchaseId: purchase.id,
          userId: membership.userId,
          acceptedAt: membership.createdAt,
          normalizedEmail: membership.email,
        },
        signal,
      );
      const current = await set(loadPurchase$, purchase.id, signal);
      return current && REFUND_STATUSES.has(current.status)
        ? "revoked"
        : "accepted";
    }
    if (purchase.clerkInvitationId) {
      const pending = await loadBillingOrganizationPendingInvitations(
        clerk,
        purchase.orgId,
        readContext,
        signal,
      );
      signal.throwIfAborted();
      if (
        pending.some((invitation) => {
          return invitation.id === purchase.clerkInvitationId;
        })
      ) {
        await clerk.organizations.revokeOrganizationInvitation({
          organizationId: purchase.orgId,
          invitationId: purchase.clerkInvitationId,
        });
        signal.throwIfAborted();
      }
    }
    const [markedForRefund] = await db
      .update(usagePackInvitationPurchases)
      .set({ status: "refund_pending", updatedAt: nowDate() })
      .where(
        and(
          eq(usagePackInvitationPurchases.id, purchase.id),
          inArray(usagePackInvitationPurchases.status, [
            "payment_succeeded",
            "creating_invitation",
            "invitation_pending",
          ]),
        ),
      )
      .returning({ id: usagePackInvitationPurchases.id });
    signal.throwIfAborted();
    if (!markedForRefund) {
      const current = await set(loadPurchase$, purchase.id, signal);
      if (current && ACCEPTED_PURCHASE_STATUSES.has(current.status)) {
        return "accepted";
      }
    }
    await set(refundPurchase$, purchase.id, true, signal);
    return "revoked";
  },
);

export const revokeUsagePackInvitationPurchase$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly invitationId: string;
    },
    signal: AbortSignal,
  ): Promise<RevokeUsagePackInvitationResult> => {
    const db = set(writeDb$);

    const [purchase] = await db
      .select()
      .from(usagePackInvitationPurchases)
      .where(
        and(
          eq(usagePackInvitationPurchases.orgId, args.orgId),
          eq(usagePackInvitationPurchases.clerkInvitationId, args.invitationId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!purchase) {
      return { status: "not_found" };
    }
    if (ACCEPTED_PURCHASE_STATUSES.has(purchase.status)) {
      return { status: "accepted" };
    }
    if (purchase.status === "refunded") {
      return { status: "revoked" };
    }
    const result = await set(revokeAndRefundPurchase$, purchase, signal);
    return { status: result };
  },
);

const reconcileUsagePackInvitationPurchaseCandidate$ = command(
  async (
    { get, set },
    purchase: UsagePackInvitationPurchaseRow,
    at: Date,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const clerk = get(clerk$);
    switch (purchase.status) {
      case "payment_succeeded":
      case "creating_invitation": {
        await set(ensurePaidInvitationCreated$, purchase.id, true, signal);
        return true;
      }
      case "invitation_pending": {
        if (purchase.currentPeriodEnd <= at) {
          await set(revokeAndRefundPurchase$, purchase, signal);
          return true;
        }
        const membership = await membershipForPurchase(
          clerk,
          purchase,
          createClerkReadContext(),
          signal,
        );
        signal.throwIfAborted();
        if (!membership || !purchase.clerkInvitationId) {
          return false;
        }
        await set(
          handleUsagePackInvitationAccepted$,
          {
            orgId: purchase.orgId,
            invitationId: purchase.clerkInvitationId,
            userId: membership.userId,
            acceptedAt: membership.createdAt,
            normalizedEmail: membership.email,
          },
          signal,
        );
        return true;
      }
      case "accepted_pending_activation":
      case "activating": {
        await set(activateAcceptedPurchase$, purchase.id, true, signal);
        return true;
      }
      case "refund_pending":
      case "refunding": {
        await set(refundPurchase$, purchase.id, true, signal);
        return true;
      }
      case "checkout_pending":
      case "accepted":
      case "refunded":
      case "failed": {
        return false;
      }
    }
  },
);

export const reconcileUsagePackInvitationPurchases$ = command(
  async (
    { set },
    scope: BillingReconciliationScope | undefined,
    signal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);

    signal.throwIfAborted();
    const at = nowDate();
    let expiredCount: number;
    do {
      const expired = await db
        .update(usagePackInvitationPurchases)
        .set({
          status: "failed",
          failureReason: "checkout_expired",
          updatedAt: at,
        })
        .where(
          and(
            eq(usagePackInvitationPurchases.status, "checkout_pending"),
            lte(usagePackInvitationPurchases.stripeCheckoutExpiresAt, at),
            inArray(
              usagePackInvitationPurchases.id,
              db
                .select({ id: usagePackInvitationPurchases.id })
                .from(usagePackInvitationPurchases)
                .where(
                  and(
                    scope
                      ? inArray(usagePackInvitationPurchases.orgId, [
                          ...scope.orgIds,
                        ])
                      : undefined,
                    eq(usagePackInvitationPurchases.status, "checkout_pending"),
                    lte(
                      usagePackInvitationPurchases.stripeCheckoutExpiresAt,
                      at,
                    ),
                  ),
                )
                .orderBy(asc(usagePackInvitationPurchases.id))
                .limit(RECONCILIATION_BATCH_SIZE),
            ),
          ),
        )
        .returning({ id: usagePackInvitationPurchases.id });
      signal.throwIfAborted();
      expiredCount = expired.length;
    } while (expiredCount === RECONCILIATION_BATCH_SIZE);
    let reconciled = 0;
    let cursor: string | undefined;
    let candidateCount: number;
    do {
      const candidates = await db
        .select()
        .from(usagePackInvitationPurchases)
        .where(
          and(
            scope
              ? inArray(usagePackInvitationPurchases.orgId, [...scope.orgIds])
              : undefined,
            cursor ? gt(usagePackInvitationPurchases.id, cursor) : undefined,
            inArray(usagePackInvitationPurchases.status, [
              "payment_succeeded",
              "creating_invitation",
              "invitation_pending",
              "accepted_pending_activation",
              "activating",
              "refund_pending",
              "refunding",
            ]),
          ),
        )
        .orderBy(asc(usagePackInvitationPurchases.id))
        .limit(RECONCILIATION_BATCH_SIZE);
      signal.throwIfAborted();
      for (const purchase of candidates) {
        const result = await settle(
          set(
            reconcileUsagePackInvitationPurchaseCandidate$,
            purchase,
            at,
            signal,
          ),
          signal,
        );
        if (!result.ok) {
          L.error("usage pack invitation purchase reconciliation failed", {
            purchaseId: purchase.id,
            orgId: purchase.orgId,
            clerkInvitationId: purchase.clerkInvitationId,
            status: purchase.status,
            error: result.error,
          });
          continue;
        }
        if (result.value) {
          reconciled += 1;
        }
      }
      cursor = candidates.at(-1)?.id;
      candidateCount = candidates.length;
    } while (candidateCount === RECONCILIATION_BATCH_SIZE);
    return reconciled;
  },
);
