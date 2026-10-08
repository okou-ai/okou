import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import {
  usagePackCreditRefunds,
  type UsagePackCreditRefundSourceType,
} from "@okouai/db/schema/usage-pack-credit-refund";
import { usagePackInvitationPurchases } from "@okouai/db/schema/usage-pack-subscription";
import { and, asc, eq, gt, inArray, like, lt, or } from "drizzle-orm";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  getStripeClient,
  stripeErrorInfo,
  type StripeClient,
  type StripeCreditNote,
  type StripeCreditNoteParams,
  type StripeRefund,
  type StripeRef,
} from "../external/stripe-client";
import { settle } from "../utils";

const CREDITS_PER_CENT = 10;
const RECONCILIATION_LIMIT = 100;
const MAX_REFUND_ATTEMPTS = 3;
const L = logger("UsagePackCreditRefund");

type UsagePackCreditRefundRow = typeof usagePackCreditRefunds.$inferSelect;
type UsagePackCreditGrantRow = typeof usagePackCreditGrants.$inferSelect;
type CreditRefundSourceStore = Pick<Db, "insert" | "select">;
type CreditRefundStore = Pick<Db, "insert" | "select" | "update">;

export type UsagePackCreditRefundSource =
  | {
      readonly type: "invoice";
      readonly invoiceId: string;
      readonly invoiceLineId?: string | null;
      readonly amountCents: number;
    }
  | {
      readonly type: "payment_intent";
      readonly paymentIntentId: string;
      readonly amountCents: number;
    };

function refundableUsagePackCreditGrantCondition(
  args: { readonly orgId: string; readonly userId: string },
  at: Date,
) {
  return and(
    eq(usagePackCreditGrants.orgId, args.orgId),
    eq(usagePackCreditGrants.userId, args.userId),
    eq(usagePackCreditGrants.grantType, "purchased"),
    gt(usagePackCreditGrants.remainingAmount, 0),
    gt(usagePackCreditGrants.expiresAt, at),
  );
}

function sourceColumns(source: UsagePackCreditRefundSource): {
  readonly sourceType: UsagePackCreditRefundSourceType;
  readonly stripeInvoiceId: string | null;
  readonly stripeInvoiceLineId: string | null;
  readonly stripePaymentIntentId: string | null;
  readonly sourceAmountCents: number;
} {
  if (!Number.isSafeInteger(source.amountCents) || source.amountCents < 0) {
    throw new Error("Usage pack refund source amount cannot be negative");
  }
  if (source.type === "invoice") {
    return {
      sourceType: source.type,
      stripeInvoiceId: source.invoiceId,
      stripeInvoiceLineId: source.invoiceLineId ?? null,
      stripePaymentIntentId: null,
      sourceAmountCents: source.amountCents,
    };
  }
  return {
    sourceType: source.type,
    stripeInvoiceId: null,
    stripeInvoiceLineId: null,
    stripePaymentIntentId: source.paymentIntentId,
    sourceAmountCents: source.amountCents,
  };
}

function refundSourceMatches(
  row: UsagePackCreditRefundRow,
  source: ReturnType<typeof sourceColumns>,
  args: { readonly orgId: string; readonly userId: string },
): boolean {
  return (
    row.orgId === args.orgId &&
    row.userId === args.userId &&
    row.sourceType === source.sourceType &&
    row.stripeInvoiceId === source.stripeInvoiceId &&
    row.stripeInvoiceLineId === source.stripeInvoiceLineId &&
    row.stripePaymentIntentId === source.stripePaymentIntentId &&
    row.sourceAmountCents === source.sourceAmountCents
  );
}

export async function ensureUsagePackCreditRefundSource(
  db: CreditRefundSourceStore,
  args: {
    readonly creditGrantId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly source: UsagePackCreditRefundSource;
  },
): Promise<void> {
  const source = sourceColumns(args.source);
  const [inserted] = await db
    .insert(usagePackCreditRefunds)
    .values({
      creditGrantId: args.creditGrantId,
      orgId: args.orgId,
      userId: args.userId,
      ...source,
    })
    .onConflictDoNothing({ target: usagePackCreditRefunds.creditGrantId })
    .returning();
  if (inserted) {
    return;
  }
  const [existing] = await db
    .select()
    .from(usagePackCreditRefunds)
    .where(eq(usagePackCreditRefunds.creditGrantId, args.creditGrantId))
    .limit(1);
  if (!existing || !refundSourceMatches(existing, source, args)) {
    throw new Error("Usage pack credit refund source conflict");
  }
}

