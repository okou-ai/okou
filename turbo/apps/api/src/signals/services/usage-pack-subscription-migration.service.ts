import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type {
  MemberUsagePack,
  UsagePackMigrationConfiguration,
  UsagePackMigrationConfirmResponse,
  UsagePackMigrationPreviewResponse,
  UsagePackMigrationRevisionPreviewResponse,
  UsagePackMigrationStateResponse,
  UsagePackUsd,
} from "@okouai/api-contracts/contracts/billing";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  usagePackAllocations,
  usagePackInvitationPurchases,
  usagePackSubscriptionMigrations,
  usagePackSubscriptionMigrationSelections,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import { and, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  getStripeClient,
  type StripeClient,
  type StripeInvoice,
  type StripeInvoiceLine,
  type StripePriceRecurring,
  type StripeSchedulePhaseDiscountParam,
  type StripeSchedulePhaseItemParam,
  type StripeSchedulePhaseParam,
  type StripeSubscription,
  type StripeSubscriptionItem,
  type StripeSubscriptionUpdateItemParam,
} from "../external/stripe-client";
import { lockUsagePackBillingOrg } from "./usage-pack-allocation-change.service";
import { writeUsagePackPendingSnapshots } from "./usage-pack-pending-snapshot.service";
import type { BillingReconciliationScope } from "./billing-reconciliation-scope";
import {
  handleUsagePackInvoicePaid,
  handleUsagePackSubscriptionUpdated,
  loadUsagePackCatalog,
  usagePackSubscriptionIdFromMetadata,
  usagePackSubscriptionMetadata,
  type UsagePackInvoiceInput,
  type UsagePackSubscriptionInput,
} from "./usage-pack-subscription.service";
import { safeJsonParse, settle } from "../utils";
import {
  activeUsagePackPlanPriceId,
  activeUsagePackPriceId,
  isUsagePackPlanPriceId,
  tierForKnownPriceId,
  usagePackUsdForKnownPriceId,
  type SubscriptionCheckoutTier,
} from "./billing-checkout.service";

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const RECONCILIATION_DELAY_MS = 5 * 60 * 1000;
const STRIPE_INVOICE_LINE_PAGE_SIZE = 100;
const OPEN_MIGRATION_STATUSES = [
  "previewed",
  "applying",
  "revising",
  "scheduled",
] as const;
const RECONCILING_MIGRATION_STATUSES = [
  "applying",
  "revising",
  "scheduled",
] as const;
const L = logger("UsagePackSubscriptionMigration");

const revisionPreviewTokenPayloadSchema = z.object({
  version: z.literal(1),
  orgId: z.string().min(1),
  migrationId: z.uuid(),
  requestHash: z.string().length(64),
  baseConfigurationHash: z.string().length(64),
  desiredConfigurationHash: z.string().length(64),
  expiresAt: z.iso.datetime(),
});

type RevisionPreviewTokenPayload = z.infer<
  typeof revisionPreviewTokenPayloadSchema
>;

type MigrationRow = typeof usagePackSubscriptionMigrations.$inferSelect;
type MigrationSelectionRow =
  typeof usagePackSubscriptionMigrationSelections.$inferSelect;

export type UsagePackMigrationOwner =
  | { readonly userId: string }
  | {
      readonly invitationId: string;
      readonly normalizedEmail: string;
      readonly role: "admin" | "member";
      readonly inviterUserId: string;
    };

interface LegacyMigrationContext {
  readonly org: {
    readonly orgId: string;
    readonly tier: SubscriptionCheckoutTier;
    readonly stripeCustomerId: string;
    readonly stripeSubscriptionId: string;
  };
  readonly subscription: StripeSubscription;
  readonly legacyItem: StripeSubscriptionItem;
}

interface PreparedMigrationSelection {
  readonly userId: string | null;
  readonly invitationId: string | null;
  readonly normalizedEmail: string | null;
  readonly role: "admin" | "member" | null;
  readonly inviterUserId: string | null;
  readonly usagePackUsd: UsagePackUsd;
  readonly stripePriceId: string;
  readonly unitAmountCents: number;
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
}

type AppliedMigrationResult =
  | {
      readonly status: "active";
      readonly response: UsagePackMigrationConfirmResponse;
      readonly orgId: string;
    }
  | { readonly status: "failed"; readonly orgId: string };

type MigrationStateResult =
  | {
      readonly status: "ready";
      readonly state: UsagePackMigrationStateResponse;
    }
  | { readonly status: "not_found" }
  | { readonly status: "conflict" };

type MigrationPreviewResult =
  | {
      readonly status: "ready";
      readonly preview: UsagePackMigrationPreviewResponse;
    }
  | { readonly status: "not_found" }
  | { readonly status: "owners_changed" }
  | { readonly status: "conflict" };

type MigrationConfirmResult =
  | {
      readonly status: "confirmed";
      readonly response: UsagePackMigrationConfirmResponse;
    }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "owners_changed" }
  | { readonly status: "conflict" };

type MigrationRevisionPreviewResult =
  | {
      readonly status: "ready";
      readonly preview: UsagePackMigrationRevisionPreviewResponse;
    }
  | { readonly status: "not_found" }
  | { readonly status: "owners_changed" }
  | { readonly status: "same_configuration" }
  | { readonly status: "conflict" };

type MigrationRevisionConfirmResult =
  | {
      readonly status: "confirmed";
      readonly response: UsagePackMigrationConfirmResponse;
    }
  | { readonly status: "not_found" }
  | { readonly status: "invalid_preview" }
  | { readonly status: "owners_changed" }
  | { readonly status: "conflict" };

interface UsagePackMigrationLifecycleOutcome {
  readonly handled: boolean;
  readonly orgId: string | null;
}

function stripeObjectId(
  value: string | { readonly id: string } | null | undefined,
): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function safeInvoiceAmount(invoice: StripeInvoice, label: string): number {
  if (
    !Number.isSafeInteger(invoice.amount_due) ||
    invoice.amount_due < 0 ||
    invoice.currency.length !== 3
  ) {
    throw new Error(`Stripe ${label} migration preview has an invalid amount`);
  }
  return invoice.amount_due;
}

function migrationInvoiceLinePriceId(line: StripeInvoiceLine): string | null {
  const price = line.pricing?.price_details?.price;
  return typeof price === "string" ? price : (price?.id ?? null);
}

function migrationInvoiceLineAmountWithTax(line: StripeInvoiceLine): number {
  const discountAmount = (line.discount_amounts ?? []).reduce(
    (total, discount) => {
      return total + discount.amount;
    },
    0,
  );
  const exclusiveTax = (line.taxes ?? []).reduce((total, tax) => {
    return tax.tax_behavior === "exclusive" ? total + tax.amount : total;
  }, 0);
  const amount = line.amount - discountAmount + exclusiveTax;
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Stripe migration preview line has an invalid amount");
  }
  return amount;
}

async function listCompleteMigrationPreviewLines(
  stripe: StripeClient,
  invoice: StripeInvoice,
  signal: AbortSignal,
): Promise<readonly StripeInvoiceLine[]> {
  if (!invoice.lines.has_more) {
    return invoice.lines.data;
  }
  const lines: StripeInvoiceLine[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const page = await stripe.invoices.listLineItems(invoice.id, {
      limit: STRIPE_INVOICE_LINE_PAGE_SIZE,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    signal.throwIfAborted();
    lines.push(...page.data);
    if (!page.has_more) {
      return lines;
    }
    const last = page.data.at(-1);
    if (!last?.id) {
      throw new Error(
        `Stripe invoice ${invoice.id} returned an incomplete line-item page`,
      );
    }
    startingAfter = last.id;
  }
}

function migrationItemQuantities(
  items: readonly StripeSchedulePhaseItemParam[],
): ReadonlyMap<string, number> {
  const quantities = new Map<string, number>();
  for (const item of items) {
    const quantity = item.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error("Stripe migration schedule item has an invalid quantity");
    }
    quantities.set(item.price, (quantities.get(item.price) ?? 0) + quantity);
  }
  return quantities;
}

function migrationFutureRecurringAmount(
  invoice: StripeInvoice,
  lines: readonly StripeInvoiceLine[],
  effectiveAt: number,
  items: readonly StripeSchedulePhaseItemParam[],
): number {
  const expectedQuantities = migrationItemQuantities(items);
  const actualQuantities = new Map<string, number>();
  let amount = 0;
  for (const line of lines) {
    const priceId = migrationInvoiceLinePriceId(line);
    if (
      line.parent?.type !== "subscription_item_details" ||
      line.parent.subscription_item_details?.proration !== false ||
      line.period.start !== effectiveAt ||
      line.period.end <= effectiveAt ||
      priceId === null ||
      !expectedQuantities.has(priceId)
    ) {
      continue;
    }
    const quantity = line.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error("Stripe migration preview line has an invalid quantity");
    }
    actualQuantities.set(
      priceId,
      (actualQuantities.get(priceId) ?? 0) + quantity,
    );
    amount += migrationInvoiceLineAmountWithTax(line);
  }
  const hasExactItems = [...expectedQuantities].every(([priceId, quantity]) => {
    return actualQuantities.get(priceId) === quantity;
  });
  if (
    invoice.currency.length !== 3 ||
    !hasExactItems ||
    !Number.isSafeInteger(amount) ||
    amount < 0
  ) {
    throw new Error(
      "Stripe migration future recurring preview has an invalid amount",
    );
  }
  return amount;
}

function migrationOwnerId(owner: UsagePackMigrationOwner): string {
  return "userId" in owner ? owner.userId : owner.invitationId;
}

function selectionOwnerId(selection: MigrationSelectionRow): string {
  const ownerId = selection.userId ?? selection.invitationId;
  if (!ownerId) {
    throw new Error(
      `Usage pack migration selection ${selection.id} has no owner`,
    );
  }
  return ownerId;
}

function exactOwnerIds(
  selections: readonly { readonly memberId: string }[],
  owners: readonly UsagePackMigrationOwner[],
): boolean {
  const selectionIds = new Set(
    selections.map((selection) => {
      return selection.memberId;
    }),
  );
  const ownerIds = new Set(owners.map(migrationOwnerId));
  return (
    selectionIds.size === selections.length &&
    ownerIds.size === owners.length &&
    selectionIds.size === ownerIds.size &&
    [...ownerIds].every((ownerId) => {
      return selectionIds.has(ownerId);
    })
  );
}

