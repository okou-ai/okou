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
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  usagePackAllocations,
  usagePackInvitationPurchases,
  usagePackSubscriptionMigrations,
  usagePackSubscriptionMigrationSelections,
  usagePackSubscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { iso, literal, object, string, uuid, type infer as zInfer } from "zod";

import { QueryBuilder } from "drizzle-orm/pg-core";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { command } from "ccstate";
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
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import {
  contextJsonProjection,
  contextJsonRows,
  contextProjectionSchema,
} from "./context-rowset";
import {
  handleUsagePackInvoicePaid$,
  handleUsagePackSubscriptionUpdated$,
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

const revisionPreviewTokenPayloadSchema = object({
  version: literal(1),
  orgId: string().min(1),
  migrationId: uuid(),
  requestHash: string().length(64),
  baseConfigurationHash: string().length(64),
  desiredConfigurationHash: string().length(64),
  expiresAt: iso.datetime(),
});

type RevisionPreviewTokenPayload = zInfer<
  typeof revisionPreviewTokenPayloadSchema
>;

type MigrationRow = typeof usagePackSubscriptionMigrations.$inferSelect;

/** The migration row plus its tuple version for exact-row CAS updates. */
function migrationColumnsWithRowVersion() {
  return {
    ...getTableColumns(usagePackSubscriptionMigrations),
    rowVersion: sql`${usagePackSubscriptionMigrations}.xmin::text`.mapWith(
      pgTextDecoder,
    ),
  };
}

function migrationRowVersionIs(rowVersion: string) {
  return sql`${usagePackSubscriptionMigrations}.xmin::text = ${rowVersion}`;
}
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

function assertMigrationConfiguration(
  expected: string,
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
): void {
  if (migrationScheduleRevisionHash(migration, selections) !== expected) {
    throw new Error(
      `Usage pack migration ${migration.id} configuration changed`,
    );
  }
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

const loadLegacyMigrationContext$ = command(
  async (
    { set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<LegacyMigrationContext | null> => {
    const db = set(writeDb$);

    const [row] = await db
      .select({
        orgId: orgMetadata.orgId,
        tier: orgMetadata.tier,
        stripeCustomerId: orgMetadata.stripeCustomerId,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        subscriptionStatus: orgMetadata.subscriptionStatus,
        cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
        pendingSubscriptionScheduleId:
          orgMetadata.pendingSubscriptionScheduleId,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    signal.throwIfAborted();
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
    signal.throwIfAborted();
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
  },
);

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

export const getUsagePackMigrationState$ = command(
  async (
    { set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<MigrationStateResult> => {
    const db = set(writeDb$);
    const at = nowDate();
    const openMigrationQuery = db
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
      .limit(1);
    let [open] = await openMigrationQuery;
    signal.throwIfAborted();
    if (open?.status === "previewed" && open.previewExpiresAt <= at) {
      // Conditional expiry instead of a row lock. Zero rows means a
      // concurrent confirmation or preview moved it; read the current row.
      const [expired] = await db
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
            lte(usagePackSubscriptionMigrations.previewExpiresAt, at),
          ),
        )
        .returning({ id: usagePackSubscriptionMigrations.id });
      signal.throwIfAborted();
      if (expired) {
        open = undefined;
      } else {
        [open] = await openMigrationQuery;
        signal.throwIfAborted();
        if (open?.status === "previewed" && open.previewExpiresAt <= at) {
          open = undefined;
        }
      }
    }
    if (open) {
      const selections = await db
        .select()
        .from(usagePackSubscriptionMigrationSelections)
        .where(
          eq(usagePackSubscriptionMigrationSelections.migrationId, open.id),
        );
      signal.throwIfAborted();
      return {
        status: "ready",
        state: migrationState(open, selections),
      };
    }
    const context = await set(loadLegacyMigrationContext$, orgId, signal);
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
  },
);

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

interface PersistMigrationPreviewArgs {
  readonly targetTier: SubscriptionCheckoutTier;
  readonly stripePlanPriceId: string;
  readonly currentRecurringAmountCents: number;
  readonly nextRecurringAmountCents: number;
  readonly recurringDifferenceCents: number;
  readonly currency: string;
  readonly effectiveAt: Date;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

// INSERT SELECT requires the complete schema projection, including the native
// UUID and preview status defaults and the nullable lifecycle fields.
function migrationPreviewInsertSource(
  context: LegacyMigrationContext,
  args: PersistMigrationPreviewArgs,
) {
  const columns = getTableColumns(usagePackSubscriptionMigrations);
  return {
    id: sql`gen_random_uuid()`
      .mapWith(usagePackSubscriptionMigrations.id)
      .as("id"),
    orgId: sql`${sql.param(context.org.orgId, columns.orgId)}`
      .mapWith(usagePackSubscriptionMigrations.orgId)
      .as("org_id"),
    sourceTier: sql`${sql.param(context.org.tier, columns.sourceTier)}`
      .mapWith(usagePackSubscriptionMigrations.sourceTier)
      .as("source_tier"),
    targetTier: sql`${sql.param(args.targetTier, columns.targetTier)}`
      .mapWith(usagePackSubscriptionMigrations.targetTier)
      .as("target_tier"),
    stripeCustomerId:
      sql`${sql.param(context.org.stripeCustomerId, columns.stripeCustomerId)}`
        .mapWith(usagePackSubscriptionMigrations.stripeCustomerId)
        .as("stripe_customer_id"),
    stripeSubscriptionId:
      sql`${sql.param(context.org.stripeSubscriptionId, columns.stripeSubscriptionId)}`
        .mapWith(usagePackSubscriptionMigrations.stripeSubscriptionId)
        .as("stripe_subscription_id"),
    legacyStripePriceId:
      sql`${sql.param(context.legacyItem.price.id, columns.legacyStripePriceId)}`
        .mapWith(usagePackSubscriptionMigrations.legacyStripePriceId)
        .as("legacy_stripe_price_id"),
    legacyStripeItemId:
      sql`${sql.param(context.legacyItem.id, columns.legacyStripeItemId)}`
        .mapWith(usagePackSubscriptionMigrations.legacyStripeItemId)
        .as("legacy_stripe_item_id"),
    stripePlanPriceId:
      sql`${sql.param(args.stripePlanPriceId, columns.stripePlanPriceId)}`
        .mapWith(usagePackSubscriptionMigrations.stripePlanPriceId)
        .as("stripe_plan_price_id"),
    status: sql`'previewed'`
      .mapWith(usagePackSubscriptionMigrations.status)
      .as("status"),
    currentRecurringAmountCents:
      sql`${sql.param(args.currentRecurringAmountCents, columns.currentRecurringAmountCents)}`
        .mapWith(usagePackSubscriptionMigrations.currentRecurringAmountCents)
        .as("current_recurring_amount_cents"),
    nextRecurringAmountCents:
      sql`${sql.param(args.nextRecurringAmountCents, columns.nextRecurringAmountCents)}`
        .mapWith(usagePackSubscriptionMigrations.nextRecurringAmountCents)
        .as("next_recurring_amount_cents"),
    recurringDifferenceCents:
      sql`${sql.param(args.recurringDifferenceCents, columns.recurringDifferenceCents)}`
        .mapWith(usagePackSubscriptionMigrations.recurringDifferenceCents)
        .as("recurring_difference_cents"),
    currency: sql`${sql.param(args.currency, columns.currency)}`
      .mapWith(usagePackSubscriptionMigrations.currency)
      .as("currency"),
    effectiveAt: sql`${sql.param(args.effectiveAt, columns.effectiveAt)}`
      .mapWith(usagePackSubscriptionMigrations.effectiveAt)
      .as("effective_at"),
    previewExpiresAt:
      sql`${sql.param(args.expiresAt, columns.previewExpiresAt)}`
        .mapWith(usagePackSubscriptionMigrations.previewExpiresAt)
        .as("preview_expires_at"),
    stripeScheduleId: sql`null`
      .mapWith(
        nullableDriverValueDecoder(
          usagePackSubscriptionMigrations.stripeScheduleId,
        ),
      )
      .as("stripe_schedule_id"),
    stripeInvoiceId: sql`null`
      .mapWith(
        nullableDriverValueDecoder(
          usagePackSubscriptionMigrations.stripeInvoiceId,
        ),
      )
      .as("stripe_invoice_id"),
    stripePaymentIntentId: sql`null`
      .mapWith(
        nullableDriverValueDecoder(
          usagePackSubscriptionMigrations.stripePaymentIntentId,
        ),
      )
      .as("stripe_payment_intent_id"),
    hostedInvoiceUrl: sql`null`
      .mapWith(
        nullableDriverValueDecoder(
          usagePackSubscriptionMigrations.hostedInvoiceUrl,
        ),
      )
      .as("hosted_invoice_url"),
    failureReason: sql`null`
      .mapWith(
        nullableDriverValueDecoder(
          usagePackSubscriptionMigrations.failureReason,
        ),
      )
      .as("failure_reason"),
    completedAt: sql`null`
      .mapWith(
        nullableDriverValueDecoder(usagePackSubscriptionMigrations.completedAt),
      )
      .as("completed_at"),
    createdAt: sql`${sql.param(args.createdAt, columns.createdAt)}`
      .mapWith(usagePackSubscriptionMigrations.createdAt)
      .as("created_at"),
    updatedAt: sql`${sql.param(args.createdAt, columns.updatedAt)}`
      .mapWith(usagePackSubscriptionMigrations.updatedAt)
      .as("updated_at"),
  };
}

// Keep the original read/read/write phase uninterrupted; its wrapper owns the
// sole post-phase cancellation check.
const persistUnpaidMigrationQuote$ = command(
  async (
    { set },
    context: LegacyMigrationContext,
    selections: readonly PreparedMigrationSelection[],
    args: PersistMigrationPreviewArgs,
  ): Promise<MigrationRow | null> => {
    const db = set(writeDb$);
    const [source] = await db
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(
        and(
          eq(orgMetadata.orgId, context.org.orgId),
          eq(orgMetadata.tier, context.org.tier),
          eq(orgMetadata.stripeCustomerId, context.org.stripeCustomerId),
          eq(
            orgMetadata.stripeSubscriptionId,
            context.org.stripeSubscriptionId,
          ),
          eq(orgMetadata.subscriptionStatus, "active"),
          eq(orgMetadata.cancelAtPeriodEnd, false),
          isNull(orgMetadata.pendingSubscriptionScheduleId),
        ),
      )
      .limit(1);
    // This is an unpaid quote, not accepted migration intent. Existing
    // uniqueness rejects competing previews; confirmation rechecks the source.
    if (!source) {
      return null;
    }
    const [inProgress] = await db
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
    const superseded = db.$with("superseded_migration_previews").as(
      db
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
        )
        .returning({ id: usagePackSubscriptionMigrations.id }),
    );
    const supersession = db
      .select({ count: count().as("count") })
      .from(superseded)
      .as("supersession");
    const created = db.$with("created_migration_preview").as(
      db
        .insert(usagePackSubscriptionMigrations)
        .select(
          db
            .select(migrationPreviewInsertSource(context, args))
            // Consume every superseded row before checking either open key.
            // The scalar aggregate also admits a parent when no old row exists.
            .from(supersession)
            .where(gte(supersession.count, 0)),
        )
        .returning(),
    );
    let migration: MigrationRow | undefined;
    if (selections.length > 0) {
      const source = migrationRevisionSelectionSource(selections);
      const inserted = db.$with("inserted_migration_preview_selections").as(
        db
          .insert(usagePackSubscriptionMigrationSelections)
          .select(
            db
              .select({
                id: source.id,
                migrationId: created.id,
                ...source.fields,
              })
              .from(created)
              .crossJoin(source.desired),
          )
          .returning({ id: usagePackSubscriptionMigrationSelections.id }),
      );
      [migration] = await db
        .with(superseded, created, inserted)
        .select()
        .from(created);
    } else {
      [migration] = await db.with(superseded, created).select().from(created);
    }
    if (!migration) {
      throw new Error("Failed to create usage pack migration preview");
    }
    return migration;
  },
);

const persistMigrationPreview$ = command(
  async (
    { set },
    context: LegacyMigrationContext,
    selections: readonly PreparedMigrationSelection[],
    args: PersistMigrationPreviewArgs,
    signal: AbortSignal,
  ): Promise<MigrationRow | null> => {
    const result = await set(
      persistUnpaidMigrationQuote$,
      context,
      selections,
      args,
    );
    signal.throwIfAborted();
    return result;
  },
);

export const previewUsagePackSubscriptionMigration$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly targetTier: SubscriptionCheckoutTier;
      readonly memberUsagePacks: readonly MemberUsagePack[];
      readonly owners: readonly UsagePackMigrationOwner[];
    },
    signal: AbortSignal,
  ): Promise<MigrationPreviewResult> => {
    const context = await set(loadLegacyMigrationContext$, args.orgId, signal);
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
      throw new Error(
        "Stripe migration previews returned different currencies",
      );
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
    const migration = await set(
      persistMigrationPreview$,
      context,
      selections,
      {
        targetTier: args.targetTier,
        stripePlanPriceId,
        currentRecurringAmountCents,
        nextRecurringAmountCents,
        recurringDifferenceCents,
        currency: targetPreview.currency,
        effectiveAt,
        createdAt,
        expiresAt,
      },
      signal,
    );
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
  },
);

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

const loadMigrationForRevision$ = command(
  async (
    { get },
    orgId: string,
    migrationId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly migration: MigrationRow;
    readonly selections: readonly MigrationSelectionRow[];
  } | null> => {
    const db = get(db$);
    const selectionColumns = getTableColumns(
      usagePackSubscriptionMigrationSelections,
    );
    const selectionSchema = contextProjectionSchema(selectionColumns);
    const selections = db
      .select({
        payload: contextJsonProjection(selectionColumns)
          .mapWith(zodDriverValueDecoder(selectionSchema))
          .as("payload"),
      })
      .from(usagePackSubscriptionMigrationSelections)
      .where(
        eq(
          usagePackSubscriptionMigrationSelections.migrationId,
          usagePackSubscriptionMigrations.id,
        ),
      );
    // Read-only preparation: persistMigrationRevisionIntent$ revalidates the
    // stored configuration with an exact-row CAS before any write.
    const [result] = await db
      .select({
        migration: usagePackSubscriptionMigrations,
        selections: contextJsonRows(selections).mapWith(
          zodDriverValueDecoder(selectionSchema.array()),
        ),
      })
      .from(usagePackSubscriptionMigrations)
      .where(
        and(
          eq(usagePackSubscriptionMigrations.id, migrationId),
          eq(usagePackSubscriptionMigrations.orgId, orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return result ?? null;
  },
);

const prepareMigrationRevision$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly migrationId: string;
      readonly targetTier: SubscriptionCheckoutTier;
      readonly memberUsagePacks: readonly MemberUsagePack[];
      readonly owners: readonly UsagePackMigrationOwner[];
    },
    signal: AbortSignal,
  ): Promise<PrepareMigrationRevisionResult> => {
    const stored = await set(
      loadMigrationForRevision$,
      args.orgId,
      args.migrationId,
      signal,
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
    const legacyItem = legacyPlanItem(
      subscription,
      stored.migration.sourceTier,
    );
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
        expiresAt: new Date(nowDate().getTime() + PREVIEW_TTL_MS),
      },
    };
  },
);

export const previewUsagePackSubscriptionMigrationRevision$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly migrationId: string;
      readonly targetTier: SubscriptionCheckoutTier;
      readonly memberUsagePacks: readonly MemberUsagePack[];
      readonly owners: readonly UsagePackMigrationOwner[];
    },
    signal: AbortSignal,
  ): Promise<MigrationRevisionPreviewResult> => {
    const result = await set(prepareMigrationRevision$, args, signal);
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
    const bonusCredits = prepared.desiredSelections.reduce(
      (total, selection) => {
        return total + selection.bonusCredits;
      },
      0,
    );
    return {
      status: "ready",
      preview: {
        migrationId: prepared.migration.id,
        tier: prepared.migration.targetTier,
        targetTier: args.targetTier,
        currentRecurringAmountCents:
          prepared.migration.nextRecurringAmountCents,
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
  },
);

type PersistMigrationRevisionResult =
  | { readonly status: "ready"; readonly migration: MigrationRow }
  | { readonly status: "not_found" }
  | { readonly status: "conflict" };

interface PersistMigrationRevisionArgs {
  readonly orgId: string;
  readonly migrationId: string;
  readonly baseConfigurationHash: string;
  readonly desiredConfigurationHash: string;
  readonly prepared: PreparedMigrationRevision;
}

function migrationRevisionSelectionSource(
  selections: readonly PreparedMigrationSelection[],
) {
  const columns = getTableColumns(usagePackSubscriptionMigrationSelections);
  const values = selections.map((selection) => {
    return sql`(
      ${sql.param(selection.userId, columns.userId)}::text,
      ${sql.param(selection.invitationId, columns.invitationId)}::text,
      ${sql.param(selection.normalizedEmail, columns.normalizedEmail)}::text,
      ${sql.param(selection.role, columns.role)}::text,
      ${sql.param(selection.inviterUserId, columns.inviterUserId)}::text,
      ${sql.param(selection.usagePackUsd, columns.usagePackUsd)}::integer,
      ${sql.param(selection.stripePriceId, columns.stripePriceId)}::text,
      ${sql.param(selection.unitAmountCents, columns.unitAmountCents)}::integer,
      ${sql.param(selection.purchasedCredits, columns.purchasedCredits)}::bigint,
      ${sql.param(selection.bonusCredits, columns.bonusCredits)}::bigint
    )`;
  });
  const desired = sql`(values ${sql.join(values, sql`, `)}) as desired(
    user_id, invitation_id, normalized_email, role, inviter_user_id,
    usage_pack_usd, stripe_price_id, unit_amount_cents, purchased_credits,
    bonus_credits
  )`;
  return {
    desired,
    id: sql`gen_random_uuid()`
      .mapWith(usagePackSubscriptionMigrationSelections.id)
      .as("id"),
    fields: {
      userId: sql`desired.user_id`
        .mapWith(usagePackSubscriptionMigrationSelections.userId)
        .as("user_id"),
      invitationId: sql`desired.invitation_id`
        .mapWith(usagePackSubscriptionMigrationSelections.invitationId)
        .as("invitation_id"),
      normalizedEmail: sql`desired.normalized_email`
        .mapWith(usagePackSubscriptionMigrationSelections.normalizedEmail)
        .as("normalized_email"),
      role: sql`desired.role`
        .mapWith(usagePackSubscriptionMigrationSelections.role)
        .as("role"),
      inviterUserId: sql`desired.inviter_user_id`
        .mapWith(usagePackSubscriptionMigrationSelections.inviterUserId)
        .as("inviter_user_id"),
      usagePackUsd: sql`desired.usage_pack_usd`
        .mapWith(usagePackSubscriptionMigrationSelections.usagePackUsd)
        .as("usage_pack_usd"),
      stripePriceId: sql`desired.stripe_price_id`
        .mapWith(usagePackSubscriptionMigrationSelections.stripePriceId)
        .as("stripe_price_id"),
      unitAmountCents: sql`desired.unit_amount_cents`
        .mapWith(usagePackSubscriptionMigrationSelections.unitAmountCents)
        .as("unit_amount_cents"),
      purchasedCredits: sql`desired.purchased_credits`
        .mapWith(usagePackSubscriptionMigrationSelections.purchasedCredits)
        .as("purchased_credits"),
      bonusCredits: sql`desired.bonus_credits`
        .mapWith(usagePackSubscriptionMigrationSelections.bonusCredits)
        .as("bonus_credits"),
      createdAt: sql`now()`
        .mapWith(usagePackSubscriptionMigrationSelections.createdAt)
        .as("created_at"),
    },
  };
}

// The entire read/hash/write phase is uninterrupted. Only the original owner
// checks cancellation, after this stable semantic command has completed.
const persistScheduledMigrationRevision$ = command(
  async (
    { set },
    args: PersistMigrationRevisionArgs,
  ): Promise<PersistMigrationRevisionResult> => {
    const db = set(writeDb$);
    const [migration] = await db
      .select(migrationColumnsWithRowVersion())
      .from(usagePackSubscriptionMigrations)
      .where(
        and(
          eq(usagePackSubscriptionMigrations.id, args.migrationId),
          eq(usagePackSubscriptionMigrations.orgId, args.orgId),
        ),
      )
      .limit(1);
    if (!migration) {
      return { status: "not_found" as const };
    }
    const selections = await db
      .select()
      .from(usagePackSubscriptionMigrationSelections)
      .where(
        eq(usagePackSubscriptionMigrationSelections.migrationId, migration.id),
      );
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
    const revising = db.$with("revising_migration").as(
      db
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
            // Exact-row CAS: the configuration validated above is current.
            migrationRowVersionIs(migration.rowVersion),
          ),
        )
        .returning(),
    );
    const deleted = db.$with("deleted_revision_selections").as(
      db
        .delete(usagePackSubscriptionMigrationSelections)
        .where(
          inArray(
            usagePackSubscriptionMigrationSelections.migrationId,
            db.select({ id: revising.id }).from(revising),
          ),
        )
        .returning({ id: usagePackSubscriptionMigrationSelections.id }),
    );
    let revised: MigrationRow | undefined;
    if (args.prepared.desiredSelections.length > 0) {
      const source = migrationRevisionSelectionSource(
        args.prepared.desiredSelections,
      );
      const inserted = db.$with("inserted_revision_selections").as(
        db
          .insert(usagePackSubscriptionMigrationSelections)
          .select(
            db
              .select({
                id: source.id,
                migrationId: revising.id,
                ...source.fields,
              })
              .from(revising)
              .crossJoin(source.desired)
              // Consume the entire DELETE before checking replacement uniqueness.
              // Its scalar aggregate still produces one row for an empty old set.
              .where(
                sql`(${db.select({ count: count() }).from(deleted)}) >= 0`,
              ),
          )
          .returning({ id: usagePackSubscriptionMigrationSelections.id }),
      );
      [revised] = await db
        .with(revising, deleted, inserted)
        .select()
        .from(revising);
    } else {
      [revised] = await db.with(revising, deleted).select().from(revising);
    }
    return revised
      ? { status: "ready" as const, migration: revised }
      : { status: "conflict" as const };
  },
);