function legacyInvoiceId(idempotencyKey: string): string | null {
  const renewal = /^usage-pack:([^:]+):[^:]+:purchased$/.exec(idempotencyKey);
  if (renewal?.[1]) {
    return renewal[1];
  }
  const allocationChange = /^usage-pack-change:[^:]+:([^:]+):purchased$/.exec(
    idempotencyKey,
  );
  if (allocationChange?.[1]) {
    return allocationChange[1];
  }
  const subscriptionChange =
    /^usage-pack-subscription-change:[^:]+:[^:]+:([^:]+):purchased$/.exec(
      idempotencyKey,
    );
  return subscriptionChange?.[1] ?? null;
}

function legacyInvitationPurchaseId(idempotencyKey: string): string | null {
  const match = /^usage-pack-invitation:([^:]+):purchased$/.exec(
    idempotencyKey,
  );
  return match?.[1] ?? null;
}

async function inferLegacyRefundSource(
  db: Pick<Db, "select">,
  grant: UsagePackCreditGrantRow,
): Promise<UsagePackCreditRefundSource | null> {
  const invitationPurchaseId = legacyInvitationPurchaseId(grant.idempotencyKey);
  if (invitationPurchaseId) {
    const [purchase] = await db
      .select({
        orgId: usagePackInvitationPurchases.orgId,
        acceptedUserId: usagePackInvitationPurchases.acceptedUserId,
        amountPaidCents: usagePackInvitationPurchases.amountPaidCents,
        stripePaymentIntentId:
          usagePackInvitationPurchases.stripePaymentIntentId,
      })
      .from(usagePackInvitationPurchases)
      .where(eq(usagePackInvitationPurchases.id, invitationPurchaseId))
      .limit(1);
    if (
      !purchase ||
      purchase.orgId !== grant.orgId ||
      purchase.acceptedUserId !== grant.userId
    ) {
      throw new Error(
        `Usage pack grant ${grant.id} has no refundable invitation payment`,
      );
    }
    if (purchase.amountPaidCents === 0) {
      return null;
    }
    if (purchase.amountPaidCents === null || !purchase.stripePaymentIntentId) {
      throw new Error(
        `Usage pack grant ${grant.id} has no refundable invitation payment`,
      );
    }
    return {
      type: "payment_intent",
      paymentIntentId: purchase.stripePaymentIntentId,
      amountCents: purchase.amountPaidCents,
    };
  }

  const invoiceId = legacyInvoiceId(grant.idempotencyKey);
  const amountCents = Math.floor(grant.originalAmount / CREDITS_PER_CENT);
  if (!invoiceId || amountCents <= 0) {
    throw new Error(
      `Usage pack grant ${grant.id} has no refundable Stripe source`,
    );
  }
  return { type: "invoice", invoiceId, amountCents };
}

async function loadRefundSource(
  db: CreditRefundStore,
  grant: UsagePackCreditGrantRow,
): Promise<UsagePackCreditRefundRow | null> {
  const [existing] = await db
    .select()
    .from(usagePackCreditRefunds)
    .where(eq(usagePackCreditRefunds.creditGrantId, grant.id))
    .limit(1);
  if (existing) {
    return existing;
  }
  const source = await inferLegacyRefundSource(db, grant);
  if (!source) {
    return null;
  }
  await ensureUsagePackCreditRefundSource(db, {
    creditGrantId: grant.id,
    orgId: grant.orgId,
    userId: grant.userId,
    source,
  });
  const [created] = await db
    .select()
    .from(usagePackCreditRefunds)
    .where(eq(usagePackCreditRefunds.creditGrantId, grant.id))
    .limit(1);
  if (!created) {
    throw new Error(`Usage pack grant ${grant.id} refund source was not saved`);
  }
  return created;
}