function paidOwnersStillPresent(
  selections: readonly MigrationSelectionRow[],
  ownerIds: readonly string[],
): boolean {
  const stored = new Set(selections.map(selectionOwnerId));
  const current = new Set(ownerIds);
  return (
    stored.size === selections.length &&
    current.size === ownerIds.length &&
    [...stored].every((ownerId) => {
      return current.has(ownerId);
    })
  );
}

function preparedSelectionOwnerId(
  selection: PreparedMigrationSelection,
): string {
  const ownerId = selection.userId ?? selection.invitationId;
  if (!ownerId) {
    throw new Error("Prepared usage pack migration selection has no owner");
  }
  return ownerId;
}

function revisionRequestHash(args: {
  readonly targetTier: SubscriptionCheckoutTier;
  readonly memberUsagePacks: readonly MemberUsagePack[];
}): string {
  const memberUsagePacks = [...args.memberUsagePacks].sort((left, right) => {
    return left.memberId.localeCompare(right.memberId);
  });
  return createHash("sha256")
    .update(JSON.stringify({ targetTier: args.targetTier, memberUsagePacks }))
    .digest("hex");
}

interface MigrationConfigurationHashInput {
  readonly targetTier: SubscriptionCheckoutTier;
  readonly stripePlanPriceId: string;
  readonly currentRecurringAmountCents: number;
  readonly nextRecurringAmountCents: number;
  readonly recurringDifferenceCents: number;
  readonly currency: string;
  readonly effectiveAt: Date;
  readonly stripeScheduleId: string | null;
  readonly selections: readonly PreparedMigrationSelection[];
}

function migrationConfigurationHash(
  input: MigrationConfigurationHashInput,
): string {
  const selections = [...input.selections]
    .sort((left, right) => {
      return preparedSelectionOwnerId(left).localeCompare(
        preparedSelectionOwnerId(right),
      );
    })
    .map((selection) => {
      return {
        userId: selection.userId,
        invitationId: selection.invitationId,
        normalizedEmail: selection.normalizedEmail,
        role: selection.role,
        inviterUserId: selection.inviterUserId,
        usagePackUsd: selection.usagePackUsd,
        stripePriceId: selection.stripePriceId,
        unitAmountCents: selection.unitAmountCents,
        purchasedCredits: selection.purchasedCredits,
        bonusCredits: selection.bonusCredits,
      };
    });
  return createHash("sha256")
    .update(
      JSON.stringify({
        targetTier: input.targetTier,
        stripePlanPriceId: input.stripePlanPriceId,
        currentRecurringAmountCents: input.currentRecurringAmountCents,
        nextRecurringAmountCents: input.nextRecurringAmountCents,
        recurringDifferenceCents: input.recurringDifferenceCents,
        currency: input.currency,
        effectiveAt: input.effectiveAt.toISOString(),
        stripeScheduleId: input.stripeScheduleId,
        selections,
      }),
    )
    .digest("hex");
}

function preparedSelectionFromStored(
  selection: MigrationSelectionRow,
): PreparedMigrationSelection {
  return {
    userId: selection.userId,
    invitationId: selection.invitationId,
    normalizedEmail: selection.normalizedEmail,
    role: selection.role,
    inviterUserId: selection.inviterUserId,
    usagePackUsd: migrationUsagePackUsd(selection.usagePackUsd),
    stripePriceId: selection.stripePriceId,
    unitAmountCents: selection.unitAmountCents,
    purchasedCredits: selection.purchasedCredits,
    bonusCredits: selection.bonusCredits,
  };
}

function migrationUsagePackUsd(value: number): UsagePackUsd {
  if (value === 20 || value === 50 || value === 100 || value === 200) {
    return value;
  }
  throw new Error(`Invalid stored usage pack amount: ${value}`);
}

function storedMigrationConfigurationHash(
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
): string {
  return migrationConfigurationHash({
    targetTier: migration.targetTier,
    stripePlanPriceId: migration.stripePlanPriceId,
    currentRecurringAmountCents: migration.currentRecurringAmountCents,
    nextRecurringAmountCents: migration.nextRecurringAmountCents,
    recurringDifferenceCents: migration.recurringDifferenceCents,
    currency: migration.currency,
    effectiveAt: migration.effectiveAt,
    stripeScheduleId: migration.stripeScheduleId,
    selections: selections.map(preparedSelectionFromStored),
  });
}

function migrationScheduleRevisionHash(
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
): string {
  const selectionIds = selections
    .map((selection) => {
      return selection.id;
    })
    .sort();
  return createHash("sha256")
    .update(storedMigrationConfigurationHash(migration, selections))
    .update("\0")
    .update(JSON.stringify(selectionIds))
    .digest("hex");
}

function revisionPreviewTokenSignature(encodedPayload: string): Buffer {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(encodedPayload)
    .digest();
}

function createRevisionPreviewToken(
  payload: RevisionPreviewTokenPayload,
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signature =
    revisionPreviewTokenSignature(encodedPayload).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

function parseRevisionPreviewToken(
  token: string,
): RevisionPreviewTokenPayload | null {
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) {
    return null;
  }
  const providedSignature = Buffer.from(encodedSignature, "base64url");
  const expectedSignature = revisionPreviewTokenSignature(encodedPayload);
  if (
    providedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignature, expectedSignature)
  ) {
    return null;
  }
  const parsed = safeJsonParse(
    Buffer.from(encodedPayload, "base64url").toString("utf8"),
  );
  const result = revisionPreviewTokenPayloadSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

async function loadOpenMigrationForOrg(
  db: Pick<Db, "select">,
  orgId: string,
): Promise<MigrationRow | null> {
  const [migration] = await db
    .select()
    .from(usagePackSubscriptionMigrations)
    .where(
      and(
        eq(usagePackSubscriptionMigrations.orgId, orgId),
        inArray(usagePackSubscriptionMigrations.status, [
          ...OPEN_MIGRATION_STATUSES,
        ]),
      ),
    )
    .orderBy(desc(usagePackSubscriptionMigrations.createdAt))
    .limit(1);
  return migration ?? null;
}

async function loadMigrationSelections(
  db: Pick<Db, "select">,
  migrationId: string,
): Promise<readonly MigrationSelectionRow[]> {
  return await db
    .select()
    .from(usagePackSubscriptionMigrationSelections)
    .where(
      eq(usagePackSubscriptionMigrationSelections.migrationId, migrationId),
    );
}

function legacyPlanItem(
  subscription: StripeSubscription,
  tier: SubscriptionCheckoutTier,
): StripeSubscriptionItem | null {
  const planItems = subscription.items.data.filter((item) => {
    return tierForKnownPriceId(item.price.id) !== null;
  });
  if (planItems.length !== 1) {
    return null;
  }
  const item = planItems[0];
  return item &&
    tierForKnownPriceId(item.price.id) === tier &&
    !isUsagePackPlanPriceId(item.price.id) &&
    (item.quantity ?? 1) === 1
    ? item
    : null;
}

function subscriptionHasUsagePackItems(
  subscription: StripeSubscription,
): boolean {
  return subscription.items.data.some((item) => {
    return (
      isUsagePackPlanPriceId(item.price.id) ||
      usagePackUsdForKnownPriceId(item.price.id) !== null
    );
  });
}

function eligibleLegacySubscription(subscription: StripeSubscription): boolean {
  return (
    subscription.status === "active" &&
    subscription.cancel_at === null &&
    !subscription.cancel_at_period_end &&
    stripeObjectId(subscription.schedule) === null
  );
}

