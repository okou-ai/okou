import {
  usagePackAllocationChanges,
  usagePackAllocations,
  usagePackSubscriptions,
  usagePackInvitationPurchases,
} from "@okouai/db/schema/usage-pack-subscription";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePackCreditRefunds } from "@okouai/db/schema/usage-pack-credit-refund";
import {
  and,
  eq,
  inArray,
  isNotNull,
  notInArray,
  desc,
  ne,
  getTableColumns,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { object } from "zod";
import { usagePackOverdraftTransferSql } from "@okouai/db/operations/usage-pack-overdraft-transfer";
import {
  requireUsagePackOverdraftTransfer,
  usagePackOverdraftTransferOutcomeRow,
} from "./usage-pack-overdraft-transfer.service";
import {
  sourceColumns,
  refundSourceMatches,
  refundableUsagePackCreditGrantCondition,
  legacyInvoiceId,
  legacyInvitationPurchaseId,
  type UsagePackCreditRefundSource,
} from "./usage-pack-credit-refund.service";
import {
  contextJsonProjection,
  contextJsonRows,
  contextProjectionSchema,
} from "./context-rowset";
import {
  usagePackSqlRows,
  usagePackSqlWrite,
  usagePackSqlClock,
  usagePackSqlSelection,
  usagePackSqlRow,
  usagePackSqlInsert,
  usagePackSqlUpdate,
  type UsagePackRetainedFinancialPlan as FinancialPlan,
} from "./usage-pack-retained-sql";

type UsagePackCreditGrantRow = typeof usagePackCreditGrants.$inferSelect;
type UsagePackCreditRefundRow = typeof usagePackCreditRefunds.$inferSelect;
type UsagePackAllocationRow = typeof usagePackAllocations.$inferSelect;
type UsagePackAllocationChangeRow =
  typeof usagePackAllocationChanges.$inferSelect;
interface UsagePackChangeContext {
  readonly subscription: typeof usagePackSubscriptions.$inferSelect;
  readonly allocations: readonly UsagePackAllocationRow[];
  readonly changes: readonly UsagePackAllocationChangeRow[];
}
const CREDITS_PER_CENT = 10;
const OPEN_CHANGE_STATUSES = [
  "previewed",
  "applying",
  "pending_payment",
  "scheduled",
  "applied",
] as const;
const TERMINAL_SUBSCRIPTION_STATUSES = [
  "canceled",
  "incomplete_expired",
  "invalid",
] as const;

function activeMemberAllocations(
  context: UsagePackChangeContext,
): readonly UsagePackAllocationRow[] {
  return context.allocations.filter((allocation) => {
    return allocation.userId !== null && allocation.status === "active";
  });
}
function activeAllocationForMember(
  context: UsagePackChangeContext,
  userId: string,
): UsagePackAllocationRow | null {
  return (
    activeMemberAllocations(context).find((allocation) => {
      return allocation.userId === userId;
    }) ?? null
  );
}

function* memberRemovalContextPlan(
  usagePackSubscriptionId: string,
): FinancialPlan<UsagePackChangeContext | null> {
  const allocationColumns = getTableColumns(usagePackAllocations),
    changeColumns = getTableColumns(usagePackAllocationChanges),
    rootColumns = getTableColumns(usagePackSubscriptions);
  const allocationSchema = contextProjectionSchema(allocationColumns),
    changeSchema = contextProjectionSchema(changeColumns);
  const allocations = new QueryBuilder()
    .select({ payload: contextJsonProjection(allocationColumns).as("payload") })
    .from(usagePackAllocations)
    .where(
      eq(usagePackAllocations.usagePackSubscriptionId, usagePackSubscriptionId),
    );
  const changes = new QueryBuilder()
    .select({ payload: contextJsonProjection(changeColumns).as("payload") })
    .from(usagePackAllocationChanges)
    .where(
      and(
        eq(
          usagePackAllocationChanges.usagePackSubscriptionId,
          usagePackSubscriptionId,
        ),
        inArray(usagePackAllocationChanges.status, [...OPEN_CHANGE_STATUSES]),
      ),
    );
  const [row] = yield* usagePackSqlRows(
    new QueryBuilder()
      .select({
        subscription: contextJsonProjection(rootColumns).as("subscription"),
        allocations: contextJsonRows(allocations).as("allocations"),
        changes: contextJsonRows(changes).as("changes"),
      })
      .from(usagePackSubscriptions)
      .where(eq(usagePackSubscriptions.id, usagePackSubscriptionId))
      .limit(1)
      .getSQL(),
    object({
      subscription: contextProjectionSchema(rootColumns),
      allocations: allocationSchema.array(),
      changes: changeSchema.array(),
    }),
  );
  return row ?? null;
}
function* loadUsagePackChangeContextForOrgPlan(
  orgId: string,
): FinancialPlan<UsagePackChangeContext | null> {
  const [subscription] = yield* usagePackSqlRows(
    new QueryBuilder()
      .select(usagePackSqlSelection(getTableColumns(usagePackSubscriptions)))
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
      .limit(1)
      .getSQL(),
    usagePackSqlRow(getTableColumns(usagePackSubscriptions)),
  );
  if (!subscription) {
    return null;
  }
  return yield* memberRemovalContextPlan(subscription.id);
}

function* invalidateUsagePackChangePreviewsPlan(args: {
  readonly orgId: string;
  readonly at: Date;
  readonly reason: string;
  readonly preservedChangeId?: string;
}): FinancialPlan<void> {
  yield* usagePackSqlWrite(
    usagePackSqlUpdate(
      usagePackAllocationChanges,
      {
        status: "failed",
        failureReason: args.reason,
        completedAt: args.at,
        updatedAt: args.at,
      },
      args.preservedChangeId
        ? and(
            eq(usagePackAllocationChanges.orgId, args.orgId),
            eq(usagePackAllocationChanges.status, "previewed"),
            ne(usagePackAllocationChanges.id, args.preservedChangeId),
          )
        : and(
            eq(usagePackAllocationChanges.orgId, args.orgId),
            eq(usagePackAllocationChanges.status, "previewed"),
          ),
    ),
  );
}

function* activateExistingUsagePackRemovalPlan(
  context: UsagePackChangeContext,
  existing: UsagePackAllocationChangeRow,
  at: Date,
): FinancialPlan<{
  readonly context: UsagePackChangeContext;
  readonly change: UsagePackAllocationChangeRow;
}> {
  if (
    existing.status !== "previewed" &&
    existing.status !== "applying" &&
    existing.status !== "scheduled"
  ) {
    throw new Error(`Usage pack removal ${existing.id} has an invalid status`);
  }
  const [activated] =
    existing.status === "applying"
      ? [existing]
      : yield* usagePackSqlRows(
          usagePackSqlUpdate(
            usagePackAllocationChanges,
            { status: "applying", effectiveAt: null, updatedAt: at },
            and(
              eq(usagePackAllocationChanges.id, existing.id),
              inArray(usagePackAllocationChanges.status, [
                "previewed",
                "scheduled",
              ]),
            ),
            getTableColumns(usagePackAllocationChanges),
          ),
          usagePackSqlRow(getTableColumns(usagePackAllocationChanges)),
        );
  if (!activated) {
    throw new Error(
      `Usage pack removal ${existing.id} changed while activating`,
    );
  }
  yield* invalidateUsagePackChangePreviewsPlan({
    orgId: existing.orgId,
    at,
    reason: "member_removed",
  });
  const refreshedContext = yield* memberRemovalContextPlan(
    context.subscription.id,
  );
  if (!refreshedContext) {
    throw new Error("Usage pack subscription disappeared during removal");
  }
  return { context: refreshedContext, change: activated };
}

function* prepareUsagePackMemberCreditRefundsPlan(args: {
  readonly orgId: string;
  readonly userId: string;
}): FinancialPlan<number> {
  const at = yield* usagePackSqlClock();
  requireUsagePackOverdraftTransfer(
    yield* usagePackSqlRows(
      usagePackOverdraftTransferSql(args, at),
      usagePackOverdraftTransferOutcomeRow,
    ),
  );
  const grants = yield* usagePackSqlRows(
    new QueryBuilder()
      .select(usagePackSqlSelection(getTableColumns(usagePackCreditGrants)))
      .from(usagePackCreditGrants)
      .where(refundableUsagePackCreditGrantCondition(args, at))
      .for("update")
      .getSQL(),
    usagePackSqlRow(getTableColumns(usagePackCreditGrants)),
  );
  if (grants.length === 0) {
    return 0;
  }

  let prepared = 0;
  for (const grant of grants) {
    const source = yield* loadRefundSourcePlan(grant);
    if (!source || source.status !== "available") {
      continue;
    }
    const requestedAmountCents = Math.floor(
      (source.sourceAmountCents * grant.remainingAmount) / grant.originalAmount,
    );
    if (requestedAmountCents <= 0) {
      continue;
    }
    const rows = yield* usagePackSqlRows(
      usagePackSqlUpdate(
        usagePackCreditRefunds,
        {
          status: "pending",
          refundCredits: grant.remainingAmount,
          requestedAmountCents,
          updatedAt: at,
        },
        and(
          eq(usagePackCreditRefunds.creditGrantId, grant.id),
          eq(usagePackCreditRefunds.status, "available"),
        ),
        { creditGrantId: usagePackCreditRefunds.creditGrantId },
      ),
      usagePackSqlRow({ creditGrantId: usagePackCreditRefunds.creditGrantId }),
    );
    prepared += rows.length;
  }
  return prepared;
}

function* loadRefundSourcePlan(
  grant: UsagePackCreditGrantRow,
): FinancialPlan<UsagePackCreditRefundRow | null> {
  const [existing] = yield* usagePackSqlRows(
    new QueryBuilder()
      .select(usagePackSqlSelection(getTableColumns(usagePackCreditRefunds)))
      .from(usagePackCreditRefunds)
      .where(eq(usagePackCreditRefunds.creditGrantId, grant.id))
      .limit(1)
      .getSQL(),
    usagePackSqlRow(getTableColumns(usagePackCreditRefunds)),
  );
  if (existing) {
    return existing;
  }
  const source = yield* inferLegacyRefundSourcePlan(grant);
  if (!source) {
    return null;
  }
  yield* ensureUsagePackCreditRefundSourcePlan({
    creditGrantId: grant.id,
    orgId: grant.orgId,
    userId: grant.userId,
    source,
  });
  const [created] = yield* usagePackSqlRows(
    new QueryBuilder()
      .select(usagePackSqlSelection(getTableColumns(usagePackCreditRefunds)))
      .from(usagePackCreditRefunds)
      .where(eq(usagePackCreditRefunds.creditGrantId, grant.id))
      .limit(1)
      .getSQL(),
    usagePackSqlRow(getTableColumns(usagePackCreditRefunds)),
  );
  if (!created) {
    throw new Error(`Usage pack grant ${grant.id} refund source was not saved`);
  }
  return created;
}

function* inferLegacyRefundSourcePlan(
  grant: UsagePackCreditGrantRow,
): FinancialPlan<UsagePackCreditRefundSource | null> {
  const invitationPurchaseId = legacyInvitationPurchaseId(grant.idempotencyKey);
  if (invitationPurchaseId) {
    const [purchase] = yield* usagePackSqlRows(
      new QueryBuilder()
        .select(
          usagePackSqlSelection({
            orgId: usagePackInvitationPurchases.orgId,
            acceptedUserId: usagePackInvitationPurchases.acceptedUserId,
            amountPaidCents: usagePackInvitationPurchases.amountPaidCents,
            stripePaymentIntentId:
              usagePackInvitationPurchases.stripePaymentIntentId,
          }),
        )
        .from(usagePackInvitationPurchases)
        .where(eq(usagePackInvitationPurchases.id, invitationPurchaseId))
        .limit(1)
        .getSQL(),
      usagePackSqlRow({
        orgId: usagePackInvitationPurchases.orgId,
        acceptedUserId: usagePackInvitationPurchases.acceptedUserId,
        amountPaidCents: usagePackInvitationPurchases.amountPaidCents,
        stripePaymentIntentId:
          usagePackInvitationPurchases.stripePaymentIntentId,
      }),
    );
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

function* ensureUsagePackCreditRefundSourcePlan(args: {
  readonly creditGrantId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly source: UsagePackCreditRefundSource;
}): FinancialPlan<void> {
  const source = sourceColumns(args.source);
  const [inserted] = yield* usagePackSqlRows(
    usagePackSqlInsert(
      usagePackCreditRefunds,
      {
        creditGrantId: args.creditGrantId,
        orgId: args.orgId,
        userId: args.userId,
        ...source,
      },
      {
        conflict: { target: usagePackCreditRefunds.creditGrantId },
        returning: getTableColumns(usagePackCreditRefunds),
      },
    ),
    usagePackSqlRow(getTableColumns(usagePackCreditRefunds)),
  );
  if (inserted) {
    return;
  }
  const [existing] = yield* usagePackSqlRows(
    new QueryBuilder()
      .select(usagePackSqlSelection(getTableColumns(usagePackCreditRefunds)))
      .from(usagePackCreditRefunds)
      .where(eq(usagePackCreditRefunds.creditGrantId, args.creditGrantId))
      .limit(1)
      .getSQL(),
    usagePackSqlRow(getTableColumns(usagePackCreditRefunds)),
  );
  if (!existing || !refundSourceMatches(existing, source, args)) {
    throw new Error("Usage pack credit refund source conflict");
  }
}
export function* prepareUsagePackMemberRemovalPlan(
  args: { readonly orgId: string; readonly userId: string },
  at: Date,
): FinancialPlan<{
  readonly context: UsagePackChangeContext;
  readonly change: UsagePackAllocationChangeRow;
} | null> {
  // Refund amounts come from the member's grant rows that this read keeps
  // stable through zeroing; open changes stay single by active-org index.
  yield* prepareUsagePackMemberCreditRefundsPlan(args);
  yield* usagePackSqlWrite(
    usagePackSqlUpdate(
      usagePackCreditGrants,
      { remainingAmount: 0 },
      and(
        eq(usagePackCreditGrants.orgId, args.orgId),
        eq(usagePackCreditGrants.userId, args.userId),
      ),
    ),
  );
  const context = yield* loadUsagePackChangeContextForOrgPlan(args.orgId);
  if (!context) {
    return null;
  }
  const source = activeAllocationForMember(context, args.userId);
  if (!source) {
    return null;
  }
  const existing = context.changes.find((change) => {
    return change.userId === args.userId;
  });
  if (existing?.kind === "removal") {
    return yield* activateExistingUsagePackRemovalPlan(context, existing, at);
  }
  if (
    existing &&
    existing.status !== "previewed" &&
    existing.status !== "scheduled"
  ) {
    throw new Error(
      `Usage pack allocation for ${args.userId} has a paid change in progress`,
    );
  }
  if (existing) {
    yield* usagePackSqlWrite(
      usagePackSqlUpdate(
        usagePackAllocationChanges,
        {
          status: "failed",
          failureReason: "member_removed",
          completedAt: at,
          updatedAt: at,
        },
        eq(usagePackAllocationChanges.id, existing.id),
      ),
    );
  }
  yield* invalidateUsagePackChangePreviewsPlan({
    orgId: args.orgId,
    at,
    reason: "member_removed",
  });
  const [change] = yield* usagePackSqlRows(
    usagePackSqlInsert(
      usagePackAllocationChanges,
      {
        usagePackSubscriptionId: context.subscription.id,
        orgId: args.orgId,
        userId: args.userId,
        sourceAllocationId: source.id,
        kind: "removal",
        status: "applying",
        sourceUsagePackUsd: source.usagePackUsd,
        sourceStripePriceId: source.stripePriceId,
        immediateAmountCents: 0,
        nextRecurringAmountCents: 0,
        createdAt: at,
        updatedAt: at,
      },
      { returning: getTableColumns(usagePackAllocationChanges) },
    ),
    usagePackSqlRow(getTableColumns(usagePackAllocationChanges)),
  );
  if (!change) {
    throw new Error("Failed to create usage pack member removal");
  }
  const refreshedContext = yield* memberRemovalContextPlan(
    context.subscription.id,
  );
  if (!refreshedContext) {
    throw new Error("Usage pack subscription disappeared during removal");
  }
  return { context: refreshedContext, change };
}