export async function prepareUsagePackMemberCreditRefunds(
  db: CreditRefundStore,
  args: { readonly orgId: string; readonly userId: string },
): Promise<number> {
  const at = nowDate();
  const grants = await db
    .select()
    .from(usagePackCreditGrants)
    .where(refundableUsagePackCreditGrantCondition(args, at))
    .for("update");
  if (grants.length === 0) {
    return 0;
  }

  let prepared = 0;
  for (const grant of grants) {
    const source = await loadRefundSource(db, grant);
    if (!source || source.status !== "available") {
      continue;
    }
    const requestedAmountCents = Math.floor(
      (source.sourceAmountCents * grant.remainingAmount) / grant.originalAmount,
    );
    if (requestedAmountCents <= 0) {
      continue;
    }
    const rows = await db
      .update(usagePackCreditRefunds)
      .set({
        status: "pending",
        refundCredits: grant.remainingAmount,
        requestedAmountCents,
        updatedAt: at,
      })
      .where(
        and(
          eq(usagePackCreditRefunds.creditGrantId, grant.id),
          eq(usagePackCreditRefunds.status, "available"),
        ),
      )
      .returning({ creditGrantId: usagePackCreditRefunds.creditGrantId });
    prepared += rows.length;
  }
  return prepared;
}

function creditNoteLineParams(
  refund: UsagePackCreditRefundRow,
): Pick<StripeCreditNoteParams, "amount" | "lines"> {
  if (!refund.requestedAmountCents) {
    throw new Error(`Usage pack refund ${refund.creditGrantId} has no amount`);
  }
  return refund.stripeInvoiceLineId
    ? {
        lines: [
          {
            type: "invoice_line_item",
            invoice_line_item: refund.stripeInvoiceLineId,
            amount: refund.requestedAmountCents,
          },
        ],
      }
    : { amount: refund.requestedAmountCents };
}

function creditNoteRefundId(creditNote: StripeCreditNote): string | null {
  const refund = creditNote.refunds[0]?.refund;
  return typeof refund === "string" ? refund : (refund?.id ?? null);
}

async function markRefundSucceeded(
  db: Pick<Db, "update">,
  row: UsagePackCreditRefundRow,
  stripeRefundId: string,
  refundedAmountCents: number,
  stripeCreditNoteId = row.stripeCreditNoteId,
): Promise<void> {
  const at = nowDate();
  await db
    .update(usagePackCreditRefunds)
    .set({
      status: "succeeded",
      stripeCreditNoteId,
      stripeRefundId,
      refundedAmountCents,
      failureReason: null,
      refundedAt: at,
      updatedAt: at,
    })
    .where(eq(usagePackCreditRefunds.creditGrantId, row.creditGrantId));
}

async function markRefundNotRequired(
  db: Pick<Db, "update">,
  row: UsagePackCreditRefundRow,
): Promise<void> {
  const at = nowDate();
  await db
    .update(usagePackCreditRefunds)
    .set({
      status: "succeeded",
      stripeCreditNoteId: null,
      stripeRefundId: null,
      refundedAmountCents: 0,
      failureReason: null,
      refundedAt: at,
      updatedAt: at,
    })
    .where(eq(usagePackCreditRefunds.creditGrantId, row.creditGrantId));
}

function stripeRefundFailureReason(refund: StripeRefund): string {
  const status = refund.status ?? "unknown";
  return refund.failure_reason
    ? `stripe_refund_${status}:${refund.failure_reason}`
    : `stripe_refund_${status}`;
}

function logTerminalRefundFailure(
  row: UsagePackCreditRefundRow,
  args: {
    readonly stripeCreditNoteId?: string | null;
    readonly stripeRefundId?: string | null;
    readonly failureReason: string;
  },
): void {
  L.error("usage pack credit refund requires manual recovery", {
    creditGrantId: row.creditGrantId,
    orgId: row.orgId,
    userId: row.userId,
    stripeInvoiceId: row.stripeInvoiceId,
    stripeCreditNoteId:
      args.stripeCreditNoteId ?? row.stripeCreditNoteId ?? null,
    stripeRefundId: args.stripeRefundId ?? row.stripeRefundId ?? null,
    attempt: row.attempt,
    failureReason: args.failureReason,
  });
}