async function loadLegacyMigrationContext(
  db: Pick<Db, "select">,
  orgId: string,
): Promise<LegacyMigrationContext | null> {
  const [row] = await db
    .select({
      orgId: orgMetadata.orgId,
      tier: orgMetadata.tier,
      stripeCustomerId: orgMetadata.stripeCustomerId,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      subscriptionStatus: orgMetadata.subscriptionStatus,
      cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
      pendingSubscriptionScheduleId: orgMetadata.pendingSubscriptionScheduleId,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  if (
    !row ||
    (row.tier !== "pro" && row.tier !== "team") ||
    !row.stripeCustomerId ||
    !row.stripeSubscriptionId ||
    row.subscriptionStatus !== "active" ||
    row.cancelAtPeriodEnd ||
    row.pendingSubscriptionScheduleId
  ) {
    return null;
  }

  const subscription = await getStripeClient().subscriptions.retrieve(
    row.stripeSubscriptionId,
  );
  const legacyItem = legacyPlanItem(subscription, row.tier);
  if (
    !eligibleLegacySubscription(subscription) ||
    stripeObjectId(subscription.customer) !== row.stripeCustomerId ||
    !legacyItem ||
    subscriptionHasUsagePackItems(subscription)
  ) {
    return null;
  }
  return {
    org: {
      orgId: row.orgId,
      tier: row.tier,
      stripeCustomerId: row.stripeCustomerId,
      stripeSubscriptionId: row.stripeSubscriptionId,
    },
    subscription,
    legacyItem,
  };
}

function migrationState(
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
): UsagePackMigrationStateResponse {
  if (migration.status === "completed" || migration.status === "failed") {
    throw new Error(`Migration ${migration.id} is not open`);
  }
  return {
    tier: migration.sourceTier,
    targetTier: migration.targetTier,
    status: migration.status === "revising" ? "applying" : migration.status,
    migrationId: migration.id,
    effectiveAt: migration.effectiveAt.toISOString(),
    hostedInvoiceUrl: migration.hostedInvoiceUrl,
    configuration: migrationConfiguration(migration, selections),
  };
}

function migrationConfiguration(
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
): UsagePackMigrationConfiguration {
  const memberUsagePacks = selections
    .map((selection) => {
      return {
        memberId: selectionOwnerId(selection),
        usagePackUsd: migrationUsagePackUsd(selection.usagePackUsd),
      };
    })
    .sort((left, right) => {
      return left.memberId.localeCompare(right.memberId);
    });
  return {
    tier: migration.targetTier,
    memberUsagePacks,
    recurringAmountCents: migration.nextRecurringAmountCents,
    currency: migration.currency,
  };
}

export async function getUsagePackMigrationState(
  db: Db,
  orgId: string,
): Promise<MigrationStateResult> {
  const at = nowDate();
  const open = await loadOpenMigrationForOrg(db, orgId);
  if (open?.status === "previewed" && open.previewExpiresAt <= at) {
    await db
      .update(usagePackSubscriptionMigrations)
      .set({
        status: "failed",
        failureReason: "preview_expired",
        completedAt: at,
        updatedAt: at,
      })
      .where(
        and(
          eq(usagePackSubscriptionMigrations.id, open.id),
          eq(usagePackSubscriptionMigrations.status, "previewed"),
        ),
      );
  } else if (open) {
    const selections = await loadMigrationSelections(db, open.id);
    return { status: "ready", state: migrationState(open, selections) };
  }

  const context = await loadLegacyMigrationContext(db, orgId);
  if (!context) {
    return { status: "not_found" };
  }
  if (context.subscription.pending_update) {
    return { status: "conflict" };
  }
  return {
    status: "ready",
    state: {
      tier: context.org.tier,
      targetTier: null,
      status: "eligible",
      migrationId: null,
      effectiveAt: new Date(
        migrationPeriod(context.legacyItem).end * 1000,
      ).toISOString(),
      hostedInvoiceUrl: null,
    },
  };
}

function migrationPeriod(item: StripeSubscriptionItem): {
  readonly start: number;
  readonly end: number;
} {
  const start = item.current_period_start;
  const end = item.current_period_end;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end <= start
  ) {
    throw new Error("Legacy subscription has an invalid billing period");
  }
  return { start, end };
}

function migrationUpdateItems(
  legacyItemId: string,
  stripePlanPriceId: string,
  selections: readonly {
    readonly stripePriceId: string;
  }[],
): StripeSubscriptionUpdateItemParam[] {
  const quantities = new Map<string, number>();
  for (const selection of selections) {
    quantities.set(
      selection.stripePriceId,
      (quantities.get(selection.stripePriceId) ?? 0) + 1,
    );
  }
  return [
    { id: legacyItemId, deleted: true },
    { price: stripePlanPriceId, quantity: 1 },
    ...[...quantities].map(([price, quantity]) => {
      return { price, quantity };
    }),
  ];
}

async function prepareMigrationSelections(
  requested: readonly MemberUsagePack[],
  owners: readonly UsagePackMigrationOwner[],
): Promise<readonly PreparedMigrationSelection[] | null> {
  if (!exactOwnerIds(requested, owners)) {
    return null;
  }
  const catalog = await loadUsagePackCatalog();
  const ownersById = new Map(
    owners.map((owner) => {
      return [migrationOwnerId(owner), owner] as const;
    }),
  );
  return requested.flatMap(
    (requestedSelection): readonly PreparedMigrationSelection[] => {
      if (requestedSelection.usagePackUsd === 0) {
        return [];
      }
      const owner = ownersById.get(requestedSelection.memberId);
      const catalogItem = catalog.find((item) => {
        return item.usagePackUsd === requestedSelection.usagePackUsd;
      });
      const stripePriceId = activeUsagePackPriceId(
        requestedSelection.usagePackUsd,
      );
      const unitAmountCents = catalogItem
        ? Math.round(catalogItem.priceUsd * 100)
        : 0;
      if (
        !owner ||
        !catalogItem ||
        !stripePriceId ||
        !Number.isSafeInteger(unitAmountCents) ||
        unitAmountCents <= 0
      ) {
        throw new Error(
          `Usage pack $${requestedSelection.usagePackUsd} is not configured`,
        );
      }
      return [
        {
          userId: "userId" in owner ? owner.userId : null,
          invitationId: "invitationId" in owner ? owner.invitationId : null,
          normalizedEmail:
            "invitationId" in owner ? owner.normalizedEmail : null,
          role: "invitationId" in owner ? owner.role : null,
          inviterUserId: "invitationId" in owner ? owner.inviterUserId : null,
          usagePackUsd: requestedSelection.usagePackUsd,
          stripePriceId,
          unitAmountCents,
          purchasedCredits: catalogItem.purchasedCredits,
          bonusCredits: catalogItem.bonusCredits,
        },
      ];
    },
  );
}

async function persistMigrationPreview(
  db: Db,
  context: LegacyMigrationContext,
  selections: readonly PreparedMigrationSelection[],
  args: {
    readonly targetTier: SubscriptionCheckoutTier;
    readonly stripePlanPriceId: string;
    readonly currentRecurringAmountCents: number;
    readonly nextRecurringAmountCents: number;
    readonly recurringDifferenceCents: number;
    readonly currency: string;
    readonly effectiveAt: Date;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  },
): Promise<MigrationRow | null> {
  return await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, context.org.orgId);
    const [inProgress] = await tx
      .select({ id: usagePackSubscriptionMigrations.id })
      .from(usagePackSubscriptionMigrations)
      .where(
        and(
          eq(usagePackSubscriptionMigrations.orgId, context.org.orgId),
          inArray(usagePackSubscriptionMigrations.status, [
            "applying",
            "revising",
            "scheduled",
          ]),
        ),
      )
      .limit(1);
    if (inProgress) {
      return null;
    }
    await tx
      .update(usagePackSubscriptionMigrations)
      .set({
        status: "failed",
        failureReason: "preview_superseded",
        completedAt: args.createdAt,
        updatedAt: args.createdAt,
      })
      .where(
        and(
          eq(usagePackSubscriptionMigrations.orgId, context.org.orgId),
          eq(usagePackSubscriptionMigrations.status, "previewed"),
        ),
      );
    const [migration] = await tx
      .insert(usagePackSubscriptionMigrations)
      .values({
        orgId: context.org.orgId,
        sourceTier: context.org.tier,
        targetTier: args.targetTier,
        stripeCustomerId: context.org.stripeCustomerId,
        stripeSubscriptionId: context.org.stripeSubscriptionId,
        legacyStripePriceId: context.legacyItem.price.id,
        legacyStripeItemId: context.legacyItem.id,
        stripePlanPriceId: args.stripePlanPriceId,
        currentRecurringAmountCents: args.currentRecurringAmountCents,
        nextRecurringAmountCents: args.nextRecurringAmountCents,
        recurringDifferenceCents: args.recurringDifferenceCents,
        currency: args.currency,
        effectiveAt: args.effectiveAt,
        previewExpiresAt: args.expiresAt,
        createdAt: args.createdAt,
        updatedAt: args.createdAt,
      })
      .returning();
    if (!migration) {
      throw new Error("Failed to create usage pack migration preview");
    }
    if (selections.length > 0) {
      await tx.insert(usagePackSubscriptionMigrationSelections).values(
        selections.map((selection) => {
          return { migrationId: migration.id, ...selection };
        }),
      );
    }
    return migration;
  });
}

export async function previewUsagePackSubscriptionMigration(
  db: Db,
  args: {
    readonly orgId: string;
    readonly targetTier: SubscriptionCheckoutTier;
    readonly memberUsagePacks: readonly MemberUsagePack[];
    readonly owners: readonly UsagePackMigrationOwner[];
  },
  signal: AbortSignal,
): Promise<MigrationPreviewResult> {
  const context = await loadLegacyMigrationContext(db, args.orgId);
  signal.throwIfAborted();
  if (!context) {
    return { status: "not_found" };
  }
  if (context.subscription.pending_update) {
    return { status: "conflict" };
  }
  const selections = await prepareMigrationSelections(
    args.memberUsagePacks,
    args.owners,
  );
  signal.throwIfAborted();
  if (!selections) {
    return { status: "owners_changed" };
  }

  const period = migrationPeriod(context.legacyItem);
  const stripePlanPriceId = activeUsagePackPlanPriceId(args.targetTier);
  if (!stripePlanPriceId) {
    throw new Error(
      `${args.targetTier} usage pack plan Price is not configured`,
    );
  }
  const targetItems = migrationUpdateItems(
    context.legacyItem.id,
    stripePlanPriceId,
    selections,
  );
  const currentItems = context.subscription.items.data.map((item) => {
    return {
      id: item.id,
      price: item.price.id,
      quantity: item.quantity ?? 1,
    };
  });
  const stripe = getStripeClient();
  const [currentPreview, targetPreview] = await Promise.all([
    stripe.invoices.createPreview({
      subscription: context.subscription.id,
      preview_mode: "recurring",
      subscription_details: {
        items: currentItems,
      },
    }),
    stripe.invoices.createPreview({
      subscription: context.subscription.id,
      preview_mode: "recurring",
      subscription_details: {
        items: targetItems,
      },
    }),
  ]);
  signal.throwIfAborted();
  if (currentPreview.currency !== targetPreview.currency) {
    throw new Error("Stripe migration previews returned different currencies");
  }
  const currentRecurringAmountCents = safeInvoiceAmount(
    currentPreview,
    "current recurring",
  );
  const nextRecurringAmountCents = safeInvoiceAmount(
    targetPreview,
    "target recurring",
  );
  const recurringDifferenceCents =
    nextRecurringAmountCents - currentRecurringAmountCents;
  const createdAt = nowDate();
  const expiresAt = new Date(createdAt.getTime() + PREVIEW_TTL_MS);
  const effectiveAt = new Date(period.end * 1000);
  const migration = await persistMigrationPreview(db, context, selections, {
    targetTier: args.targetTier,
    stripePlanPriceId,
    currentRecurringAmountCents,
    nextRecurringAmountCents,
    recurringDifferenceCents,
    currency: targetPreview.currency,
    effectiveAt,
    createdAt,
    expiresAt,
  });
  if (!migration) {
    return { status: "conflict" };
  }
  const purchasedCredits = selections.reduce((total, selection) => {
    return total + selection.purchasedCredits;
  }, 0);
  const bonusCredits = selections.reduce((total, selection) => {
    return total + selection.bonusCredits;
  }, 0);
  return {
    status: "ready",
    preview: {
      migrationId: migration.id,
      tier: migration.sourceTier,
      targetTier: migration.targetTier,
      currentRecurringAmountCents,
      nextRecurringAmountCents,
      recurringDifferenceCents,
      currency: migration.currency,
      purchasedCredits,
      bonusCredits,
      totalCredits: purchasedCredits + bonusCredits,
      effectiveAt: migration.effectiveAt.toISOString(),
      expiresAt: migration.previewExpiresAt.toISOString(),
    },
  };
}