const persistMigrationRevisionIntent$ = command(
  async (
    { set },
    args: PersistMigrationRevisionArgs,
    signal: AbortSignal,
  ): Promise<PersistMigrationRevisionResult> => {
    const result = await set(persistScheduledMigrationRevision$, args);
    signal.throwIfAborted();
    return result;
  },
);

export const confirmUsagePackSubscriptionMigrationRevision$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly migrationId: string;
      readonly targetTier: SubscriptionCheckoutTier;
      readonly memberUsagePacks: readonly MemberUsagePack[];
      readonly owners: readonly UsagePackMigrationOwner[];
      readonly previewToken: string;
    },
    signal: AbortSignal,
  ): Promise<MigrationRevisionConfirmResult> => {
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

    const stored = await set(
      loadMigrationForRevision$,
      args.orgId,
      args.migrationId,
      signal,
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
      const reconciled = await set(
        reconcileMigration$,
        { migration: stored.migration },
        signal,
      );
      return reconciled.status === "failed"
        ? { status: "conflict" }
        : { status: "confirmed", response: reconciled.response };
    }
    if (currentConfigurationHash !== token.baseConfigurationHash) {
      return { status: "conflict" };
    }

    const preparedResult = await set(prepareMigrationRevision$, args, signal);
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
    const persisted = await set(
      persistMigrationRevisionIntent$,
      {
        orgId: args.orgId,
        migrationId: args.migrationId,
        baseConfigurationHash: token.baseConfigurationHash,
        desiredConfigurationHash: token.desiredConfigurationHash,
        prepared: preparedResult.prepared,
      },
      signal,
    );
    signal.throwIfAborted();
    if (persisted.status !== "ready") {
      return persisted;
    }
    const reconciled = await set(
      reconcileMigration$,
      { migration: persisted.migration },
      signal,
    );
    return reconciled.status === "failed"
      ? { status: "conflict" }
      : { status: "confirmed", response: reconciled.response };
  },
);

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