async function markRefundFailed(
  db: Pick<Db, "update">,
  row: UsagePackCreditRefundRow,
  failureReason: string,
): Promise<void> {
  await db
    .update(usagePackCreditRefunds)
    .set({
      status: "failed",
      failureReason,
      updatedAt: nowDate(),
    })
    .where(eq(usagePackCreditRefunds.creditGrantId, row.creditGrantId));
  logTerminalRefundFailure(row, {
    failureReason,
  });
}

type StripeRefundState = "succeeded" | "waiting" | "failed";

async function applyStripeRefundState(
  db: Pick<Db, "update">,
  row: UsagePackCreditRefundRow,
  refund: StripeRefund,
  refundedAmountCents?: number,
): Promise<StripeRefundState> {
  if (refund.status === "succeeded") {
    await db
      .update(usagePackCreditRefunds)
      .set({
        status: "processing",
        stripeRefundId: refund.id,
        ...(refundedAmountCents === undefined ? {} : { refundedAmountCents }),
        failureReason: null,
        updatedAt: nowDate(),
      })
      .where(eq(usagePackCreditRefunds.creditGrantId, row.creditGrantId));
    return "succeeded";
  }
  if (refund.status === "failed" || refund.status === "canceled") {
    const failureReason = stripeRefundFailureReason(refund);
    const terminal = row.attempt >= MAX_REFUND_ATTEMPTS;
    await db
      .update(usagePackCreditRefunds)
      .set({
        status: terminal ? "failed" : "pending",
        stripeRefundId: terminal ? refund.id : null,
        ...(refundedAmountCents === undefined ? {} : { refundedAmountCents }),
        attempt: terminal ? row.attempt : row.attempt + 1,
        failureReason,
        updatedAt: nowDate(),
      })
      .where(eq(usagePackCreditRefunds.creditGrantId, row.creditGrantId));
    if (terminal) {
      logTerminalRefundFailure(row, {
        stripeRefundId: refund.id,
        failureReason,
      });
      return "failed";
    }
    return "waiting";
  }
  await db
    .update(usagePackCreditRefunds)
    .set({
      status: "processing",
      stripeRefundId: refund.id,
      ...(refundedAmountCents === undefined ? {} : { refundedAmountCents }),
      failureReason: null,
      updatedAt: nowDate(),
    })
    .where(eq(usagePackCreditRefunds.creditGrantId, row.creditGrantId));
  return "waiting";
}

async function processPaymentIntentRefund(
  db: Db,
  row: UsagePackCreditRefundRow,
): Promise<void> {
  if (!row.stripePaymentIntentId || !row.requestedAmountCents) {
    throw new Error(
      `Usage pack refund ${row.creditGrantId} has an invalid PaymentIntent source`,
    );
  }
  const stripe = getStripeClient();
  const refund = row.stripeRefundId
    ? await stripe.refunds.retrieve(row.stripeRefundId)
    : await createOrReconcileRefund(db, stripe, row, {
        paymentIntentId: row.stripePaymentIntentId,
        amountCents: row.requestedAmountCents,
        idempotencyKey: `usage-pack-credit-refund:${row.creditGrantId}:${row.attempt}`,
      });
  if (!refund) {
    return;
  }
  const state = await applyStripeRefundState(db, row, refund);
  if (state === "succeeded") {
    await markRefundSucceeded(db, row, refund.id, row.requestedAmountCents);
  }
}

function creditNoteParams(
  row: UsagePackCreditRefundRow,
): StripeCreditNoteParams {
  if (!row.stripeInvoiceId) {
    throw new Error(
      `Usage pack refund ${row.creditGrantId} has no Stripe invoice`,
    );
  }
  return {
    invoice: row.stripeInvoiceId,
    ...creditNoteLineParams(row),
    email_type: "none",
    reason: "order_change",
    metadata: {
      purpose: "usage_pack_member_credit_refund",
      orgId: row.orgId,
      userId: row.userId,
      creditGrantId: row.creditGrantId,
    },
  };
}