interface PreparedMigrationRevision {
  readonly migration: MigrationRow;
  readonly desiredSelections: readonly PreparedMigrationSelection[];
  readonly targetTier: SubscriptionCheckoutTier;
  readonly stripePlanPriceId: string;
  readonly nextRecurringAmountCents: number;
  readonly recurringDifferenceCents: number;
  readonly revisionDifferenceCents: number;
  readonly currency: string;
  readonly baseConfigurationHash: string;
  readonly desiredConfigurationHash: string;
  readonly requestHash: string;
  readonly expiresAt: Date;
}

interface MigrationScheduleConfiguration {
  readonly end_behavior: "release";
  readonly proration_behavior: "none";
  readonly phases: StripeSchedulePhaseParam[];
}

type PrepareMigrationRevisionResult =
  | { readonly status: "ready"; readonly prepared: PreparedMigrationRevision }
  | { readonly status: "not_found" }
  | { readonly status: "owners_changed" }
  | { readonly status: "same_configuration" }
  | { readonly status: "conflict" };

async function loadMigrationForRevision(
  db: Pick<Db, "select">,
  orgId: string,
  migrationId: string,
): Promise<{
  readonly migration: MigrationRow;
  readonly selections: readonly MigrationSelectionRow[];
} | null> {
  const [migration] = await db
    .select()
    .from(usagePackSubscriptionMigrations)
    .where(
      and(
        eq(usagePackSubscriptionMigrations.id, migrationId),
        eq(usagePackSubscriptionMigrations.orgId, orgId),
      ),
    )
    .limit(1);
  if (!migration) {
    return null;
  }
  const selections = await loadMigrationSelections(db, migration.id);
  return { migration, selections };
}

async function prepareMigrationRevision(
  db: Db,
  args: {
    readonly orgId: string;
    readonly migrationId: string;
    readonly targetTier: SubscriptionCheckoutTier;
    readonly memberUsagePacks: readonly MemberUsagePack[];
    readonly owners: readonly UsagePackMigrationOwner[];
  },
  signal: AbortSignal,
): Promise<PrepareMigrationRevisionResult> {
  const stored = await loadMigrationForRevision(
    db,
    args.orgId,
    args.migrationId,
  );
  signal.throwIfAborted();
  if (!stored) {
    return { status: "not_found" };
  }
  if (
    stored.migration.status !== "scheduled" ||
    !stored.migration.stripeScheduleId ||
    stored.migration.effectiveAt <= nowDate()
  ) {
    return { status: "conflict" };
  }
  const desiredSelections = await prepareMigrationSelections(
    args.memberUsagePacks,
    args.owners,
  );
  signal.throwIfAborted();
  if (!desiredSelections) {
    return { status: "owners_changed" };
  }
  const stripePlanPriceId = activeUsagePackPlanPriceId(args.targetTier);
  if (!stripePlanPriceId) {
    throw new Error(
      `${args.targetTier} usage pack plan Price is not configured`,
    );
  }
  const stripe = getStripeClient();
  const subscription = await stripe.subscriptions.retrieve(
    stored.migration.stripeSubscriptionId,
  );
  signal.throwIfAborted();
  if (!legacyMigrationShape(stored.migration, subscription)) {
    return { status: "conflict" };
  }
  const legacyItem = legacyPlanItem(subscription, stored.migration.sourceTier);
  if (!legacyItem) {
    return { status: "conflict" };
  }
  const scheduleDetails = migrationScheduleConfiguration(
    stored.migration,
    stripePlanPriceId,
    desiredSelections,
    subscription,
    legacyItem,
  );
  const targetItems = scheduleDetails.phases.at(-1)?.items;
  if (!targetItems) {
    throw new Error("Stripe migration revision has no future phase");
  }
  const targetPreview = await stripe.invoices.createPreview({
    schedule: stored.migration.stripeScheduleId,
    preview_mode: "next",
    schedule_details: scheduleDetails,
  });
  signal.throwIfAborted();
  if (targetPreview.currency !== stored.migration.currency) {
    throw new Error("Stripe migration revision changed currency");
  }
  const targetLines = await listCompleteMigrationPreviewLines(
    stripe,
    targetPreview,
    signal,
  );
  const nextRecurringAmountCents = migrationFutureRecurringAmount(
    targetPreview,
    targetLines,
    Math.floor(stored.migration.effectiveAt.getTime() / 1000),
    targetItems,
  );
  const recurringDifferenceCents =
    nextRecurringAmountCents - stored.migration.currentRecurringAmountCents;
  const revisionDifferenceCents =
    nextRecurringAmountCents - stored.migration.nextRecurringAmountCents;
  const baseConfigurationHash = storedMigrationConfigurationHash(
    stored.migration,
    stored.selections,
  );
  const desiredConfigurationHash = migrationConfigurationHash({
    targetTier: args.targetTier,
    stripePlanPriceId,
    currentRecurringAmountCents: stored.migration.currentRecurringAmountCents,
    nextRecurringAmountCents,
    recurringDifferenceCents,
    currency: targetPreview.currency,
    effectiveAt: stored.migration.effectiveAt,
    stripeScheduleId: stored.migration.stripeScheduleId,
    selections: desiredSelections,
  });
  if (desiredConfigurationHash === baseConfigurationHash) {
    return { status: "same_configuration" };
  }
  const createdAt = nowDate();
  return {
    status: "ready",
    prepared: {
      migration: stored.migration,
      desiredSelections,
      targetTier: args.targetTier,
      stripePlanPriceId,
      nextRecurringAmountCents,
      recurringDifferenceCents,
      revisionDifferenceCents,
      currency: targetPreview.currency,
      baseConfigurationHash,
      desiredConfigurationHash,
      requestHash: revisionRequestHash(args),
      expiresAt: new Date(createdAt.getTime() + PREVIEW_TTL_MS),
    },
  };
}

export async function previewUsagePackSubscriptionMigrationRevision(
  db: Db,
  args: {
    readonly orgId: string;
    readonly migrationId: string;
    readonly targetTier: SubscriptionCheckoutTier;
    readonly memberUsagePacks: readonly MemberUsagePack[];
    readonly owners: readonly UsagePackMigrationOwner[];
  },
  signal: AbortSignal,
): Promise<MigrationRevisionPreviewResult> {
  const result = await prepareMigrationRevision(db, args, signal);
  if (result.status !== "ready") {
    return result;
  }
  const { prepared } = result;
  const purchasedCredits = prepared.desiredSelections.reduce(
    (total, selection) => {
      return total + selection.purchasedCredits;
    },
    0,
  );
  const bonusCredits = prepared.desiredSelections.reduce((total, selection) => {
    return total + selection.bonusCredits;
  }, 0);
  return {
    status: "ready",
    preview: {
      migrationId: prepared.migration.id,
      tier: prepared.migration.targetTier,
      targetTier: args.targetTier,
      currentRecurringAmountCents: prepared.migration.nextRecurringAmountCents,
      nextRecurringAmountCents: prepared.nextRecurringAmountCents,
      recurringDifferenceCents: prepared.revisionDifferenceCents,
      currency: prepared.currency,
      purchasedCredits,
      bonusCredits,
      totalCredits: purchasedCredits + bonusCredits,
      effectiveAt: prepared.migration.effectiveAt.toISOString(),
      expiresAt: prepared.expiresAt.toISOString(),
      previewToken: createRevisionPreviewToken({
        version: 1,
        orgId: args.orgId,
        migrationId: args.migrationId,
        requestHash: prepared.requestHash,
        baseConfigurationHash: prepared.baseConfigurationHash,
        desiredConfigurationHash: prepared.desiredConfigurationHash,
        expiresAt: prepared.expiresAt.toISOString(),
      }),
    },
  };
}

type PersistMigrationRevisionResult =
  | { readonly status: "ready"; readonly migration: MigrationRow }
  | { readonly status: "not_found" }
  | { readonly status: "conflict" };

async function persistMigrationRevisionIntent(
  db: Db,
  args: {
    readonly orgId: string;
    readonly migrationId: string;
    readonly baseConfigurationHash: string;
    readonly desiredConfigurationHash: string;
    readonly prepared: PreparedMigrationRevision;
  },
): Promise<PersistMigrationRevisionResult> {
  return await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, args.orgId);
    const [migration] = await tx
      .select()
      .from(usagePackSubscriptionMigrations)
      .where(
        and(
          eq(usagePackSubscriptionMigrations.id, args.migrationId),
          eq(usagePackSubscriptionMigrations.orgId, args.orgId),
        ),
      )
      .for("update")
      .limit(1);
    if (!migration) {
      return { status: "not_found" as const };
    }
    const selections = await loadMigrationSelections(tx, migration.id);
    const currentConfigurationHash = storedMigrationConfigurationHash(
      migration,
      selections,
    );
    if (currentConfigurationHash === args.desiredConfigurationHash) {
      return migration.status === "revising" || migration.status === "scheduled"
        ? { status: "ready" as const, migration }
        : { status: "conflict" as const };
    }
    if (
      migration.status !== "scheduled" ||
      !migration.stripeScheduleId ||
      migration.effectiveAt <= nowDate() ||
      currentConfigurationHash !== args.baseConfigurationHash
    ) {
      return { status: "conflict" as const };
    }
    const updatedAt = nowDate();
    const [revising] = await tx
      .update(usagePackSubscriptionMigrations)
      .set({
        targetTier: args.prepared.targetTier,
        stripePlanPriceId: args.prepared.stripePlanPriceId,
        status: "revising",
        nextRecurringAmountCents: args.prepared.nextRecurringAmountCents,
        recurringDifferenceCents: args.prepared.recurringDifferenceCents,
        currency: args.prepared.currency,
        previewExpiresAt: args.prepared.expiresAt,
        stripeInvoiceId: null,
        stripePaymentIntentId: null,
        hostedInvoiceUrl: null,
        failureReason: null,
        completedAt: null,
        updatedAt,
      })
      .where(
        and(
          eq(usagePackSubscriptionMigrations.id, migration.id),
          eq(usagePackSubscriptionMigrations.status, "scheduled"),
        ),
      )
      .returning();
    if (!revising) {
      return { status: "conflict" as const };
    }
    await tx
      .delete(usagePackSubscriptionMigrationSelections)
      .where(
        eq(usagePackSubscriptionMigrationSelections.migrationId, migration.id),
      );
    if (args.prepared.desiredSelections.length > 0) {
      await tx.insert(usagePackSubscriptionMigrationSelections).values(
        args.prepared.desiredSelections.map((selection) => {
          return { migrationId: migration.id, ...selection };
        }),
      );
    }
    return { status: "ready" as const, migration: revising };
  });
}