// Reconciliation owns the cancellation check after this provider/write phase.
const persistMigrationInvoiceState$ = command(
  async (
    { set },
    migration: MigrationRow,
    selections: readonly MigrationSelectionRow[],
    subscription: StripeSubscription,
  ): Promise<MigrationRow> => {
    const db = set(writeDb$);
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
  },
);

/** The Stripe binding, not the conversion UUID, owns the subscription root. */
function migrationSubscriptionRootWhere(migration: MigrationRow) {
  return eq(
    usagePackSubscriptions.stripeSubscriptionId,
    migration.stripeSubscriptionId,
  );
}

function validatedMigrationSubscriptionRoot(
  migration: MigrationRow,
  root: typeof usagePackSubscriptions.$inferSelect | undefined,
) {
  if (
    root &&
    (root.orgId !== migration.orgId ||
      root.stripeCustomerId !== migration.stripeCustomerId)
  ) {
    throw new Error(
      `Usage pack migration ${migration.id} subscription belongs to another billing owner`,
    );
  }
  return root ?? null;
}

// The caller checks cancellation after ownership validation, as before.
const readMigrationSubscriptionRoot$ = command(
  async ({ get }, migration: MigrationRow) => {
    const [root] = await get(db$)
      .select()
      .from(usagePackSubscriptions)
      .where(migrationSubscriptionRootWhere(migration))
      .limit(1);
    return validatedMigrationSubscriptionRoot(migration, root);
  },
);