async function loadInvoiceRefundAmount(
  db: Pick<Db, "update">,
  stripe: StripeClient,
  row: UsagePackCreditRefundRow,
): Promise<number | null> {
  let refundAmountCents = row.refundedAmountCents;
  if (refundAmountCents === 0) {
    await markRefundNotRequired(db, row);
    return null;
  }
  if (refundAmountCents === null) {
    const preview = await stripe.creditNotes.preview(creditNoteParams(row));
    if (preview.pre_payment_amount === 0 && preview.post_payment_amount === 0) {
      await markRefundNotRequired(db, row);
      return null;
    }
    if (preview.pre_payment_amount !== 0 || preview.post_payment_amount <= 0) {
      throw new Error(
        `Usage pack refund ${row.creditGrantId} credit note is not fully refundable`,
      );
    }
    refundAmountCents = preview.post_payment_amount;
    await db
      .update(usagePackCreditRefunds)
      .set({ refundedAmountCents: refundAmountCents, updatedAt: nowDate() })
      .where(eq(usagePackCreditRefunds.creditGrantId, row.creditGrantId));
  }
  return refundAmountCents;
}

function stripeRefId(ref: StripeRef | undefined): string | null {
  if (!ref) {
    return null;
  }
  return typeof ref === "string" ? ref : ref.id;
}

async function loadRefundableInvoicePaymentIntentId(
  db: Pick<Db, "update">,
  stripe: StripeClient,
  row: UsagePackCreditRefundRow,
  refundAmountCents: number,
): Promise<string | null> {
  if (!row.stripeInvoiceId) {
    throw new Error(
      `Usage pack refund ${row.creditGrantId} has no Stripe invoice`,
    );
  }
  const invoice = await stripe.invoices.retrieve(row.stripeInvoiceId, {
    expand: ["payments.data.payment.payment_intent"],
  });
  const refundablePaymentIntentIds = new Set(
    (invoice.payments?.data ?? []).flatMap((payment) => {
      const paymentIntentId = stripeRefId(payment.payment.payment_intent);
      return payment.status === "paid" &&
        payment.payment.type === "payment_intent" &&
        paymentIntentId &&
        (payment.amount_paid ?? 0) >= refundAmountCents
        ? [paymentIntentId]
        : [];
    }),
  );
  if (refundablePaymentIntentIds.size === 1) {
    return [...refundablePaymentIntentIds][0] ?? null;
  }
  await markRefundFailed(
    db,
    row,
    `invoice_refund_payment_intent_count_${refundablePaymentIntentIds.size}`,
  );
  return null;
}

async function loadOrCreateInvoiceRefund(
  db: Pick<Db, "update">,
  stripe: StripeClient,
  row: UsagePackCreditRefundRow,
  refundAmountCents: number,
  fallbackRefundId?: string | null,
): Promise<StripeRefund | null> {
  const stripeRefundId = row.stripeRefundId ?? fallbackRefundId;
  if (stripeRefundId) {
    return await stripe.refunds.retrieve(stripeRefundId);
  }
  const paymentIntentId = await loadRefundableInvoicePaymentIntentId(
    db,
    stripe,
    row,
    refundAmountCents,
  );
  if (!paymentIntentId) {
    return null;
  }
  return await createOrReconcileRefund(db, stripe, row, {
    paymentIntentId,
    amountCents: refundAmountCents,
    idempotencyKey: `usage-pack-credit-refund:${row.creditGrantId}:${row.attempt}:refund`,
  });
}