export async function confirmUsagePackSubscriptionMigrationRevision(
  db: Db,
  args: {
    readonly orgId: string;
    readonly migrationId: string;
    readonly targetTier: SubscriptionCheckoutTier;
    readonly memberUsagePacks: readonly MemberUsagePack[];
    readonly owners: readonly UsagePackMigrationOwner[];
    readonly previewToken: string;
  },
  signal: AbortSignal,
): Promise<MigrationRevisionConfirmResult> {
  const token = parseRevisionPreviewToken(args.previewToken);
  const requestHash = revisionRequestHash(args);
  if (
    !token ||
    token.orgId !== args.orgId ||
    token.migrationId !== args.migrationId ||
    token.requestHash !== requestHash ||
    new Date(token.expiresAt) <= nowDate()
  ) {
    return { status: "invalid_preview" };
  }

  const stored = await loadMigrationForRevision(
    db,
    args.orgId,
    args.migrationId,
  );
  signal.throwIfAborted();
  if (!stored) {
    return { status: "not_found" };
  }
  const currentConfigurationHash = storedMigrationConfigurationHash(
    stored.migration,
    stored.selections,
  );
  if (currentConfigurationHash === token.desiredConfigurationHash) {
    if (stored.migration.status === "scheduled") {
      return {
        status: "confirmed",
        response: scheduledMigrationResponse(stored.migration),
      };
    }
    if (stored.migration.status !== "revising") {
      return { status: "conflict" };
    }
    const reconciled = await reconcileMigration(db, stored.migration, signal);
    return reconciled.status === "failed"
      ? { status: "conflict" }
      : { status: "confirmed", response: reconciled.response };
  }
  if (currentConfigurationHash !== token.baseConfigurationHash) {
    return { status: "conflict" };
  }

  const preparedResult = await prepareMigrationRevision(db, args, signal);
  if (preparedResult.status === "not_found") {
    return preparedResult;
  }
  if (preparedResult.status === "owners_changed") {
    return preparedResult;
  }
  if (preparedResult.status !== "ready") {
    return { status: "conflict" };
  }
  if (
    preparedResult.prepared.baseConfigurationHash !==
      token.baseConfigurationHash ||
    preparedResult.prepared.desiredConfigurationHash !==
      token.desiredConfigurationHash ||
    preparedResult.prepared.requestHash !== token.requestHash
  ) {
    return { status: "invalid_preview" };
  }
  const persisted = await persistMigrationRevisionIntent(db, {
    orgId: args.orgId,
    migrationId: args.migrationId,
    baseConfigurationHash: token.baseConfigurationHash,
    desiredConfigurationHash: token.desiredConfigurationHash,
    prepared: preparedResult.prepared,
  });
  signal.throwIfAborted();
  if (persisted.status !== "ready") {
    return persisted;
  }
  const reconciled = await reconcileMigration(db, persisted.migration, signal);
  return reconciled.status === "failed"
    ? { status: "conflict" }
    : { status: "confirmed", response: reconciled.response };
}

function packageQuantities(
  selections: readonly { readonly stripePriceId: string }[],
): ReadonlyMap<string, number> {
  const quantities = new Map<string, number>();
  for (const selection of selections) {
    quantities.set(
      selection.stripePriceId,
      (quantities.get(selection.stripePriceId) ?? 0) + 1,
    );
  }
  return quantities;
}

function desiredMigrationShape(
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
  subscription: StripeSubscription,
): boolean {
  const effectiveAt = Math.floor(migration.effectiveAt.getTime() / 1000);
  if (
    stripeObjectId(subscription.customer) !== migration.stripeCustomerId ||
    subscription.items.data.some((item) => {
      return item.id === migration.legacyStripeItemId;
    })
  ) {
    return false;
  }
  const planItems = subscription.items.data.filter((item) => {
    return tierForKnownPriceId(item.price.id) !== null;
  });
  if (
    planItems.length !== 1 ||
    planItems[0]?.price.id !== migration.stripePlanPriceId ||
    (planItems[0].quantity ?? 1) !== 1 ||
    planItems[0].current_period_start !== effectiveAt
  ) {
    return false;
  }
  const expected = packageQuantities(selections);
  const actual = new Map<string, number>();
  for (const item of subscription.items.data) {
    if (usagePackUsdForKnownPriceId(item.price.id) === null) {
      continue;
    }
    if (item.current_period_start !== effectiveAt) {
      return false;
    }
    const quantity = item.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return false;
    }
    actual.set(item.price.id, (actual.get(item.price.id) ?? 0) + quantity);
  }
  return (
    expected.size === actual.size &&
    [...expected].every(([priceId, quantity]) => {
      return actual.get(priceId) === quantity;
    })
  );
}

function legacyMigrationShape(
  migration: MigrationRow,
  subscription: StripeSubscription,
): boolean {
  const legacyItem = legacyPlanItem(subscription, migration.sourceTier);
  if (!legacyItem) {
    return false;
  }
  const period = migrationPeriod(legacyItem);
  const scheduleId = stripeObjectId(subscription.schedule);
  return (
    subscription.status === "active" &&
    subscription.cancel_at === null &&
    !subscription.cancel_at_period_end &&
    stripeObjectId(subscription.customer) === migration.stripeCustomerId &&
    legacyItem.id === migration.legacyStripeItemId &&
    legacyItem.price.id === migration.legacyStripePriceId &&
    migration.effectiveAt.getTime() === period.end * 1000 &&
    (!migration.stripeScheduleId ||
      scheduleId === migration.stripeScheduleId) &&
    !subscriptionHasUsagePackItems(subscription)
  );
}

interface PaidInvoicePaymentIntent {
  readonly id: string;
  readonly amountPaidCents: number;
}

function paidInvoicePaymentIntent(
  invoice: StripeInvoice,
): PaidInvoicePaymentIntent | null {
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
    throw new Error(`Migration invoice ${invoice.id} has an invalid payment`);
  }
  return { id, amountPaidCents: payment.amount_paid ?? 0 };
}

function invoicePaymentIntentId(invoice: StripeInvoice): string | null {
  return paidInvoicePaymentIntent(invoice)?.id ?? null;
}

async function retrieveMigrationInvoice(
  invoiceId: string,
): Promise<StripeInvoice> {
  return await getStripeClient().invoices.retrieve(invoiceId, {
    expand: ["payments.data.payment.payment_intent"],
  });
}

function latestInvoiceId(subscription: StripeSubscription): string | null {
  return stripeObjectId(subscription.latest_invoice);
}

async function persistMigrationInvoiceState(
  db: Db,
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
  subscription: StripeSubscription,
): Promise<MigrationRow> {
  const candidateInvoiceIds = new Set(
    [latestInvoiceId(subscription), migration.stripeInvoiceId].filter(
      (invoiceId): invoiceId is string => {
        return invoiceId !== null;
      },
    ),
  );
  let invoice: StripeInvoice | null = null;
  for (const invoiceId of candidateInvoiceIds) {
    const candidate = await retrieveMigrationInvoice(invoiceId);
    if (migrationInvoiceMatchesSelections(candidate, migration, selections)) {
      invoice = candidate;
      break;
    }
  }
  const updatedAt = nowDate();
  const [updated] = await db
    .update(usagePackSubscriptionMigrations)
    .set({
      status: "scheduled",
      stripeInvoiceId: invoice?.id ?? migration.stripeInvoiceId,
      stripePaymentIntentId:
        (invoice ? invoicePaymentIntentId(invoice) : null) ??
        migration.stripePaymentIntentId,
      hostedInvoiceUrl:
        invoice?.hosted_invoice_url ?? migration.hostedInvoiceUrl,
      updatedAt,
    })
    .where(
      and(
        eq(usagePackSubscriptionMigrations.id, migration.id),
        inArray(usagePackSubscriptionMigrations.status, [
          ...RECONCILING_MIGRATION_STATUSES,
        ]),
      ),
    )
    .returning();
  return updated ?? migration;
}

async function materializeUsagePackSnapshot(
  db: Db,
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
  subscription: StripeSubscription,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, migration.orgId);
    await writeUsagePackPendingSnapshots(
      tx,
      [migration.orgId],
      async (tx) => {
        const [locked] = await tx
          .select()
          .from(usagePackSubscriptionMigrations)
          .where(eq(usagePackSubscriptionMigrations.id, migration.id))
          .for("update")
          .limit(1);
        if (!locked || locked.status === "failed") {
          throw new Error(`Usage pack migration ${migration.id} is not active`);
        }
        const [existing] = await tx
          .select()
          .from(usagePackSubscriptions)
          .where(eq(usagePackSubscriptions.id, migration.id))
          .limit(1);
        if (!existing) {
          await tx.insert(usagePackSubscriptions).values({
            id: migration.id,
            orgId: migration.orgId,
            tier: migration.targetTier,
            stripePlanPriceId: migration.stripePlanPriceId,
            stripeCustomerId: migration.stripeCustomerId,
            stripeSubscriptionId: migration.stripeSubscriptionId,
            subscriptionStatus: subscription.status,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
          });
          if (selections.length > 0) {
            await tx.insert(usagePackAllocations).values(
              selections.map((selection) => {
                return {
                  usagePackSubscriptionId: migration.id,
                  orgId: migration.orgId,
                  userId: selection.userId,
                  invitationId: selection.invitationId,
                  usagePackUsd: selection.usagePackUsd,
                  stripePriceId: selection.stripePriceId,
                  status: "pending_payment" as const,
                };
              }),
            );
          }
          return;
        }
        if (
          existing.orgId !== migration.orgId ||
          existing.stripeCustomerId !== migration.stripeCustomerId ||
          existing.stripeSubscriptionId !== migration.stripeSubscriptionId ||
          existing.stripePlanPriceId !== migration.stripePlanPriceId
        ) {
          throw new Error(
            `Usage pack migration ${migration.id} snapshot changed`,
          );
        }
        const allocations = await tx
          .select({ id: usagePackAllocations.id })
          .from(usagePackAllocations)
          .where(
            eq(usagePackAllocations.usagePackSubscriptionId, migration.id),
          );
        if (allocations.length !== selections.length) {
          throw new Error(
            `Usage pack migration ${migration.id} allocations changed`,
          );
        }
      },
      [migration.id],
    );
  });
}