function migrationPlanRootConversion(
  migration: MigrationRow,
  existing: typeof usagePackSubscriptions.$inferSelect,
  subscription: StripeSubscription,
) {
  return {
    values: {
      tier: migration.targetTier,
      stripePlanPriceId: migration.stripePlanPriceId,
      subscriptionStatus: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      updatedAt: nowDate(),
    },
    condition: and(
      eq(usagePackSubscriptions.id, existing.id),
      eq(usagePackSubscriptions.orgId, migration.orgId),
      eq(usagePackSubscriptions.stripeCustomerId, migration.stripeCustomerId),
      eq(
        usagePackSubscriptions.stripeSubscriptionId,
        migration.stripeSubscriptionId,
      ),
      eq(usagePackSubscriptions.tier, migration.sourceTier),
      inArray(usagePackSubscriptions.subscriptionStatus, [
        "active",
        "trialing",
        "past_due",
        "unpaid",
        "canceled",
        "incomplete_expired",
        "paused",
      ]),
      eq(
        usagePackSubscriptions.stripePlanPriceId,
        migration.legacyStripePriceId,
      ),
      eq(
        usagePackSubscriptions.subscriptionStatus,
        existing.subscriptionStatus,
      ),
      sql`NOT EXISTS (SELECT 1 FROM ${usagePackAllocations} WHERE ${usagePackAllocations.usagePackSubscriptionId} = ${existing.id}::uuid)`,
    ),
  };
}

function validateMigrationAllocations(
  allocations: readonly (typeof usagePackAllocations.$inferSelect)[],
  migration: MigrationRow,
  selections: readonly MigrationSelectionRow[],
  requireSelections: boolean,
): void {
  const same = selections.every((selection) => {
    return allocations.some((allocation) => {
      return (
        allocation.orgId === migration.orgId &&
        allocation.userId === selection.userId &&
        allocation.invitationId === selection.invitationId &&
        allocation.usagePackUsd === selection.usagePackUsd &&
        allocation.stripePriceId === selection.stripePriceId
      );
    });
  });
  if (
    allocations.length !== selections.length ||
    (requireSelections && !same)
  ) {
    throw new Error(`Usage pack migration ${migration.id} allocations changed`);
  }
}

const committedMigrationMaterialization$ = command(
  async (
    { get, set },
    migration: MigrationRow,
    selections: readonly MigrationSelectionRow[],
    signal: AbortSignal,
  ): Promise<string> => {
    const db = get(db$);
    const winner = await set(readMigrationSubscriptionRoot$, migration);
    signal.throwIfAborted();
    if (
      !winner ||
      winner.tier !== migration.targetTier ||
      winner.stripePlanPriceId !== migration.stripePlanPriceId
    ) {
      throw new Error(
        `Usage pack migration ${migration.id} has no matching materialized root`,
      );
    }
    const allocations = await db
      .select()
      .from(usagePackAllocations)
      .where(eq(usagePackAllocations.usagePackSubscriptionId, winner.id));
    signal.throwIfAborted();
    validateMigrationAllocations(allocations, migration, selections, true);
    signal.throwIfAborted();
    return winner.id;
  },
);

function materializedMigrationAllocations(
  migration: MigrationRow,
  rootId: string,
  selections: readonly MigrationSelectionRow[],
) {
  return selections.map((selection) => {
    return {
      usagePackSubscriptionId: rootId,
      orgId: migration.orgId,
      userId: selection.userId,
      invitationId: selection.invitationId,
      usagePackUsd: selection.usagePackUsd,
      stripePriceId: selection.stripePriceId,
      status: "pending_payment" as const,
    };
  });
}

const migrationAllocationInputColumns = Object.freeze({
  usagePackSubscriptionId: usagePackAllocations.usagePackSubscriptionId,
  orgId: usagePackAllocations.orgId,
  userId: usagePackAllocations.userId,
  invitationId: usagePackAllocations.invitationId,
  usagePackUsd: usagePackAllocations.usagePackUsd,
  stripePriceId: usagePackAllocations.stripePriceId,
  status: usagePackAllocations.status,
});

/** Actual validated selections, carried in one parameter without a bind-count limit. */
function materializedMigrationAllocationInput(
  values: ReturnType<typeof materializedMigrationAllocations>,
) {
  const rows = values.map((value) => {
    return {
      usage_pack_subscription_id: value.usagePackSubscriptionId,
      org_id: value.orgId,
      user_id: value.userId,
      invitation_id: value.invitationId,
      usage_pack_usd: value.usagePackUsd,
      stripe_price_id: value.stripePriceId,
      status: value.status,
    };
  });
  return new QueryBuilder().$with(
    "migration_allocation_input",
    migrationAllocationInputColumns,
  ).as(sql`
    SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS captured(
      usage_pack_subscription_id uuid, org_id text, user_id text,
      invitation_id text, usage_pack_usd integer, stripe_price_id text, status text
    )
  `);
}

/** Partial INSERT SELECT preserves the schema-owned UUID/time/null defaults. */
function materializedMigrationAllocationInsert(
  input: ReturnType<typeof materializedMigrationAllocationInput>,
  winningRootIds: ReturnType<typeof sql>,
) {
  const columns = usagePackAllocations;
  return sql`
    INSERT INTO ${usagePackAllocations} (
      ${sql.identifier(columns.usagePackSubscriptionId.name)},
      ${sql.identifier(columns.orgId.name)},
      ${sql.identifier(columns.userId.name)},
      ${sql.identifier(columns.invitationId.name)},
      ${sql.identifier(columns.usagePackUsd.name)},
      ${sql.identifier(columns.stripePriceId.name)},
      ${sql.identifier(columns.status.name)}
    )
    SELECT ${input.usagePackSubscriptionId}, ${input.orgId}, ${input.userId},
      ${input.invitationId}, ${input.usagePackUsd}, ${input.stripePriceId}, ${input.status}
    FROM ${input}
    WHERE ${inArray(input.usagePackSubscriptionId, winningRootIds)}
  `;
}

class MigrationMaterializationChanged extends Error {}