async function reconcileAlreadyRefundedCharge(
  db: Pick<Db, "update">,
  stripe: StripeClient,
  row: UsagePackCreditRefundRow,
  paymentIntentId: string,
  amountCents: number,
): Promise<StripeRefund | null> {
  let startingAfter: string | undefined;
  let matchingRefund: StripeRefund | null = null;
  do {
    const page = await stripe.refunds.list({
      payment_intent: paymentIntentId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const refund of page.data) {
      if (
        refund.status !== "succeeded" ||
        refund.amount !== amountCents ||
        stripeRefId(refund.payment_intent) !== paymentIntentId ||
        refund.metadata?.purpose !== "usage_pack_member_credit_refund" ||
        refund.metadata.creditGrantId !== row.creditGrantId ||
        refund.metadata.orgId !== row.orgId ||
        refund.metadata.userId !== row.userId
      ) {
        continue;
      }
      if (matchingRefund) {
        await markRefundFailed(
          db,
          row,
          "stripe_charge_already_refunded_ambiguous",
        );
        return null;
      }
      matchingRefund = refund;
    }
    if (!page.has_more) {
      break;
    }
    const lastRefundId = page.data.at(-1)?.id;
    if (!lastRefundId || lastRefundId === startingAfter) {
      throw new Error("Stripe refund pagination did not advance");
    }
    startingAfter = lastRefundId;
  } while (startingAfter);

  if (!matchingRefund) {
    await markRefundFailed(db, row, "stripe_charge_already_refunded_unmatched");
  }
  return matchingRefund;
}

async function createOrReconcileRefund(
  db: Pick<Db, "update">,
  stripe: StripeClient,
  row: UsagePackCreditRefundRow,
  args: {
    readonly paymentIntentId: string;
    readonly amountCents: number;
    readonly idempotencyKey: string;
  },
): Promise<StripeRefund | null> {
  const result = await settle(
    stripe.refunds.create(
      {
        payment_intent: args.paymentIntentId,
        amount: args.amountCents,
        metadata: {
          purpose: "usage_pack_member_credit_refund",
          orgId: row.orgId,
          userId: row.userId,
          creditGrantId: row.creditGrantId,
        },
      },
      { idempotencyKey: args.idempotencyKey },
    ),
  );
  if (result.ok) {
    return result.value;
  }
  if (stripeErrorInfo(result.error)?.code !== "charge_already_refunded") {
    throw result.error;
  }
  return await reconcileAlreadyRefundedCharge(
    db,
    stripe,
    row,
    args.paymentIntentId,
    args.amountCents,
  );
}

function requireIssuedRefundCreditNote(
  row: UsagePackCreditRefundRow,
  creditNote: StripeCreditNote,
): number {
  if (creditNote.status !== "issued" || creditNote.post_payment_amount <= 0) {
    throw new Error(
      `Usage pack refund ${row.creditGrantId} has an invalid credit note`,
    );
  }
  return creditNote.post_payment_amount;
}

async function createLinkedCreditNote(
  stripe: StripeClient,
  row: UsagePackCreditRefundRow,
  refund: StripeRefund,
  refundAmountCents: number,
): Promise<StripeCreditNote> {
  const creditNote = await stripe.creditNotes.create(
    {
      ...creditNoteParams(row),
      refunds: [{ refund: refund.id, amount_refunded: refundAmountCents }],
    },
    {
      idempotencyKey: `usage-pack-credit-refund:${row.creditGrantId}:${row.attempt}:credit-note`,
    },
  );
  const linkedRefundId = creditNoteRefundId(creditNote);
  if (
    requireIssuedRefundCreditNote(row, creditNote) !== refundAmountCents ||
    linkedRefundId !== refund.id
  ) {
    throw new Error(
      `Usage pack refund ${row.creditGrantId} credit note is not linked to its refund`,
    );
  }
  return creditNote;
}

async function processInvoiceRefund(
  db: Db,
  row: UsagePackCreditRefundRow,
): Promise<void> {
  const stripe = getStripeClient();
  // The previous API could persist a failed or processing invoice refund after
  // issuing its Credit Note. This is backend persisted-state compatibility for
  // the documented ~102-minute rollout exposure. Remove with #28580 only after
  // that API has drained and production has zero unresolved Credit-Note rows.
  const existingCreditNote = row.stripeCreditNoteId
    ? await stripe.creditNotes.retrieve(row.stripeCreditNoteId)
    : null;
  const refundAmountCents = existingCreditNote
    ? requireIssuedRefundCreditNote(row, existingCreditNote)
    : await loadInvoiceRefundAmount(db, stripe, row);
  if (refundAmountCents === null) {
    return;
  }
  const fallbackRefundId =
    existingCreditNote && row.attempt === 1
      ? creditNoteRefundId(existingCreditNote)
      : null;
  const stripeRefund = await loadOrCreateInvoiceRefund(
    db,
    stripe,
    row,
    refundAmountCents,
    fallbackRefundId,
  );
  if (!stripeRefund) {
    return;
  }
  const state = await applyStripeRefundState(
    db,
    row,
    stripeRefund,
    refundAmountCents,
  );
  if (state !== "succeeded") {
    return;
  }
  if (existingCreditNote) {
    await markRefundSucceeded(
      db,
      row,
      stripeRefund.id,
      refundAmountCents,
      existingCreditNote.id,
    );
    return;
  }
  const creditNote = await createLinkedCreditNote(
    stripe,
    row,
    stripeRefund,
    refundAmountCents,
  );
  await markRefundSucceeded(
    db,
    row,
    stripeRefund.id,
    refundAmountCents,
    creditNote.id,
  );
}

async function processCreditRefund(
  db: Db,
  row: UsagePackCreditRefundRow,
): Promise<void> {
  await db
    .update(usagePackCreditRefunds)
    .set({ status: "processing", updatedAt: nowDate() })
    .where(
      and(
        eq(usagePackCreditRefunds.creditGrantId, row.creditGrantId),
        or(
          inArray(usagePackCreditRefunds.status, ["pending", "processing"]),
          retryableFailedInvoiceRefundCondition(),
        ),
      ),
    );
  if (row.sourceType === "payment_intent") {
    await processPaymentIntentRefund(db, row);
    return;
  }
  await processInvoiceRefund(db, row);
}

function retryableFailedInvoiceRefundCondition() {
  // Keep the legacy failed rows described in processInvoiceRefund eligible
  // until the bounded compatibility cleanup tracked by #28580.
  return and(
    eq(usagePackCreditRefunds.sourceType, "invoice"),
    eq(usagePackCreditRefunds.status, "failed"),
    lt(usagePackCreditRefunds.attempt, MAX_REFUND_ATTEMPTS),
    or(
      like(usagePackCreditRefunds.failureReason, "stripe_refund_failed%"),
      like(usagePackCreditRefunds.failureReason, "stripe_refund_canceled%"),
    ),
  );
}

export async function refundUsagePackMemberCredits(
  db: Db,
  args: { readonly orgId: string; readonly userId: string },
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  const refunds = await db
    .select()
    .from(usagePackCreditRefunds)
    .where(
      and(
        eq(usagePackCreditRefunds.orgId, args.orgId),
        eq(usagePackCreditRefunds.userId, args.userId),
        inArray(usagePackCreditRefunds.status, ["pending", "processing"]),
      ),
    )
    .orderBy(asc(usagePackCreditRefunds.createdAt));
  signal.throwIfAborted();
  for (const refund of refunds) {
    await processCreditRefund(db, refund);
    signal.throwIfAborted();
  }
  return refunds.length;
}

export async function reconcileUsagePackCreditRefunds(
  db: Db,
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  const refunds = await db
    .select()
    .from(usagePackCreditRefunds)
    .where(
      and(
        or(
          inArray(usagePackCreditRefunds.status, ["pending", "processing"]),
          retryableFailedInvoiceRefundCondition(),
        ),
      ),
    )
    .orderBy(asc(usagePackCreditRefunds.updatedAt))
    .limit(RECONCILIATION_LIMIT);
  signal.throwIfAborted();
  for (const refund of refunds) {
    const result = await settle(processCreditRefund(db, refund), signal);
    if (!result.ok) {
      L.error("usage pack credit refund reconciliation failed", {
        creditGrantId: refund.creditGrantId,
        orgId: refund.orgId,
        userId: refund.userId,
        stripeInvoiceId: refund.stripeInvoiceId,
        stripeCreditNoteId: refund.stripeCreditNoteId,
        stripeRefundId: refund.stripeRefundId,
        error: result.error,
      });
    }
  }
  return refunds.length;
}