function invoiceLinePriceId(line: StripeInvoiceLine): string | null {
  const price = line.pricing?.price_details?.price;
  return typeof price === "string" ? price : (price?.id ?? null);
}

function invoiceLineAmount(line: StripeInvoiceLine): number | null {
  const amount = line.subtotal ?? line.amount;
  return Number.isSafeInteger(amount) ? amount : null;
}

function invoiceLineIsProration(line: StripeInvoiceLine): boolean {
  if (line.parent?.type === "subscription_item_details") {
    return (
      line.parent.subscription_item_details?.proration ??
      line.proration ??
      false
    );
  }
  if (line.parent?.type === "invoice_item_details") {
    return (
      line.parent.invoice_item_details?.proration ?? line.proration ?? false
    );
  }
  return line.proration ?? false;
}

function migrationInvoiceLineMatchesPeriod(
  line: StripeInvoiceLine,
  migration: MigrationRow,
): boolean {
  const effectiveAt = Math.floor(migration.effectiveAt.getTime() / 1000);
  return (
    !invoiceLineIsProration(line) &&
    line.period.start === effectiveAt &&
    line.period.end > effectiveAt
  );
}

function migrationInvoiceMatchesSelections(
  invoice: StripeInvoice,
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
): boolean {
  if (
    stripeObjectId(invoice.customer) !== migration.stripeCustomerId ||
    stripeObjectId(invoice.parent?.subscription_details?.subscription) !==
      migration.stripeSubscriptionId ||
    invoice.currency !== migration.currency
  ) {
    return false;
  }
  const expected = packageQuantities(selections);
  const actual = new Map<string, number>();
  let targetPlanQuantity = 0;
  for (const line of invoice.lines.data) {
    const priceId = invoiceLinePriceId(line);
    if (!priceId) {
      continue;
    }
    const quantity = line.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return false;
    }
    if (priceId === migration.stripePlanPriceId) {
      if (!migrationInvoiceLineMatchesPeriod(line, migration)) {
        return false;
      }
      targetPlanQuantity += quantity;
      continue;
    }
    if (usagePackUsdForKnownPriceId(priceId) === null) {
      continue;
    }
    if (!migrationInvoiceLineMatchesPeriod(line, migration)) {
      return false;
    }
    actual.set(priceId, (actual.get(priceId) ?? 0) + quantity);
  }
  return (
    targetPlanQuantity === 1 &&
    expected.size === actual.size &&
    [...expected].every(([priceId, quantity]) => {
      return actual.get(priceId) === quantity;
    })
  );
}

interface SelectionCredits {
  readonly purchasedCredits: number;
  readonly bonusCredits: number;
  readonly weight: number;
}

function selectionCreditsForInvoice(
  invoice: StripeInvoice,
  selections: readonly MigrationSelectionRow[],
): ReadonlyMap<string, SelectionCredits> {
  const quantities = packageQuantities(selections);
  const credits = new Map<string, SelectionCredits>();
  for (const [priceId, quantity] of quantities) {
    const matching = invoice.lines.data.filter((line) => {
      const amount = invoiceLineAmount(line);
      return (
        invoiceLinePriceId(line) === priceId && amount !== null && amount > 0
      );
    });
    if (matching.length !== 1) {
      throw new Error(
        `Migration invoice ${invoice.id} must have one positive line for ${priceId}`,
      );
    }
    const line = matching[0];
    const amount = line ? invoiceLineAmount(line) : null;
    if (!line || amount === null) {
      throw new Error(`Migration invoice ${invoice.id} has an invalid line`);
    }
    const lineQuantity = line.quantity ?? 1;
    if (lineQuantity !== quantity) {
      throw new Error(
        `Migration invoice ${invoice.id} quantity for ${priceId} changed`,
      );
    }
    const selected = selections.filter((selection) => {
      return selection.stripePriceId === priceId;
    });
    for (const selection of selected) {
      const fullAmount = selection.unitAmountCents * quantity;
      if (amount > fullAmount) {
        throw new Error(
          `Migration invoice ${invoice.id} amount for ${priceId} is invalid`,
        );
      }
      const fraction = amount / fullAmount;
      credits.set(selection.id, {
        purchasedCredits: Math.floor(selection.purchasedCredits * fraction),
        bonusCredits: Math.floor(selection.bonusCredits * fraction),
        weight: amount / quantity,
      });
    }
  }
  return credits;
}

function paidAmountsBySelection(
  invoiceAmountDueCents: number,
  amountPaidCents: number,
  selections: readonly MigrationSelectionRow[],
  credits: ReadonlyMap<string, SelectionCredits>,
): ReadonlyMap<string, number> {
  if (
    !Number.isSafeInteger(invoiceAmountDueCents) ||
    invoiceAmountDueCents < 0 ||
    !Number.isSafeInteger(amountPaidCents) ||
    amountPaidCents < 0
  ) {
    throw new Error("Migration invoice has an invalid paid amount");
  }
  if (selections.length === 0) {
    return new Map();
  }
  const totalWeight = selections.reduce((total, selection) => {
    return total + (credits.get(selection.id)?.weight ?? 0);
  }, 0);
  if (!(totalWeight > 0)) {
    throw new Error("Migration invoice has no package payment weight");
  }
  const refundableAmount =
    invoiceAmountDueCents === 0
      ? 0
      : Math.floor(
          (Math.min(amountPaidCents, invoiceAmountDueCents) *
            Math.min(totalWeight, invoiceAmountDueCents)) /
            invoiceAmountDueCents,
        );
  const ordered = [...selections].sort((left, right) => {
    return left.id.localeCompare(right.id);
  });
  const result = new Map<string, number>();
  let allocated = 0;
  for (const selection of ordered) {
    const weight = credits.get(selection.id)?.weight ?? 0;
    const amount = Math.floor((refundableAmount * weight) / totalWeight);
    result.set(selection.id, amount);
    allocated += amount;
  }
  let remainder = refundableAmount - allocated;
  for (const selection of ordered) {
    if (remainder === 0) {
      break;
    }
    result.set(selection.id, (result.get(selection.id) ?? 0) + 1);
    remainder -= 1;
  }
  return result;
}

function invoicePaidAt(invoice: StripeInvoice): Date {
  const paidAt = invoice.status_transitions?.paid_at;
  return typeof paidAt === "number" ? new Date(paidAt * 1000) : nowDate();
}

async function completeMigrationInvitations(
  db: Db,
  migration: MigrationRow,
  invoice: StripeInvoice,
): Promise<void> {
  const selections = await loadMigrationSelections(db, migration.id);
  const credits = selectionCreditsForInvoice(invoice, selections);
  const payment = paidInvoicePaymentIntent(invoice);
  const paymentIntentId = payment?.id ?? migration.stripePaymentIntentId;
  const paidAmounts = paidAmountsBySelection(
    safeInvoiceAmount(invoice, "paid"),
    payment?.amountPaidCents ?? 0,
    selections,
    credits,
  );
  await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, migration.orgId);
    const [locked] = await tx
      .select()
      .from(usagePackSubscriptionMigrations)
      .where(eq(usagePackSubscriptionMigrations.id, migration.id))
      .for("update")
      .limit(1);
    if (!locked || locked.status === "failed") {
      throw new Error(`Usage pack migration ${migration.id} cannot complete`);
    }
    if (locked.status === "completed") {
      return;
    }
    const allocations = await tx
      .select()
      .from(usagePackAllocations)
      .where(eq(usagePackAllocations.usagePackSubscriptionId, migration.id));
    if (allocations.length !== selections.length) {
      throw new Error(
        `Usage pack migration ${migration.id} allocations changed`,
      );
    }
    for (const selection of selections) {
      if (!selection.invitationId) {
        continue;
      }
      const allocation = allocations.find((candidate) => {
        return candidate.invitationId === selection.invitationId;
      });
      const selectionCredit = credits.get(selection.id);
      if (
        !allocation ||
        !allocation.currentPeriodStart ||
        !allocation.currentPeriodEnd ||
        !selectionCredit ||
        !selection.normalizedEmail ||
        !selection.role ||
        !selection.inviterUserId
      ) {
        throw new Error(
          `Usage pack migration invitation ${selection.invitationId} is incomplete`,
        );
      }
      const amountPaidCents = paidAmounts.get(selection.id) ?? 0;
      await tx.insert(usagePackInvitationPurchases).values({
        usagePackSubscriptionId: migration.id,
        allocationId: allocation.id,
        orgId: migration.orgId,
        publicBrand: PUBLIC_BRAND,
        normalizedEmail: selection.normalizedEmail,
        role: selection.role,
        inviterUserId: selection.inviterUserId,
        usagePackUsd: selection.usagePackUsd,
        stripePriceId: selection.stripePriceId,
        status: "invitation_pending",
        currentPeriodStart: allocation.currentPeriodStart,
        currentPeriodEnd: allocation.currentPeriodEnd,
        prorationTimestamp: Math.floor(migration.effectiveAt.getTime() / 1000),
        unitAmountCents: selection.unitAmountCents,
        expectedAmountCents: amountPaidCents,
        amountPaidCents,
        currency: migration.currency,
        purchasedCredits: selectionCredit.purchasedCredits,
        bonusCredits: selectionCredit.bonusCredits,
        stripePaymentIntentId: amountPaidCents > 0 ? paymentIntentId : null,
        clerkInvitationId: selection.invitationId,
        paidAt: invoicePaidAt(invoice),
      });
    }
    const completedAt = nowDate();
    await tx
      .update(usagePackSubscriptionMigrations)
      .set({
        status: "completed",
        stripeInvoiceId: invoice.id,
        stripePaymentIntentId: paymentIntentId,
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(usagePackSubscriptionMigrations.id, migration.id));
  });
}