const materializeUsagePackSnapshot$ = command(
  async (
    { set },
    args: {
      readonly migration: MigrationRow;
      readonly selections: readonly MigrationSelectionRow[];
      readonly subscription: StripeSubscription;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const db = set(writeDb$);
    const { migration, selections, subscription } = args;
    const expectedConfiguration = migrationScheduleRevisionHash(
      migration,
      selections,
    );
    const result = await settle(
      (async () => {
        // A Plan root already bound to this Stripe subscription keeps both
        // identities. The migration UUID identifies the conversion operation,
        // not a second root competing for the same unique provider binding.
        const [root] = await db
          .select()
          .from(usagePackSubscriptions)
          .where(migrationSubscriptionRootWhere(migration))
          .limit(1);
        const existing = validatedMigrationSubscriptionRoot(migration, root);
        const [locked] = await db
          .select()
          .from(usagePackSubscriptionMigrations)
          .where(
            and(
              eq(usagePackSubscriptionMigrations.id, migration.id),
              eq(usagePackSubscriptionMigrations.orgId, migration.orgId),
            ),
          )
          .limit(1);
        if (!locked || locked.status === "failed") {
          throw new Error(`Usage pack migration ${migration.id} is not active`);
        }
        const currentSelections = await db
          .select()
          .from(usagePackSubscriptionMigrationSelections)
          .where(migrationSelectionsWhere(migration.id));
        assertMigrationConfiguration(
          expectedConfiguration,
          locked,
          currentSelections,
        );
        const rootId = existing?.id ?? migration.id;
        const convertingPlanRoot =
          existing !== null &&
          existing.stripePlanPriceId !== migration.stripePlanPriceId;
        if (existing && !convertingPlanRoot) {
          if (existing.tier !== migration.targetTier) {
            throw new Error(
              `Usage pack migration ${migration.id} snapshot changed`,
            );
          }
          const allocations = await db
            .select()
            .from(usagePackAllocations)
            .where(eq(usagePackAllocations.usagePackSubscriptionId, rootId));
          signal.throwIfAborted();
          validateMigrationAllocations(
            allocations,
            migration,
            selections,
            locked.status !== "completed",
          );
          signal.throwIfAborted();
          return rootId;
        }
        const conversion = existing
          ? migrationPlanRootConversion(migration, existing, subscription)
          : null;
        const mutation = conversion
          ? db
              .update(usagePackSubscriptions)
              .set(conversion.values)
              .where(conversion.condition)
              .returning({ id: usagePackSubscriptions.id })
          : db
              .insert(usagePackSubscriptions)
              .values({
                id: rootId,
                orgId: migration.orgId,
                tier: migration.targetTier,
                stripePlanPriceId: migration.stripePlanPriceId,
                stripeCustomerId: migration.stripeCustomerId,
                stripeSubscriptionId: migration.stripeSubscriptionId,
                subscriptionStatus: subscription.status,
                cancelAtPeriodEnd: subscription.cancel_at_period_end,
              })
              .onConflictDoNothing()
              .returning({ id: usagePackSubscriptions.id });
        const winner = db.$with("materialized_migration_root").as(mutation);
        const input = materializedMigrationAllocationInput(
          materializedMigrationAllocations(migration, rootId, selections),
        );
        const winningRootIds = sql`(${db.select({ id: winner.id }).from(winner)})`;
        const allocations = db
          .$with("materialized_migration_allocations", {})
          .as(materializedMigrationAllocationInsert(input, winningRootIds));
        const [published] = await db
          .with(winner, input, allocations)
          .select({ id: winner.id })
          .from(winner);
        signal.throwIfAborted();
        if (!published) {
          throw new MigrationMaterializationChanged();
        }
        signal.throwIfAborted();
        return rootId;
      })(),
    );
    signal.throwIfAborted();
    if (result.ok) {
      return result.value;
    }
    if (!(result.error instanceof MigrationMaterializationChanged)) {
      throw result.error;
    }
    // The losing statement left no writes. Resolve one committed canonical
    // root once; neither generate another UUID nor rerun materialization.
    return await set(
      committedMigrationMaterialization$,
      migration,
      selections,
      signal,
    );
  },
);

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

function migrationCompletionValues(
  invoice: StripeInvoice,
  paymentIntentId: string | null,
  completedAt: Date,
) {
  return {
    status: "completed" as const,
    stripeInvoiceId: invoice.id,
    stripePaymentIntentId: paymentIntentId,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    completedAt,
    updatedAt: completedAt,
  };
}

function migrationCompletionWhere(migrationId: string, rowVersion: string) {
  return and(
    eq(usagePackSubscriptionMigrations.id, migrationId),
    migrationRowVersionIs(rowVersion),
  );
}

function migrationSelectionsWhere(migrationId: string) {
  return eq(usagePackSubscriptionMigrationSelections.migrationId, migrationId);
}

function migrationInvitationValues(args: {
  readonly migration: MigrationRow;
  readonly invoice: StripeInvoice;
  readonly usagePackSubscriptionId: string;
  readonly selection: typeof usagePackSubscriptionMigrationSelections.$inferSelect;
  readonly allocation: typeof usagePackAllocations.$inferSelect | undefined;
  readonly credit:
    | { readonly purchasedCredits: number; readonly bonusCredits: number }
    | undefined;
  readonly amountPaidCents: number;
  readonly paymentIntentId: string | null;
}) {
  const {
    migration,
    invoice,
    usagePackSubscriptionId,
    selection,
    allocation,
    credit,
    amountPaidCents,
    paymentIntentId,
  } = args;
  if (
    !allocation ||
    !allocation.currentPeriodStart ||
    !allocation.currentPeriodEnd ||
    !credit ||
    !selection.normalizedEmail ||
    !selection.role ||
    !selection.inviterUserId
  ) {
    throw new Error(
      `Usage pack migration invitation ${selection.invitationId} is incomplete`,
    );
  }
  return {
    usagePackSubscriptionId,
    allocationId: allocation.id,
    orgId: migration.orgId,
    normalizedEmail: selection.normalizedEmail,
    role: selection.role,
    inviterUserId: selection.inviterUserId,
    usagePackUsd: selection.usagePackUsd,
    stripePriceId: selection.stripePriceId,
    status: "invitation_pending" as const,
    currentPeriodStart: allocation.currentPeriodStart,
    currentPeriodEnd: allocation.currentPeriodEnd,
    prorationTimestamp: Math.floor(migration.effectiveAt.getTime() / 1000),
    unitAmountCents: selection.unitAmountCents,
    expectedAmountCents: amountPaidCents,
    amountPaidCents,
    currency: migration.currency,
    purchasedCredits: credit.purchasedCredits,
    bonusCredits: credit.bonusCredits,
    stripePaymentIntentId: amountPaidCents > 0 ? paymentIntentId : null,
    clerkInvitationId: selection.invitationId,
    paidAt: invoicePaidAt(invoice),
  };
}

interface MigrationInvitationCompletion {
  readonly migration: MigrationRow;
  readonly invoice: StripeInvoice;
  readonly usagePackSubscriptionId: string;
}

const readMigrationInvitationCompletion$ = command(
  async ({ get }, args: MigrationInvitationCompletion) => {
    const db = get(db$);
    const validating = notInArray(usagePackSubscriptionMigrations.status, [
      "failed",
      "completed",
    ]);
    const selectionColumns = getTableColumns(
      usagePackSubscriptionMigrationSelections,
    );
    const allocationColumns = getTableColumns(usagePackAllocations);
    const selections = db
      .select({
        payload: contextJsonProjection(selectionColumns)
          .mapWith(
            zodDriverValueDecoder(contextProjectionSchema(selectionColumns)),
          )
          .as("payload"),
      })
      .from(usagePackSubscriptionMigrationSelections)
      .where(and(validating, migrationSelectionsWhere(args.migration.id)));
    const allocations = db
      .select({
        payload: contextJsonProjection(allocationColumns)
          .mapWith(
            zodDriverValueDecoder(contextProjectionSchema(allocationColumns)),
          )
          .as("payload"),
      })
      .from(usagePackAllocations)
      .where(
        and(
          validating,
          eq(
            usagePackAllocations.usagePackSubscriptionId,
            args.usagePackSubscriptionId,
          ),
          eq(usagePackSubscriptions.id, args.usagePackSubscriptionId),
          eq(usagePackSubscriptions.orgId, args.migration.orgId),
          eq(
            usagePackSubscriptions.stripeCustomerId,
            args.migration.stripeCustomerId,
          ),
        ),
      );
    const [current] = await db
      .select({
        migration: migrationColumnsWithRowVersion(),
        selections: contextJsonRows(selections).mapWith(
          zodDriverValueDecoder(
            contextProjectionSchema(selectionColumns).array(),
          ),
        ),
        root: usagePackSubscriptions,
        allocations: contextJsonRows(allocations).mapWith(
          zodDriverValueDecoder(
            contextProjectionSchema(allocationColumns).array(),
          ),
        ),
      })
      .from(usagePackSubscriptionMigrations)
      .leftJoin(
        usagePackSubscriptions,
        and(validating, migrationSubscriptionRootWhere(args.migration)),
      )
      .where(eq(usagePackSubscriptionMigrations.id, args.migration.id))
      .limit(1);
    return current ?? null;
  },
);

function migrationInvitationIdentitySelection() {
  return {
    id: sql`gen_random_uuid()`
      .mapWith(usagePackInvitationPurchases.id)
      .as("id"),
    usagePackSubscriptionId:
      sql`prepared_migration_invitations."usagePackSubscriptionId"`
        .mapWith(usagePackInvitationPurchases.usagePackSubscriptionId)
        .as("usagePackSubscriptionId"),
    allocationId: sql`prepared_migration_invitations."allocationId"`
      .mapWith(
        nullableDriverValueDecoder(usagePackInvitationPurchases.allocationId),
      )
      .as("allocationId"),
    orgId: sql`prepared_migration_invitations."orgId"`
      .mapWith(usagePackInvitationPurchases.orgId)
      .as("orgId"),
    normalizedEmail: sql`prepared_migration_invitations."normalizedEmail"`
      .mapWith(usagePackInvitationPurchases.normalizedEmail)
      .as("normalizedEmail"),
    role: sql`prepared_migration_invitations."role"`
      .mapWith(usagePackInvitationPurchases.role)
      .as("role"),
    inviterUserId: sql`prepared_migration_invitations."inviterUserId"`
      .mapWith(usagePackInvitationPurchases.inviterUserId)
      .as("inviterUserId"),
    impactClickId: sql`null`
      .mapWith(
        nullableDriverValueDecoder(usagePackInvitationPurchases.impactClickId),
      )
      .as("impactClickId"),
    impactClickAt: sql`null`
      .mapWith(
        nullableDriverValueDecoder(usagePackInvitationPurchases.impactClickAt),
      )
      .as("impactClickAt"),
  };
}

function migrationInvitationPaymentSelection() {
  return {
    usagePackUsd: sql`prepared_migration_invitations."usagePackUsd"`
      .mapWith(usagePackInvitationPurchases.usagePackUsd)
      .as("usagePackUsd"),
    stripePriceId: sql`prepared_migration_invitations."stripePriceId"`
      .mapWith(usagePackInvitationPurchases.stripePriceId)
      .as("stripePriceId"),
    status: sql`prepared_migration_invitations."status"`
      .mapWith(usagePackInvitationPurchases.status)
      .as("status"),
    currentPeriodStart: sql`prepared_migration_invitations."currentPeriodStart"`
      .mapWith(usagePackInvitationPurchases.currentPeriodStart)
      .as("currentPeriodStart"),
    currentPeriodEnd: sql`prepared_migration_invitations."currentPeriodEnd"`
      .mapWith(usagePackInvitationPurchases.currentPeriodEnd)
      .as("currentPeriodEnd"),
    prorationTimestamp: sql`prepared_migration_invitations."prorationTimestamp"`
      .mapWith(usagePackInvitationPurchases.prorationTimestamp)
      .as("prorationTimestamp"),
    unitAmountCents: sql`prepared_migration_invitations."unitAmountCents"`
      .mapWith(usagePackInvitationPurchases.unitAmountCents)
      .as("unitAmountCents"),
    expectedAmountCents:
      sql`prepared_migration_invitations."expectedAmountCents"`
        .mapWith(usagePackInvitationPurchases.expectedAmountCents)
        .as("expectedAmountCents"),
    amountPaidCents: sql`prepared_migration_invitations."amountPaidCents"`
      .mapWith(
        nullableDriverValueDecoder(
          usagePackInvitationPurchases.amountPaidCents,
        ),
      )
      .as("amountPaidCents"),
    currency: sql`prepared_migration_invitations."currency"`
      .mapWith(usagePackInvitationPurchases.currency)
      .as("currency"),
    purchasedCredits: sql`prepared_migration_invitations."purchasedCredits"`
      .mapWith(usagePackInvitationPurchases.purchasedCredits)
      .as("purchasedCredits"),
    bonusCredits: sql`prepared_migration_invitations."bonusCredits"`
      .mapWith(usagePackInvitationPurchases.bonusCredits)
      .as("bonusCredits"),
    stripeCheckoutSessionId: sql`null`
      .mapWith(
        nullableDriverValueDecoder(
          usagePackInvitationPurchases.stripeCheckoutSessionId,
        ),
      )
      .as("stripeCheckoutSessionId"),
    stripeCheckoutExpiresAt: sql`null`
      .mapWith(
        nullableDriverValueDecoder(
          usagePackInvitationPurchases.stripeCheckoutExpiresAt,
        ),
      )
      .as("stripeCheckoutExpiresAt"),
    stripePaymentIntentId:
      sql`prepared_migration_invitations."stripePaymentIntentId"`
        .mapWith(
          nullableDriverValueDecoder(
            usagePackInvitationPurchases.stripePaymentIntentId,
          ),
        )
        .as("stripePaymentIntentId"),
    stripeRefundId: sql`null`
      .mapWith(
        nullableDriverValueDecoder(usagePackInvitationPurchases.stripeRefundId),
      )
      .as("stripeRefundId"),
    refundAttempt: sql`1`
      .mapWith(usagePackInvitationPurchases.refundAttempt)
      .as("refundAttempt"),
  };
}

function migrationInvitationLifecycleSelection() {
  return {
    clerkInvitationId: sql`prepared_migration_invitations."clerkInvitationId"`
      .mapWith(
        nullableDriverValueDecoder(
          usagePackInvitationPurchases.clerkInvitationId,
        ),
      )
      .as("clerkInvitationId"),
    acceptedUserId: sql`null`
      .mapWith(
        nullableDriverValueDecoder(usagePackInvitationPurchases.acceptedUserId),
      )
      .as("acceptedUserId"),
    failureReason: sql`null`
      .mapWith(
        nullableDriverValueDecoder(usagePackInvitationPurchases.failureReason),
      )
      .as("failureReason"),
    paidAt: sql`prepared_migration_invitations."paidAt"`
      .mapWith(nullableDriverValueDecoder(usagePackInvitationPurchases.paidAt))
      .as("paidAt"),
    acceptedAt: sql`null`
      .mapWith(
        nullableDriverValueDecoder(usagePackInvitationPurchases.acceptedAt),
      )
      .as("acceptedAt"),
    refundedAt: sql`null`
      .mapWith(
        nullableDriverValueDecoder(usagePackInvitationPurchases.refundedAt),
      )
      .as("refundedAt"),
    createdAt: sql`now()`
      .mapWith(usagePackInvitationPurchases.createdAt)
      .as("createdAt"),
    updatedAt: sql`now()`
      .mapWith(usagePackInvitationPurchases.updatedAt)
      .as("updatedAt"),
  };
}

function migrationInvitationInsertSelection() {
  return {
    ...migrationInvitationIdentitySelection(),
    ...migrationInvitationPaymentSelection(),
    ...migrationInvitationLifecycleSelection(),
  };
}

/** Preserve the original column encoders and PostgreSQL numeric input strings. */
function migrationInvitationRecordset(
  invitations: readonly ReturnType<typeof migrationInvitationValues>[],
) {
  const values = invitations.map((row) => {
    return {
      ...row,
      currentPeriodStart:
        usagePackInvitationPurchases.currentPeriodStart.mapToDriverValue(
          row.currentPeriodStart,
        ),
      currentPeriodEnd:
        usagePackInvitationPurchases.currentPeriodEnd.mapToDriverValue(
          row.currentPeriodEnd,
        ),
      paidAt: usagePackInvitationPurchases.paidAt.mapToDriverValue(row.paidAt),
      usagePackUsd: row.usagePackUsd.toString(),
      prorationTimestamp: row.prorationTimestamp.toString(),
      unitAmountCents: row.unitAmountCents.toString(),
      expectedAmountCents: row.expectedAmountCents.toString(),
      amountPaidCents: row.amountPaidCents.toString(),
      purchasedCredits: row.purchasedCredits.toString(),
      bonusCredits: row.bonusCredits.toString(),
    };
  });
  return sql`jsonb_to_recordset(${JSON.stringify(values)}::jsonb)
    as prepared_migration_invitations(
      "usagePackSubscriptionId" uuid,
      "allocationId" uuid,
      "orgId" text,
      "normalizedEmail" text,
      "role" text,
      "inviterUserId" text,
      "usagePackUsd" integer,
      "stripePriceId" text,
      "status" text,
      "currentPeriodStart" timestamp,
      "currentPeriodEnd" timestamp,
      "prorationTimestamp" bigint,
      "unitAmountCents" integer,
      "expectedAmountCents" integer,
      "amountPaidCents" integer,
      "currency" text,
      "purchasedCredits" bigint,
      "bonusCredits" bigint,
      "stripePaymentIntentId" text,
      "clerkInvitationId" text,
      "paidAt" timestamp
    )`;
}

const publishMigrationInvitationCompletion$ = command(
  async (
    { set },
    args: {
      readonly migrationId: string;
      readonly rowVersion: string;
      readonly values: ReturnType<typeof migrationCompletionValues>;
      readonly invitations: readonly ReturnType<
        typeof migrationInvitationValues
      >[];
    },
  ) => {
    const db = set(writeDb$);
    const completed = db
      .$with("completed_invitation_migration")
      .as(
        db
          .update(usagePackSubscriptionMigrations)
          .set(args.values)
          .where(migrationCompletionWhere(args.migrationId, args.rowVersion))
          .returning({ id: usagePackSubscriptionMigrations.id }),
      );
    if (args.invitations.length === 0) {
      const [winner] = await db
        .with(completed)
        .select({ id: completed.id })
        .from(completed);
      return winner !== undefined;
    }
    const invitations = db.$with("completed_migration_invitations").as(
      db
        .insert(usagePackInvitationPurchases)
        .select(
          db
            .select(migrationInvitationInsertSelection())
            .from(migrationInvitationRecordset(args.invitations))
            .crossJoin(completed),
        )
        .returning({ id: usagePackInvitationPurchases.id }),
    );
    const [winner] = await db
      .with(completed, invitations)
      .select({ id: completed.id })
      .from(completed);
    return winner !== undefined;
  },
);

const completeMigrationInvitations$ = command(
  async (
    { set },
    args: MigrationInvitationCompletion,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const { migration, invoice, usagePackSubscriptionId } = args;
    const selections = await db
      .select()
      .from(usagePackSubscriptionMigrationSelections)
      .where(
        eq(usagePackSubscriptionMigrationSelections.migrationId, migration.id),
      );
    signal.throwIfAborted();
    const credits = selectionCreditsForInvoice(invoice, selections);
    const payment = paidInvoicePaymentIntent(invoice);
    const paymentIntentId = payment?.id ?? migration.stripePaymentIntentId;
    const paidAmounts = paidAmountsBySelection(
      safeInvoiceAmount(invoice, "paid"),
      payment?.amountPaidCents ?? 0,
      selections,
      credits,
    );
    const expectedConfiguration = migrationScheduleRevisionHash(
      migration,
      selections,
    );
    const prepared = await set(readMigrationInvitationCompletion$, args);
    signal.throwIfAborted();
    if (!prepared || prepared.migration.status === "failed") {
      throw new Error(`Usage pack migration ${migration.id} cannot complete`);
    }
    const locked = prepared.migration;
    if (locked.status === "completed") {
      signal.throwIfAborted();
      return;
    }
    assertMigrationConfiguration(
      expectedConfiguration,
      locked,
      prepared.selections,
    );
    const root = validatedMigrationSubscriptionRoot(
      migration,
      prepared.root ?? undefined,
    );
    if (root?.id !== usagePackSubscriptionId) {
      throw new Error(`Usage pack migration ${migration.id} lost correlation`);
    }
    const completedAt = nowDate();
    const values = migrationCompletionValues(
      invoice,
      paymentIntentId,
      completedAt,
    );
    const { allocations } = prepared;
    if (allocations.length !== selections.length) {
      throw new Error(
        `Usage pack migration ${migration.id} allocations changed`,
      );
    }
    const invitations = selections
      .filter((selection) => {
        return Boolean(selection.invitationId);
      })
      .map((selection) => {
        return migrationInvitationValues({
          migration,
          invoice,
          usagePackSubscriptionId,
          selection,
          allocation: allocations.find((candidate) => {
            return candidate.invitationId === selection.invitationId;
          }),
          credit: credits.get(selection.id),
          amountPaidCents: paidAmounts.get(selection.id) ?? 0,
          paymentIntentId,
        });
      });
    signal.throwIfAborted();
    const completed = await set(publishMigrationInvitationCompletion$, {
      migrationId: migration.id,
      rowVersion: locked.rowVersion,
      values,
      invitations,
    });
    signal.throwIfAborted();
    if (!completed) {
      const [winner] = await db
        .select()
        .from(usagePackSubscriptionMigrations)
        .where(
          and(
            eq(usagePackSubscriptionMigrations.id, migration.id),
            eq(usagePackSubscriptionMigrations.orgId, migration.orgId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (
        winner?.status === "completed" &&
        winner.stripeInvoiceId === invoice.id &&
        winner.stripePaymentIntentId === paymentIntentId
      ) {
        signal.throwIfAborted();
        return;
      }
      throw new Error(
        `Usage pack migration ${migration.id} changed during completion`,
      );
    }
    signal.throwIfAborted();
  },
);

function correlatedMigrationInvoice(
  invoice: StripeInvoice,
  migration: MigrationRow,
  usagePackSubscriptionId: string,
): UsagePackInvoiceInput {
  const subscriptionDetails = invoice.parent?.subscription_details;
  if (!subscriptionDetails) {
    throw new Error(`Migration invoice ${invoice.id} has no subscription`);
  }
  const metadata = usagePackSubscriptionMetadata({
    orgId: migration.orgId,
    tier: migration.targetTier,
    planPriceId: migration.stripePlanPriceId,
    usagePackSubscriptionId,
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

const finalizeAppliedMigration$ = command(
  async (
    { set },
    args: {
      readonly migration: MigrationRow;
      readonly selections: readonly MigrationSelectionRow[];
      readonly subscription: StripeSubscription;
      readonly invoice: StripeInvoice;
    },
    signal: AbortSignal,
  ): Promise<AppliedMigrationResult> => {
    const { migration, selections, subscription, invoice } = args;
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
    const usagePackSubscriptionId = await set(
      materializeUsagePackSnapshot$,
      { migration, selections, subscription },
      signal,
    );
    signal.throwIfAborted();
    const metadata = usagePackSubscriptionMetadata({
      orgId: migration.orgId,
      tier: migration.targetTier,
      planPriceId: migration.stripePlanPriceId,
      usagePackSubscriptionId,
    });
    const tagged = await getStripeClient().subscriptions.update(
      migration.stripeSubscriptionId,
      { metadata },
      { idempotencyKey: `usage-pack-migration:${migration.id}:metadata` },
    );
    signal.throwIfAborted();
    const subscriptionOutcome = await set(
      handleUsagePackSubscriptionUpdated$,
      tagged as UsagePackSubscriptionInput,
    );
    signal.throwIfAborted();
    if (!subscriptionOutcome.handled) {
      throw new Error(`Usage pack migration ${migration.id} lost correlation`);
    }
    const invoiceOutcome = await set(
      handleUsagePackInvoicePaid$,
      correlatedMigrationInvoice(invoice, migration, usagePackSubscriptionId),
      signal,
    );
    if (!invoiceOutcome.handled) {
      throw new Error(
        `Usage pack migration invoice ${invoice.id} was not handled`,
      );
    }
    await set(
      completeMigrationInvitations$,
      { migration, invoice, usagePackSubscriptionId },
      signal,
    );
    signal.throwIfAborted();
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
  },
);

function changedMigrationFailureWritePlan(
  migration: MigrationRow,
  completedAt: Date,
) {
  return {
    values: {
      status: "failed" as const,
      failureReason: "subscription_changed",
      completedAt,
      updatedAt: completedAt,
    },
    condition: and(
      eq(usagePackSubscriptionMigrations.id, migration.id),
      inArray(usagePackSubscriptionMigrations.status, [
        ...RECONCILING_MIGRATION_STATUSES,
      ]),
    ),
  };
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

// Finish the original publication phase after the final provider abort check.
const publishMigrationSchedule$ = command(
  async (
    { set },
    migration: MigrationRow,
    scheduleId: string,
  ): Promise<MigrationRow> => {
    const updatedAt = nowDate();
    const [scheduled] = await set(writeDb$)
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
  },
);

const scheduleMigration$ = command(
  async (
    { set },
    migration: MigrationRow,
    selections: readonly MigrationSelectionRow[],
    subscription: StripeSubscription,
    signal: AbortSignal | undefined,
  ): Promise<MigrationRow> => {
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
      throw new Error(
        `Legacy subscription ${subscription.id} schedule changed`,
      );
    }
    const scheduleConfiguration = migrationScheduleConfiguration(
      migration,
      migration.stripePlanPriceId,
      selections,
      subscription,
      legacyItem,
    );
    await stripe.subscriptionSchedules.update(
      scheduleId,
      scheduleConfiguration,
      {
        idempotencyKey:
          migration.status === "revising"
            ? `usage-pack-migration:${migration.id}:schedule-revision:${migrationScheduleRevisionHash(migration, selections)}`
            : `usage-pack-migration:${migration.id}:schedule-update`,
      },
    );
    signal?.throwIfAborted();
    return await set(publishMigrationSchedule$, migration, scheduleId);
  },
);

const reconcileMigration$ = command(
  async (
    { set },
    args: {
      readonly migration: MigrationRow;
      readonly eventInvoice?: StripeInvoice;
    },
    signal: AbortSignal,
  ): Promise<AppliedMigrationResult> => {
    const db = set(writeDb$);
    const { migration, eventInvoice } = args;
    const selections: readonly MigrationSelectionRow[] = await db
      .select()
      .from(usagePackSubscriptionMigrationSelections)
      .where(
        eq(usagePackSubscriptionMigrationSelections.migrationId, migration.id),
      );
    signal.throwIfAborted();
    const subscription = await getStripeClient().subscriptions.retrieve(
      migration.stripeSubscriptionId,
    );
    signal.throwIfAborted();
    if (subscription.id !== migration.stripeSubscriptionId) {
      throw new Error(
        `Stripe returned subscription ${subscription.id} for migration subscription ${migration.stripeSubscriptionId}`,
      );
    }
    if (desiredMigrationShape(migration, selections, subscription)) {
      const persisted = await set(
        persistMigrationInvoiceState$,
        migration,
        selections,
        subscription,
      );
      signal.throwIfAborted();
      const invoiceId = eventInvoice?.id ?? persisted.stripeInvoiceId;
      const invoice = invoiceId
        ? await retrieveMigrationInvoice(invoiceId)
        : null;
      signal.throwIfAborted();
      if (
        invoice &&
        migrationInvoiceMatchesSelections(invoice, persisted, selections)
      ) {
        return await set(
          finalizeAppliedMigration$,
          { migration: persisted, selections, subscription, invoice },
          signal,
        );
      }
      return {
        status: "active",
        orgId: migration.orgId,
        response: scheduledMigrationResponse(persisted),
      };
    }
    if (!legacyMigrationShape(migration, subscription)) {
      if (
        await (async () => {
          const failedMigration = migration;
          const completedAt = nowDate();
          const plan = changedMigrationFailureWritePlan(
            failedMigration,
            completedAt,
          );
          const [failed] = await db
            .update(usagePackSubscriptionMigrations)
            .set(plan.values)
            .where(plan.condition)
            .returning({ id: usagePackSubscriptionMigrations.id });
          return failed !== undefined;
        })()
      ) {
        return { status: "failed", orgId: migration.orgId };
      }
      return { status: "failed", orgId: migration.orgId };
    }
    if (migration.status === "applying" || migration.status === "revising") {
      const scheduled = await set(
        scheduleMigration$,
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
  },
);

// This preview decision/write phase has no cancellation checkpoint. The root
// owns the original pre-phase check; confirmation owns the post-claim check.
const claimPreviewedMigration$ = command(
  async (
    { set },
    migration: MigrationRow & { readonly rowVersion: string },
    orgId: string,
    ownerIds: readonly string[],
  ): Promise<
    | { readonly status: "ready"; readonly migration: MigrationRow }
    | { readonly status: "expired" }
    | { readonly status: "owners_changed" }
    | { readonly status: "conflict" }
  > => {
    const db = set(writeDb$);
    // Every transition below is conditional on the previewed state it
    // was decided from; zero rows is a deterministic conflict.
    const previewedMigration = and(
      eq(usagePackSubscriptionMigrations.id, migration.id),
      eq(usagePackSubscriptionMigrations.orgId, orgId),
      eq(usagePackSubscriptionMigrations.status, "previewed"),
      migrationRowVersionIs(migration.rowVersion),
    );
    const selections = await db
      .select()
      .from(usagePackSubscriptionMigrationSelections)
      .where(
        eq(usagePackSubscriptionMigrationSelections.migrationId, migration.id),
      );
    if (!paidOwnersStillPresent(selections, ownerIds)) {
      const completedAt = nowDate();
      const [failed] = await db
        .update(usagePackSubscriptionMigrations)
        .set({
          status: "failed",
          failureReason: "owners_changed",
          completedAt,
          updatedAt: completedAt,
        })
        .where(previewedMigration)
        .returning({ id: usagePackSubscriptionMigrations.id });
      return failed
        ? { status: "owners_changed" as const }
        : { status: "conflict" as const };
    }
    if (migration.previewExpiresAt <= nowDate()) {
      const completedAt = nowDate();
      const [expired] = await db
        .update(usagePackSubscriptionMigrations)
        .set({
          status: "failed",
          failureReason: "preview_expired",
          completedAt,
          updatedAt: completedAt,
        })
        .where(previewedMigration)
        .returning({ id: usagePackSubscriptionMigrations.id });
      return expired
        ? { status: "expired" as const }
        : { status: "conflict" as const };
    }
    const [claimed] = await db
      .update(usagePackSubscriptionMigrations)
      .set({ status: "applying", updatedAt: nowDate() })
      .where(previewedMigration)
      .returning();
    if (!claimed) {
      return { status: "conflict" as const };
    }
    return { status: "ready" as const, migration: claimed };
  },
);

const claimMigrationConfirmation$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly migrationId: string;
      readonly ownerIds: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly status: "ready"; readonly migration: MigrationRow }
    | { readonly status: "not_found" }
    | { readonly status: "expired" }
    | { readonly status: "owners_changed" }
    | { readonly status: "conflict" }
  > => {
    const db = set(writeDb$);
    const [migration] = await db
      .select(migrationColumnsWithRowVersion())
      .from(usagePackSubscriptionMigrations)
      .where(
        and(
          eq(usagePackSubscriptionMigrations.id, args.migrationId),
          eq(usagePackSubscriptionMigrations.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!migration) {
      return { status: "not_found" as const };
    }
    if (migration.status === "completed" || migration.status === "failed") {
      return { status: "conflict" as const };
    }
    if (migration.status === "previewed") {
      return await set(
        claimPreviewedMigration$,
        migration,
        args.orgId,
        args.ownerIds,
      );
    }
    return { status: "ready" as const, migration };
  },
);

export const confirmUsagePackSubscriptionMigration$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly migrationId: string;
      readonly ownerIds: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<MigrationConfirmResult> => {
    const claimed = await set(claimMigrationConfirmation$, args, signal);
    signal.throwIfAborted();
    if (claimed.status !== "ready") {
      return claimed;
    }
    signal.throwIfAborted();
    const result = await set(
      reconcileMigration$,
      { migration: claimed.migration },
      signal,
    );
    if (result.status === "failed") {
      return { status: "conflict" };
    }
    return { status: "confirmed", response: result.response };
  },
);

export const handleUsagePackMigrationInvoicePaid$ = command(
  async (
    { set },
    invoice: UsagePackInvoiceInput,
    signal: AbortSignal,
  ): Promise<UsagePackMigrationLifecycleOutcome> => {
    const db = set(writeDb$);
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
    signal.throwIfAborted();
    if (!migration) {
      return { handled: false, orgId: null };
    }
    const currentInvoice = await retrieveMigrationInvoice(invoice.id);
    signal.throwIfAborted();
    if (migration.stripeInvoiceId !== currentInvoice.id) {
      const selections: readonly MigrationSelectionRow[] = await db
        .select()
        .from(usagePackSubscriptionMigrationSelections)
        .where(
          eq(
            usagePackSubscriptionMigrationSelections.migrationId,
            migration.id,
          ),
        );
      signal.throwIfAborted();
      if (
        !migrationInvoiceMatchesSelections(
          currentInvoice,
          migration,
          selections,
        )
      ) {
        return { handled: false, orgId: null };
      }
    }
    if (migration.status === "completed") {
      const root = await set(readMigrationSubscriptionRoot$, migration);
      signal.throwIfAborted();
      if (!root) {
        throw new Error(
          `Completed usage pack migration ${migration.id} lost correlation`,
        );
      }
      const outcome = await set(
        handleUsagePackInvoicePaid$,
        correlatedMigrationInvoice(currentInvoice, migration, root.id),
        signal,
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
    signal.throwIfAborted();
    const result = await set(
      reconcileMigration$,
      { migration: updated ?? migration, eventInvoice: currentInvoice },
      signal,
    );
    return { handled: true, orgId: result.orgId };
  },
);

export const handleUsagePackMigrationSubscriptionUpdated$ = command(
  async (
    { set },
    subscription: UsagePackSubscriptionInput,
    signal: AbortSignal,
  ): Promise<UsagePackMigrationLifecycleOutcome> => {
    const db = set(writeDb$);
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
    signal.throwIfAborted();
    if (!migration) {
      return { handled: false, orgId: null };
    }
    if (migration.status === "completed") {
      const current = await getStripeClient().subscriptions.retrieve(
        migration.stripeSubscriptionId,
      );
      signal.throwIfAborted();
      const outcome = await set(
        handleUsagePackSubscriptionUpdated$,
        current as UsagePackSubscriptionInput,
      );
      signal.throwIfAborted();
      if (!outcome.handled) {
        throw new Error(
          `Completed usage pack migration ${migration.id} lost correlation`,
        );
      }
      return { handled: true, orgId: migration.orgId };
    }
    const result = await set(reconcileMigration$, { migration }, signal);
    return { handled: result.status !== "failed", orgId: result.orgId };
  },
);

export const reconcileUsagePackSubscriptionMigrations$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<{
    readonly reconciled: number;
    readonly orgIds: readonly string[];
  }> => {
    const db = set(writeDb$);
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
        set(reconcileMigration$, { migration: candidate }, signal),
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
  },
);