function correlatedMigrationInvoice(
  invoice: StripeInvoice,
  migration: MigrationRow,
): UsagePackInvoiceInput {
  const subscriptionDetails = invoice.parent?.subscription_details;
  if (!subscriptionDetails) {
    throw new Error(`Migration invoice ${invoice.id} has no subscription`);
  }
  const metadata = usagePackSubscriptionMetadata({
    orgId: migration.orgId,
    tier: migration.targetTier,
    planPriceId: migration.stripePlanPriceId,
    usagePackSubscriptionId: migration.id,
  });
  return {
    ...invoice,
    metadata: { ...invoice.metadata, ...metadata },
    parent: {
      subscription_details: {
        ...subscriptionDetails,
        metadata: {
          ...subscriptionDetails.metadata,
          ...metadata,
        },
      },
    },
  } as UsagePackInvoiceInput;
}

async function finalizeAppliedMigration(
  db: Db,
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
  subscription: StripeSubscription,
  invoice: StripeInvoice,
): Promise<AppliedMigrationResult> {
  if (invoice.status !== "paid") {
    return {
      status: "active",
      orgId: migration.orgId,
      response: {
        status: "scheduled",
        effectiveAt: migration.effectiveAt.toISOString(),
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      },
    };
  }
  await materializeUsagePackSnapshot(db, migration, selections, subscription);
  const metadata = usagePackSubscriptionMetadata({
    orgId: migration.orgId,
    tier: migration.targetTier,
    planPriceId: migration.stripePlanPriceId,
    usagePackSubscriptionId: migration.id,
  });
  const tagged = await getStripeClient().subscriptions.update(
    migration.stripeSubscriptionId,
    { metadata },
    { idempotencyKey: `usage-pack-migration:${migration.id}:metadata` },
  );
  const subscriptionOutcome = await handleUsagePackSubscriptionUpdated(
    db,
    tagged as UsagePackSubscriptionInput,
  );
  if (!subscriptionOutcome.handled) {
    throw new Error(`Usage pack migration ${migration.id} lost correlation`);
  }
  const invoiceOutcome = await handleUsagePackInvoicePaid(
    db,
    correlatedMigrationInvoice(invoice, migration),
  );
  if (!invoiceOutcome.handled) {
    throw new Error(
      `Usage pack migration invoice ${invoice.id} was not handled`,
    );
  }
  await completeMigrationInvitations(db, migration, invoice);
  L.debug("usage pack subscription migration completed", {
    migrationId: migration.id,
    orgId: migration.orgId,
    stripeSubscriptionId: migration.stripeSubscriptionId,
    invoiceId: invoice.id,
  });
  return {
    status: "active",
    orgId: migration.orgId,
    response: {
      status: "completed",
      effectiveAt: migration.effectiveAt.toISOString(),
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    },
  };
}

async function failChangedMigration(
  db: Db,
  migration: MigrationRow,
): Promise<boolean> {
  const completedAt = nowDate();
  const [failed] = await db
    .update(usagePackSubscriptionMigrations)
    .set({
      status: "failed",
      failureReason: "subscription_changed",
      completedAt,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(usagePackSubscriptionMigrations.id, migration.id),
        inArray(usagePackSubscriptionMigrations.status, [
          ...RECONCILING_MIGRATION_STATUSES,
        ]),
      ),
    )
    .returning({ id: usagePackSubscriptionMigrations.id });
  return failed !== undefined;
}

function migrationRecurringDuration(
  legacyItem: StripeSubscriptionItem,
): StripePriceRecurring {
  const recurring = legacyItem.price.recurring;
  if (!recurring) {
    throw new Error("Legacy subscription plan is not recurring");
  }
  return {
    interval: recurring.interval,
    interval_count: recurring.interval_count,
  };
}

function migrationPhaseItems(
  subscription: StripeSubscription,
): StripeSchedulePhaseItemParam[] {
  return subscription.items.data.map((item) => {
    return { price: item.price.id, quantity: item.quantity ?? 1 };
  });
}

function migrationPhaseDiscounts(
  subscription: StripeSubscription,
): StripeSchedulePhaseDiscountParam[] {
  return (subscription.discounts ?? []).flatMap((discount) => {
    const id = stripeObjectId(discount);
    return id ? [{ discount: id }] : [];
  });
}

function migrationPhaseWithDiscounts(
  phase: StripeSchedulePhaseParam,
  discounts: readonly StripeSchedulePhaseDiscountParam[],
): StripeSchedulePhaseParam {
  return discounts.length === 0
    ? phase
    : { ...phase, discounts: [...discounts] };
}

function targetMigrationConfigurationItems(
  subscription: StripeSubscription,
  stripePlanPriceId: string,
  selections: readonly { readonly stripePriceId: string }[],
): StripeSchedulePhaseItemParam[] {
  const unrelated = subscription.items.data
    .filter((item) => {
      return (
        tierForKnownPriceId(item.price.id) === null &&
        usagePackUsdForKnownPriceId(item.price.id) === null
      );
    })
    .map((item) => {
      return { price: item.price.id, quantity: item.quantity ?? 1 };
    });
  return [
    ...unrelated,
    { price: stripePlanPriceId, quantity: 1 },
    ...[...packageQuantities(selections)].map(([price, quantity]) => {
      return { price, quantity };
    }),
  ];
}

function migrationScheduleConfiguration(
  migration: MigrationRow,
  stripePlanPriceId: string,
  selections: readonly { readonly stripePriceId: string }[],
  subscription: StripeSubscription,
  legacyItem: StripeSubscriptionItem,
): MigrationScheduleConfiguration {
  const period = migrationPeriod(legacyItem);
  const discounts = migrationPhaseDiscounts(subscription);
  return {
    end_behavior: "release",
    proration_behavior: "none",
    phases: [
      migrationPhaseWithDiscounts(
        {
          start_date: period.start,
          end_date: period.end,
          items: migrationPhaseItems(subscription),
          proration_behavior: "none",
        },
        discounts,
      ),
      migrationPhaseWithDiscounts(
        {
          start_date: period.end,
          duration: migrationRecurringDuration(legacyItem),
          items: targetMigrationConfigurationItems(
            subscription,
            stripePlanPriceId,
            selections,
          ),
          proration_behavior: "none",
        },
        discounts,
      ),
    ],
  };
}

function scheduledMigrationResponse(
  migration: MigrationRow,
): UsagePackMigrationConfirmResponse {
  return {
    status: "scheduled",
    effectiveAt: migration.effectiveAt.toISOString(),
    hostedInvoiceUrl: migration.hostedInvoiceUrl,
  };
}

async function scheduleMigration(
  db: Db,
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
  subscription: StripeSubscription,
  signal: AbortSignal | undefined,
): Promise<MigrationRow> {
  if (!legacyMigrationShape(migration, subscription)) {
    throw new Error(`Legacy subscription ${subscription.id} changed`);
  }
  const legacyItem = legacyPlanItem(subscription, migration.sourceTier);
  if (!legacyItem) {
    throw new Error(`Legacy subscription ${subscription.id} lost its plan`);
  }
  const stripe = getStripeClient();
  const createdSchedule = migration.stripeScheduleId
    ? null
    : await stripe.subscriptionSchedules.create(
        { from_subscription: migration.stripeSubscriptionId },
        {
          idempotencyKey: `usage-pack-migration:${migration.id}:schedule-create`,
        },
      );
  signal?.throwIfAborted();
  const scheduleId = migration.stripeScheduleId ?? createdSchedule?.id;
  if (!scheduleId) {
    throw new Error("Stripe did not return a migration schedule ID");
  }
  const attachedScheduleId = stripeObjectId(subscription.schedule);
  if (attachedScheduleId && attachedScheduleId !== scheduleId) {
    throw new Error(`Legacy subscription ${subscription.id} schedule changed`);
  }
  const scheduleConfiguration = migrationScheduleConfiguration(
    migration,
    migration.stripePlanPriceId,
    selections,
    subscription,
    legacyItem,
  );
  await stripe.subscriptionSchedules.update(scheduleId, scheduleConfiguration, {
    idempotencyKey:
      migration.status === "revising"
        ? `usage-pack-migration:${migration.id}:schedule-revision:${migrationScheduleRevisionHash(migration, selections)}`
        : `usage-pack-migration:${migration.id}:schedule-update`,
  });
  signal?.throwIfAborted();
  const updatedAt = nowDate();
  const [scheduled] = await db
    .update(usagePackSubscriptionMigrations)
    .set({ status: "scheduled", stripeScheduleId: scheduleId, updatedAt })
    .where(
      and(
        eq(usagePackSubscriptionMigrations.id, migration.id),
        inArray(usagePackSubscriptionMigrations.status, [
          "applying",
          "revising",
        ]),
      ),
    )
    .returning();
  const persisted = scheduled ?? migration;
  L.debug("usage pack subscription migration scheduled", {
    migrationId: migration.id,
    orgId: migration.orgId,
    stripeScheduleId: scheduleId,
    effectiveAt: migration.effectiveAt.toISOString(),
  });
  return {
    ...persisted,
    status: "scheduled",
    stripeScheduleId: scheduleId,
  };
}

async function reconcileMigration(
  db: Db,
  migration: MigrationRow,
  signal?: AbortSignal,
  eventInvoice?: StripeInvoice,
): Promise<AppliedMigrationResult> {
  const selections = await loadMigrationSelections(db, migration.id);
  const subscription = await getStripeClient().subscriptions.retrieve(
    migration.stripeSubscriptionId,
  );
  signal?.throwIfAborted();
  if (subscription.id !== migration.stripeSubscriptionId) {
    throw new Error(
      `Stripe returned subscription ${subscription.id} for migration subscription ${migration.stripeSubscriptionId}`,
    );
  }
  if (desiredMigrationShape(migration, selections, subscription)) {
    const persisted = await persistMigrationInvoiceState(
      db,
      migration,
      selections,
      subscription,
    );
    const invoiceId = eventInvoice?.id ?? persisted.stripeInvoiceId;
    const invoice = invoiceId
      ? await retrieveMigrationInvoice(invoiceId)
      : null;
    signal?.throwIfAborted();
    if (
      invoice &&
      migrationInvoiceMatchesSelections(invoice, persisted, selections)
    ) {
      return await finalizeAppliedMigration(
        db,
        persisted,
        selections,
        subscription,
        invoice,
      );
    }
    return {
      status: "active",
      orgId: migration.orgId,
      response: scheduledMigrationResponse(persisted),
    };
  }
  if (!legacyMigrationShape(migration, subscription)) {
    if (await failChangedMigration(db, migration)) {
      return { status: "failed", orgId: migration.orgId };
    }
    return { status: "failed", orgId: migration.orgId };
  }
  if (migration.status === "applying" || migration.status === "revising") {
    const scheduled = await scheduleMigration(
      db,
      migration,
      selections,
      subscription,
      signal,
    );
    return {
      status: "active",
      orgId: migration.orgId,
      response: scheduledMigrationResponse(scheduled),
    };
  }
  return {
    status: "active",
    orgId: migration.orgId,
    response: scheduledMigrationResponse(migration),
  };
}

async function claimMigrationConfirmation(
  db: Db,
  args: {
    readonly orgId: string;
    readonly migrationId: string;
    readonly ownerIds: readonly string[];
  },
): Promise<
  | { readonly status: "ready"; readonly migration: MigrationRow }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "owners_changed" }
  | { readonly status: "conflict" }
> {
  return await db.transaction(async (tx) => {
    await lockUsagePackBillingOrg(tx, args.orgId);
    const [migration] = await tx
      .select()
      .from(usagePackSubscriptionMigrations)
      .where(
        and(
          eq(usagePackSubscriptionMigrations.id, args.migrationId),
          eq(usagePackSubscriptionMigrations.orgId, args.orgId),
        ),
      )
      .for("update")
      .limit(1);
    if (!migration) {
      return { status: "not_found" as const };
    }
    if (migration.status === "completed" || migration.status === "failed") {
      return { status: "conflict" as const };
    }
    if (migration.status === "previewed") {
      const selections = await loadMigrationSelections(tx, migration.id);
      if (!paidOwnersStillPresent(selections, args.ownerIds)) {
        const completedAt = nowDate();
        await tx
          .update(usagePackSubscriptionMigrations)
          .set({
            status: "failed",
            failureReason: "owners_changed",
            completedAt,
            updatedAt: completedAt,
          })
          .where(eq(usagePackSubscriptionMigrations.id, migration.id));
        return { status: "owners_changed" as const };
      }
      if (migration.previewExpiresAt <= nowDate()) {
        const completedAt = nowDate();
        await tx
          .update(usagePackSubscriptionMigrations)
          .set({
            status: "failed",
            failureReason: "preview_expired",
            completedAt,
            updatedAt: completedAt,
          })
          .where(eq(usagePackSubscriptionMigrations.id, migration.id));
        return { status: "expired" as const };
      }
      const [claimed] = await tx
        .update(usagePackSubscriptionMigrations)
        .set({ status: "applying", updatedAt: nowDate() })
        .where(
          and(
            eq(usagePackSubscriptionMigrations.id, migration.id),
            eq(usagePackSubscriptionMigrations.status, "previewed"),
          ),
        )
        .returning();
      if (!claimed) {
        return { status: "conflict" as const };
      }
      return { status: "ready" as const, migration: claimed };
    }
    return { status: "ready" as const, migration };
  });
}

export async function confirmUsagePackSubscriptionMigration(
  db: Db,
  args: {
    readonly orgId: string;
    readonly migrationId: string;
    readonly ownerIds: readonly string[];
  },
  signal: AbortSignal,
): Promise<MigrationConfirmResult> {
  const claimed = await claimMigrationConfirmation(db, args);
  if (claimed.status !== "ready") {
    return claimed;
  }
  signal.throwIfAborted();
  const result = await reconcileMigration(db, claimed.migration, signal);
  if (result.status === "failed") {
    return { status: "conflict" };
  }
  return { status: "confirmed", response: result.response };
}

async function migrationForInvoice(
  db: Pick<Db, "select">,
  invoice: Pick<UsagePackInvoiceInput, "id" | "parent">,
): Promise<MigrationRow | null> {
  const subscriptionId = stripeObjectId(
    invoice.parent?.subscription_details?.subscription,
  );
  const [migration] = await db
    .select()
    .from(usagePackSubscriptionMigrations)
    .where(
      or(
        eq(usagePackSubscriptionMigrations.stripeInvoiceId, invoice.id),
        subscriptionId
          ? and(
              eq(
                usagePackSubscriptionMigrations.stripeSubscriptionId,
                subscriptionId,
              ),
              inArray(usagePackSubscriptionMigrations.status, [
                ...RECONCILING_MIGRATION_STATUSES,
              ]),
            )
          : sql`false`,
      ),
    )
    .orderBy(desc(usagePackSubscriptionMigrations.createdAt))
    .limit(1);
  return migration ?? null;
}

export async function handleUsagePackMigrationInvoicePaid(
  db: Db,
  invoice: UsagePackInvoiceInput,
): Promise<UsagePackMigrationLifecycleOutcome> {
  const migration = await migrationForInvoice(db, invoice);
  if (!migration) {
    return { handled: false, orgId: null };
  }
  const currentInvoice = await retrieveMigrationInvoice(invoice.id);
  if (migration.stripeInvoiceId !== currentInvoice.id) {
    const selections = await loadMigrationSelections(db, migration.id);
    if (
      !migrationInvoiceMatchesSelections(currentInvoice, migration, selections)
    ) {
      return { handled: false, orgId: null };
    }
  }
  if (migration.status === "completed") {
    const outcome = await handleUsagePackInvoicePaid(
      db,
      correlatedMigrationInvoice(currentInvoice, migration),
    );
    return { handled: outcome.handled, orgId: migration.orgId };
  }
  const [updated] = await db
    .update(usagePackSubscriptionMigrations)
    .set({
      stripeInvoiceId: currentInvoice.id,
      stripePaymentIntentId:
        invoicePaymentIntentId(currentInvoice) ??
        migration.stripePaymentIntentId,
      hostedInvoiceUrl: currentInvoice.hosted_invoice_url,
      updatedAt: nowDate(),
    })
    .where(eq(usagePackSubscriptionMigrations.id, migration.id))
    .returning();
  const result = await reconcileMigration(
    db,
    updated ?? migration,
    undefined,
    currentInvoice,
  );
  return { handled: true, orgId: result.orgId };
}

export async function handleUsagePackMigrationSubscriptionUpdated(
  db: Db,
  subscription: UsagePackSubscriptionInput,
): Promise<UsagePackMigrationLifecycleOutcome> {
  const usagePackSubscriptionId = usagePackSubscriptionIdFromMetadata(
    subscription.metadata,
  );
  const [migration] = await db
    .select()
    .from(usagePackSubscriptionMigrations)
    .where(
      and(
        eq(
          usagePackSubscriptionMigrations.stripeSubscriptionId,
          subscription.id,
        ),
        inArray(usagePackSubscriptionMigrations.status, [
          ...RECONCILING_MIGRATION_STATUSES,
          ...(usagePackSubscriptionId ? [] : (["completed"] as const)),
        ]),
      ),
    )
    .orderBy(desc(usagePackSubscriptionMigrations.createdAt))
    .limit(1);
  if (!migration) {
    return { handled: false, orgId: null };
  }
  if (migration.status === "completed") {
    const current = await getStripeClient().subscriptions.retrieve(
      migration.stripeSubscriptionId,
    );
    const outcome = await handleUsagePackSubscriptionUpdated(
      db,
      current as UsagePackSubscriptionInput,
    );
    if (!outcome.handled) {
      throw new Error(
        `Completed usage pack migration ${migration.id} lost correlation`,
      );
    }
    return { handled: true, orgId: migration.orgId };
  }
  const result = await reconcileMigration(db, migration);
  return { handled: result.status !== "failed", orgId: result.orgId };
}

export async function reconcileUsagePackSubscriptionMigrations(
  db: Db,
  scope: BillingReconciliationScope | undefined,
  signal: AbortSignal,
): Promise<{
  readonly reconciled: number;
  readonly orgIds: readonly string[];
}> {
  const at = nowDate();
  await db
    .update(usagePackSubscriptionMigrations)
    .set({
      status: "failed",
      failureReason: "preview_expired",
      completedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        scope
          ? inArray(usagePackSubscriptionMigrations.orgId, [...scope.orgIds])
          : undefined,
        eq(usagePackSubscriptionMigrations.status, "previewed"),
        lte(usagePackSubscriptionMigrations.previewExpiresAt, at),
      ),
    );
  signal.throwIfAborted();
  const staleBefore = new Date(at.getTime() - RECONCILIATION_DELAY_MS);
  const candidates = await db
    .select()
    .from(usagePackSubscriptionMigrations)
    .where(
      and(
        scope
          ? inArray(usagePackSubscriptionMigrations.orgId, [...scope.orgIds])
          : undefined,
        or(
          and(
            inArray(usagePackSubscriptionMigrations.status, [
              "applying",
              "revising",
            ]),
            lte(usagePackSubscriptionMigrations.updatedAt, staleBefore),
          ),
          and(
            eq(usagePackSubscriptionMigrations.status, "scheduled"),
            lte(usagePackSubscriptionMigrations.effectiveAt, at),
          ),
        ),
      ),
    )
    .limit(100);
  signal.throwIfAborted();
  const orgIds = new Set<string>();
  let reconciled = 0;
  for (const candidate of candidates) {
    const result = await settle(
      reconcileMigration(db, candidate, signal),
      signal,
    );
    if (!result.ok) {
      L.warn("usage pack subscription migration reconciliation failed", {
        migrationId: candidate.id,
        orgId: candidate.orgId,
        error: result.error,
      });
      continue;
    }
    orgIds.add(result.value.orgId);
    reconciled += 1;
  }
  return { reconciled, orgIds: [...orgIds] };
}
