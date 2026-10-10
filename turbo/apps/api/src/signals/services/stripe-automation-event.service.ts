import {
  stripeInvoiceBillingReasonSchema,
  stripeInvoicePaidEventConfigSchema,
  type StripeInvoiceBillingReason,
  type StripeInvoicePaidEventConfig,
} from "@okouai/api-contracts/contracts/workflows";
import type {
  StripeAutomationEventSnapshot,
  StripeAutomationEventSnapshotLine,
  StripeAutomationEventSnapshotMetadata,
} from "@okouai/db/jsonb-contracts/stripe-automation-event";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { variables } from "@okouai/db/schema/variable";
import {
  stripeWorkflowAutomationHealth,
  stripeWorkflowDeliveries,
} from "@okouai/db/schema/stripe-automation-event";
import {
  workflowAutomations,
  workflows,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import {
  builtinConnectorCredentialConnectionFromRow,
  builtinConnectorCredentialConnectionReadPlan,
  builtinConnectorVariableValuesFromRows,
} from "./builtin-connector-credential-runtime.service";
import {
  stripeInvoicePaidFeatureReadPlan,
  stripeInvoicePaidFeatureEnabledFromRows,
} from "./stripe-invoice-paid-workflow-automation-feature-switch.service";
import {
  repairMissingStripeInvoicePaidAutomationProjection,
  stripeBindingConnectionReadiness,
  stripeLiveBindingMatches,
  stripeLiveModeValuesPlan,
} from "./stripe-invoice-paid-workflow-automation.service";
import { workflowAutomationCanFire$ } from "./workflow-automation-access.service";
import { storedWorkflowAutomationContext } from "./workflow-automation-context.service";
import type { AutomationRow } from "./workflow-automation-enqueue.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import {
  StripeDeliveryClaimChangedError,
  StripeDeliveryTargetChangedError,
} from "./workflow-stripe-queue.service";
import {
  connectorCatalogCurrentWhere,
  connectorRuntimeAuthSelectionFromRows,
  connectorRuntimeAuthSelectionReadPlan,
  type ConnectorRuntimeAuthSelection,
  connectorRuntimeSlugSelectionFromRows,
  connectorRuntimeSlugSelectionReadPlan,
} from "./connector-catalog-slug-source.service";

const log = logger("api:stripe-automation-event");

const STRIPE_DELIVERY_BATCH_SIZE = 25;
const STRIPE_DELIVERY_CLAIM_MS = 300_000;
const STRIPE_DELIVERY_RETRY_BASE_MS = 60_000;
const STRIPE_DELIVERY_RETRY_MAX_MS = 21_600_000;
const STRIPE_DELIVERY_RETRY_CUTOFF_MS = 259_200_000;

const stripeEventTypeSchema = z.object({
  type: z.string().trim().min(1).max(255),
});
const stripeEventModeSchema = z.object({ livemode: z.boolean() });
const stripeUnixTimestampSchema = z
  .number()
  .int()
  .nonnegative()
  .max(8_640_000_000_000);

const stripeSupportedEventBaseSchema = z
  .object({
    id: z.string().trim().min(1).max(255),
    type: z.enum(["invoice.paid", "account.application.deauthorized"]),
    account: z.string().trim().min(1).max(255).optional(),
    livemode: z.boolean(),
    created: stripeUnixTimestampSchema,
  })
  .passthrough();

const nullableIdentifierObjectSchema = z
  .object({ id: z.string().trim().min(1).max(255) })
  .passthrough();

const stripeIdentifierValueSchema = z.union([
  z.string(),
  nullableIdentifierObjectSchema,
]);

function optionalStripeSnapshotField<T>(schema: z.ZodType<T>) {
  // Optional Stripe expansions must not invalidate an otherwise usable invoice.
  const nullableSchema = schema.nullable();
  return z
    .preprocess((value) => {
      const parsed = nullableSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    }, nullableSchema)
    .optional();
}

const stripeCustomerSchema = z
  .object({
    id: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
  })
  .passthrough();

const stripeCustomerValueSchema = z.union([z.string(), stripeCustomerSchema]);

const stripeLinePriceSchema = z
  .object({
    id: z.string().nullable().optional(),
    product: optionalStripeSnapshotField(stripeIdentifierValueSchema),
    currency: z.string().nullable().optional(),
    unit_amount: z.number().nullable().optional(),
    recurring: z
      .object({ interval: z.string().nullable().optional() })
      .nullable()
      .optional(),
  })
  .passthrough();

const stripeLinePricingSchema = z
  .object({
    type: z.string().nullable().optional(),
    price_details: z
      .object({
        price: optionalStripeSnapshotField(stripeIdentifierValueSchema),
        product: optionalStripeSnapshotField(stripeIdentifierValueSchema),
      })
      .nullable()
      .optional(),
    unit_amount_decimal: z.string().nullable().optional(),
  })
  .passthrough();

const stripeInvoiceParentSchema = z
  .object({
    subscription_details: z
      .object({
        subscription: optionalStripeSnapshotField(stripeIdentifierValueSchema),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

const stripeInvoicePaymentRelationshipSchema = z
  .object({
    payment_intent: optionalStripeSnapshotField(stripeIdentifierValueSchema),
    charge: optionalStripeSnapshotField(stripeIdentifierValueSchema),
    payment_record: optionalStripeSnapshotField(stripeIdentifierValueSchema),
  })
  .passthrough();

const stripeInvoicePaymentValueSchema = z.union([
  stripeIdentifierValueSchema,
  stripeInvoicePaymentRelationshipSchema,
]);

const stripeInvoicePaymentsSchema = z
  .object({
    data: z.array(
      z
        .object({
          id: z.string().trim().min(1).max(255).nullable().optional(),
          payment: optionalStripeSnapshotField(stripeInvoicePaymentValueSchema),
          payment_intent: optionalStripeSnapshotField(
            stripeIdentifierValueSchema,
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const stripeInvoiceLineSchema = z
  .object({
    id: z.string().nullable().optional(),
    object: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    quantity: z.number().nullable().optional(),
    amount: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    period: z
      .object({
        start: stripeUnixTimestampSchema.nullable().optional(),
        end: stripeUnixTimestampSchema.nullable().optional(),
      })
      .nullable()
      .optional(),
    price: optionalStripeSnapshotField(stripeLinePriceSchema),
    pricing: optionalStripeSnapshotField(stripeLinePricingSchema),
  })
  .passthrough();

const stripeInvoiceSchema = z
  .object({
    id: z.string().trim().min(1).max(255),
    object: z.literal("invoice"),
    status: z.string().nullable().optional(),
    billing_reason: z.string().nullable().optional(),
    amount_paid: z.number().nullable().optional(),
    amount_due: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
    collection_method: z.string().nullable().optional(),
    hosted_invoice_url: z.string().nullable().optional(),
    invoice_pdf: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    lines: z.object({
      data: z.array(stripeInvoiceLineSchema),
      has_more: z.boolean(),
      total_count: z.number().int().nonnegative().nullable().optional(),
    }),
    customer: optionalStripeSnapshotField(stripeCustomerValueSchema),
    subscription: optionalStripeSnapshotField(stripeIdentifierValueSchema),
    payment_intent: optionalStripeSnapshotField(stripeIdentifierValueSchema),
    payments: optionalStripeSnapshotField(stripeInvoicePaymentsSchema),
    parent: optionalStripeSnapshotField(stripeInvoiceParentSchema),
  })
  .passthrough();

const stripeInvoicePaidEventBaseSchema = stripeSupportedEventBaseSchema.extend({
  type: z.literal("invoice.paid"),
  data: z.object({ object: stripeInvoiceSchema }).passthrough(),
});

const stripeInvoicePaidEventSchema = stripeInvoicePaidEventBaseSchema.extend({
  account: z.string().trim().min(1).max(255),
  livemode: z.literal(true),
});

const stripeDeauthorizedEventBaseSchema = stripeSupportedEventBaseSchema.extend(
  {
    type: z.literal("account.application.deauthorized"),
    data: z.object({ object: z.unknown() }).passthrough(),
  },
);

const stripeDeauthorizedEventSchema = stripeDeauthorizedEventBaseSchema.extend({
  account: z.string().trim().min(1).max(255),
  livemode: z.literal(true),
});

type StripeWorkflowDeliveryRow = typeof stripeWorkflowDeliveries.$inferSelect;

type DispatchStripeAutomationEventResult =
  | {
      readonly kind: "ok";
      readonly eventKind: "test" | "ignored" | "deauthorized" | "invoice";
      readonly queued: number;
      readonly duplicates: number;
    }
  | { readonly kind: "bad_request" };

type StripeDeliveryTarget = {
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
};

type StripeDeliveryValidation =
  | { readonly kind: "ok"; readonly target: StripeDeliveryTarget }
  | { readonly kind: "skip"; readonly reason: string };

interface ExecuteDueStripeAutomationEventsResult {
  readonly executed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly retried: number;
}

interface StripeInvoiceFanoutResult {
  readonly mappedConnectors: number;
  readonly candidates: number;
  readonly matched: number;
  readonly filtered: number;
  readonly queued: number;
  readonly duplicates: number;
}

interface StripeAutomationOwner {
  readonly automationId: string;
  readonly orgId: string;
  readonly userId: string;
}

function identifier(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  const parsed = nullableIdentifierObjectSchema.safeParse(value);
  return parsed.success ? parsed.data.id : null;
}

function unixSecondsToIso(value: number | null | undefined): string | null {
  return value === null || value === undefined
    ? null
    : new Date(value * 1000).toISOString();
}

function normalizeMetadata(
  metadata: Record<string, string> | undefined,
): StripeAutomationEventSnapshotMetadata {
  return metadata ?? {};
}

function normalizeLine(
  line: z.infer<typeof stripeInvoiceLineSchema>,
): StripeAutomationEventSnapshotLine {
  const price = stripeLinePriceSchema.safeParse(line.price);
  const pricing = stripeLinePricingSchema.safeParse(line.pricing);
  return {
    id: line.id ?? null,
    type: line.object ?? null,
    description: line.description ?? null,
    quantity: line.quantity ?? null,
    amount: line.amount ?? null,
    currency: line.currency ?? null,
    metadata: normalizeMetadata(line.metadata),
    period:
      line.period === null || line.period === undefined
        ? null
        : {
            start: unixSecondsToIso(line.period.start),
            end: unixSecondsToIso(line.period.end),
          },
    price: price.success
      ? {
          id: price.data.id ?? null,
          productId: identifier(price.data.product),
          currency: price.data.currency ?? null,
          unitAmount: price.data.unit_amount ?? null,
          recurringInterval: price.data.recurring?.interval ?? null,
        }
      : null,
    pricing: pricing.success
      ? {
          type: pricing.data.type ?? null,
          priceId: identifier(pricing.data.price_details?.price),
          productId: identifier(pricing.data.price_details?.product),
          unitAmountDecimal: pricing.data.unit_amount_decimal ?? null,
        }
      : null,
  };
}

function normalizeCustomer(
  value: unknown,
): StripeAutomationEventSnapshot["customer"] {
  if (typeof value === "string") {
    return { id: value, name: null, email: null };
  }
  const customer = stripeCustomerSchema.safeParse(value);
  return customer.success
    ? {
        id: customer.data.id ?? null,
        name: customer.data.name ?? null,
        email: customer.data.email ?? null,
      }
    : null;
}

function normalizePayments(value: unknown): {
  readonly paymentIds: readonly string[];
  readonly paymentIntentIds: readonly string[];
  readonly chargeIds: readonly string[];
  readonly paymentRecordIds: readonly string[];
} {
  const payments = stripeInvoicePaymentsSchema.safeParse(value);
  if (!payments.success) {
    return {
      paymentIds: [],
      paymentIntentIds: [],
      chargeIds: [],
      paymentRecordIds: [],
    };
  }
  const uniqueIds = (ids: readonly (string | null)[]): readonly string[] => {
    return [
      ...new Set(
        ids.filter((id): id is string => {
          return id !== null;
        }),
      ),
    ];
  };
  return {
    paymentIds: uniqueIds(
      payments.data.data.map((payment) => {
        return payment.id ?? identifier(payment.payment);
      }),
    ),
    paymentIntentIds: uniqueIds(
      payments.data.data.map((payment) => {
        const current = stripeInvoicePaymentRelationshipSchema.safeParse(
          payment.payment,
        );
        return identifier(
          current.success
            ? current.data.payment_intent
            : payment.payment_intent,
        );
      }),
    ),
    chargeIds: uniqueIds(
      payments.data.data.map((payment) => {
        const current = stripeInvoicePaymentRelationshipSchema.safeParse(
          payment.payment,
        );
        return identifier(current.success ? current.data.charge : null);
      }),
    ),
    paymentRecordIds: uniqueIds(
      payments.data.data.map((payment) => {
        const current = stripeInvoicePaymentRelationshipSchema.safeParse(
          payment.payment,
        );
        return identifier(current.success ? current.data.payment_record : null);
      }),
    ),
  };
}

function subscriptionId(
  invoice: z.infer<typeof stripeInvoiceSchema>,
): string | null {
  const current = stripeInvoiceParentSchema.safeParse(invoice.parent);
  return (
    identifier(
      current.success ? current.data.subscription_details?.subscription : null,
    ) ?? identifier(invoice.subscription)
  );
}

function invoiceSnapshot(
  event: z.infer<typeof stripeInvoicePaidEventSchema>,
): StripeAutomationEventSnapshot {
  const invoice = event.data.object;
  const payments = normalizePayments(invoice.payments);
  return {
    event: {
      id: event.id,
      type: "invoice.paid",
      createdAt: new Date(event.created * 1000).toISOString(),
      connectedAccountId: event.account,
      livemode: true,
    },
    invoice: {
      id: invoice.id,
      status: invoice.status ?? null,
      billingReason: invoice.billing_reason ?? null,
      amountPaid: invoice.amount_paid ?? null,
      amountDue: invoice.amount_due ?? null,
      currency: invoice.currency ?? null,
      collectionMethod: invoice.collection_method ?? null,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      invoicePdf: invoice.invoice_pdf ?? null,
      metadata: normalizeMetadata(invoice.metadata),
      lines: {
        data: invoice.lines.data.map(normalizeLine),
        hasMore: invoice.lines.has_more,
        totalCount: invoice.lines.total_count ?? null,
      },
    },
    customer: normalizeCustomer(invoice.customer),
    relationships: {
      subscriptionId: subscriptionId(invoice),
      paymentIntentId: identifier(invoice.payment_intent),
      paymentIds: payments.paymentIds,
      paymentIntentIds: payments.paymentIntentIds,
      chargeIds: payments.chargeIds,
      paymentRecordIds: payments.paymentRecordIds,
    },
  };
}

function knownBillingReason(
  value: string | null,
): StripeInvoiceBillingReason | null {
  const parsed = stripeInvoiceBillingReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function filterMatches(
  configured: readonly StripeInvoiceBillingReason[] | undefined,
  actual: StripeInvoiceBillingReason | null,
): boolean {
  if (configured === undefined || configured.length === 0) {
    return true;
  }
  return actual !== null && configured.includes(actual);
}

function eventMode(event: unknown): "live" | "test" | "unknown" {
  const parsed = stripeEventModeSchema.safeParse(event);
  if (!parsed.success) {
    return "unknown";
  }
  return parsed.data.livemode ? "live" : "test";
}

async function loadMissingStripeProjectionOwners(
  db: ReadonlyDb,
  accountId: string,
  signal: AbortSignal,
): Promise<readonly StripeAutomationOwner[]> {
  const owners = await db
    .selectDistinct({
      automationId: workflowAutomations.id,
      orgId: workflowAutomations.orgId,
      userId: workflowAutomations.ownerUserId,
    })
    .from(connectors)
    .innerJoin(
      workflowAutomations,
      and(
        eq(workflowAutomations.orgId, connectors.orgId),
        eq(workflowAutomations.ownerUserId, connectors.userId),
      ),
    )
    .where(
      and(
        eq(connectors.connectorSlug, "stripe"),
        eq(connectors.authMethod, "oauth"),
        eq(connectors.externalId, accountId),
        eq(workflowAutomations.kind, "event"),
        eq(workflowAutomations.eventType, "stripe-invoice-paid"),
        eq(workflowAutomations.enabled, true),
        isNull(workflowAutomations.eventConnectorId),
      ),
    )
    .orderBy(
      asc(workflowAutomations.orgId),
      asc(workflowAutomations.ownerUserId),
      asc(workflowAutomations.id),
    );
  signal.throwIfAborted();
  return owners;
}

async function repairMissingStripeIngressProjections(
  db: Db,
  accountId: string,
  signal: AbortSignal,
): Promise<void> {
  const owners = await loadMissingStripeProjectionOwners(db, accountId, signal);
  for (const owner of owners) {
    // No row lock: the repair publishes only while the automation is still
    // unbound (conditional UPDATE). A reprojection that binds it first wins;
    // one that commits afterward recomputes from current rows and overwrites.
    await repairMissingStripeInvoicePaidAutomationProjection(db, owner, signal);
    signal.throwIfAborted();
  }
}

function stripeMappedConnectorsReadPlan(accountId: string) {
  return {
    columns: { id: connectors.id },
    condition: and(
      eq(connectors.connectorSlug, "stripe"),
      eq(connectors.authMethod, "oauth"),
      eq(connectors.externalId, accountId),
    ),
    order: asc(connectors.id),
  };
}

function stripeFanoutCandidatesPlan(
  mappedConnectors: readonly { readonly id: string }[],
) {
  const connectorIds = mappedConnectors.map((connector) => {
    return connector.id;
  });
  return {
    columns: {
      automation: workflowAutomationColumns(),
      connectorId: connectors.id,
    },
    join: and(
      eq(workflowAutomations.orgId, connectors.orgId),
      eq(workflowAutomations.ownerUserId, connectors.userId),
    ),
    condition: and(
      eq(connectors.connectorSlug, "stripe"),
      eq(connectors.authMethod, "oauth"),
      inArray(connectors.id, connectorIds),
      eq(workflowAutomations.kind, "event"),
      eq(workflowAutomations.eventType, "stripe-invoice-paid"),
      eq(workflowAutomations.enabled, true),
    ),
    order: asc(workflowAutomations.id),
  };
}

interface StripeInvoiceFanoutCandidate {
  readonly automation: AutomationRow;
  readonly connectorId: string;
}

function stripeInvoiceFanoutConfig(
  row: StripeInvoiceFanoutCandidate,
  accountId: string,
) {
  const config = stripeInvoicePaidEventConfigSchema.safeParse(
    row.automation.eventConfig,
  );
  if (
    !config.success ||
    row.automation.eventConnectorId !== row.connectorId ||
    config.data.connectorId !== row.connectorId ||
    config.data.stripeAccountId !== accountId
  ) {
    return null;
  }
  return config.data;
}

function stripeFanoutConnectionPlan(
  row: StripeInvoiceFanoutCandidate,
  snapshot: ConnectorRuntimeAuthSelection,
) {
  const input = {
    snapshot,
    orgId: row.automation.orgId,
    userId: row.automation.ownerUserId,
    connectorSlug: "stripe",
    connectorId: row.connectorId,
  };
  return { ...builtinConnectorCredentialConnectionReadPlan(input), input };
}

function stripeFanoutFeaturePlan(row: StripeInvoiceFanoutCandidate) {
  const owner = {
    orgId: row.automation.orgId,
    userId: row.automation.ownerUserId,
  };
  return { ...stripeInvoicePaidFeatureReadPlan(owner), owner };
}

function stripeFanoutCatalogPlan() {
  return connectorRuntimeAuthSelectionReadPlan({ connectorSlugs: ["stripe"] });
}

function stripeFanoutCatalogFromRows(
  plan: ReturnType<typeof stripeFanoutCatalogPlan>,
  rows: Parameters<typeof connectorRuntimeAuthSelectionFromRows>[0],
) {
  return connectorRuntimeAuthSelectionFromRows(
    rows,
    plan.requestedConnectorSlugs,
    plan.firewallConnectorSlugs,
  );
}

function stripeConnectionFromRow(
  plan: ReturnType<typeof stripeFanoutConnectionPlan>,
  row: Parameters<typeof builtinConnectorCredentialConnectionFromRow>[1],
) {
  return builtinConnectorCredentialConnectionFromRow(plan.input, row);
}

function stripeMatchingHealthPlan(
  row: StripeInvoiceFanoutCandidate,
  receivedAt: Date,
) {
  const values = {
    lastMatchingEventReceivedAt: receivedAt,
    updatedAt: receivedAt,
  };
  return {
    values: { automationId: row.automation.id, ...values },
    conflict: {
      target: stripeWorkflowAutomationHealth.automationId,
      set: values,
    },
  };
}

function stripeInvoiceDeliveryValues(
  row: StripeInvoiceFanoutCandidate,
  snapshot: StripeAutomationEventSnapshot,
  receivedAt: Date,
) {
  return {
    automationId: row.automation.id,
    connectorId: row.connectorId,
    stripeAccountId: snapshot.event.connectedAccountId,
    livemode: true,
    stripeEventId: snapshot.event.id,
    stripeEventCreatedAt: new Date(snapshot.event.createdAt),
    billingReason: snapshot.invoice.billingReason,
    snapshot,
    nextAttemptAt: receivedAt,
    receivedAt,
    createdAt: receivedAt,
    updatedAt: receivedAt,
  };
}

function stripeLatestHealthPlan(
  row: StripeInvoiceFanoutCandidate,
  delivery: { readonly id: string },
  receivedAt: Date,
) {
  return {
    values: {
      latestDeliveryId: delivery.id,
      latestDeliveryStatus: "pending" as const,
      latestDeliveryStatusAt: receivedAt,
      updatedAt: receivedAt,
    },
    condition: eq(
      stripeWorkflowAutomationHealth.automationId,
      row.automation.id,
    ),
  };
}

function stripeFanoutResult(
  mappedConnectors: number,
  candidates: number,
  counts = { matched: 0, filtered: 0, queued: 0, duplicates: 0 },
): StripeInvoiceFanoutResult {
  return { mappedConnectors, candidates, ...counts };
}

const recordStripeInvoiceFanout$ = command(
  async (
    { set },
    event: z.infer<typeof stripeInvoicePaidEventSchema>,
    signal: AbortSignal,
  ): Promise<StripeInvoiceFanoutResult> => {
    const db = set(writeDb$);
    // Invoice arrays have no size bound; normalize them before opening the transaction.
    const snapshot = invoiceSnapshot(event);
    // Candidate locks, delivery receipts and their health writes commit together.
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0255; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      const accountId = snapshot.event.connectedAccountId;
      const mappedPlan = stripeMappedConnectorsReadPlan(accountId);
      const mappedConnectors = await tx
        .select(mappedPlan.columns)
        .from(connectors)
        .where(mappedPlan.condition)
        .orderBy(mappedPlan.order)
        .for("update");
      signal.throwIfAborted();
      if (mappedConnectors.length === 0) {
        return stripeFanoutResult(0, 0);
      }
      const candidatePlan = stripeFanoutCandidatesPlan(mappedConnectors);
      const rows = await tx
        .select(candidatePlan.columns)
        .from(connectors)
        .innerJoin(workflowAutomations, candidatePlan.join)
        .where(candidatePlan.condition)
        .orderBy(candidatePlan.order)
        .for("update", { of: workflowAutomations });
      signal.throwIfAborted();

      const counts = { matched: 0, filtered: 0, queued: 0, duplicates: 0 };
      const receivedAt = nowDate();
      const billingReason = knownBillingReason(snapshot.invoice.billingReason);
      for (const row of rows) {
        const config = stripeInvoiceFanoutConfig(row, accountId);
        if (config === null) {
          signal.throwIfAborted();
          continue;
        }
        const featurePlan = stripeFanoutFeaturePlan(row);
        const featureRows = await tx
          .select(featurePlan.columns)
          .from(userFeatureSwitches)
          .where(featurePlan.condition);
        if (
          !stripeInvoicePaidFeatureEnabledFromRows(
            featurePlan.owner,
            featureRows,
          )
        ) {
          signal.throwIfAborted();
          continue;
        }
        signal.throwIfAborted();

        const catalogPlan = stripeFanoutCatalogPlan();
        const catalogRows = await tx
          .select(catalogPlan.columns)
          .from(connectorCatalog)
          .leftJoin(connectorCatalogEntries, catalogPlan.join)
          .where(connectorCatalogCurrentWhere());
        // Materialization errors retain priority over the original abort barrier.
        const catalog = stripeFanoutCatalogFromRows(catalogPlan, catalogRows);
        signal.throwIfAborted();

        const connectionPlan = stripeFanoutConnectionPlan(row, catalog);
        const [connectionRow] = await tx
          .select(connectionPlan.columns)
          .from(connectors)
          .where(connectionPlan.condition)
          .limit(1);
        const loaded = stripeConnectionFromRow(connectionPlan, connectionRow);
        signal.throwIfAborted();
        const ready = stripeBindingConnectionReadiness(loaded);
        if (ready.kind !== "ok") {
          continue;
        }

        const valuesPlan = stripeLiveModeValuesPlan(ready.connection);
        const valueRows =
          valuesPlan === null
            ? []
            : await tx
                .select(valuesPlan.secretColumns)
                .from(secrets)
                .where(valuesPlan.secretCondition)
                .unionAll(
                  tx
                    .select(valuesPlan.variableColumns)
                    .from(variables)
                    .where(valuesPlan.variableCondition),
                );
        const values = builtinConnectorVariableValuesFromRows(valueRows);
        signal.throwIfAborted();
        if (!stripeLiveBindingMatches(ready, config, values)) {
          continue;
        }
        counts.matched += 1;

        const matchingHealth = stripeMatchingHealthPlan(row, receivedAt);
        await tx
          .insert(stripeWorkflowAutomationHealth)
          .values(matchingHealth.values)
          .onConflictDoUpdate(matchingHealth.conflict);
        signal.throwIfAborted();

        if (!filterMatches(config.billingReasons, billingReason)) {
          counts.filtered += 1;
          continue;
        }
        const [delivery] = await tx
          .insert(stripeWorkflowDeliveries)
          .values(stripeInvoiceDeliveryValues(row, snapshot, receivedAt))
          .onConflictDoNothing()
          .returning({ id: stripeWorkflowDeliveries.id });
        signal.throwIfAborted();
        if (!delivery) {
          counts.duplicates += 1;
          continue;
        }
        const latestHealth = stripeLatestHealthPlan(row, delivery, receivedAt);
        await tx
          .update(stripeWorkflowAutomationHealth)
          .set(latestHealth.values)
          .where(latestHealth.condition);
        signal.throwIfAborted();
        counts.queued += 1;
      }
      return stripeFanoutResult(mappedConnectors.length, rows.length, counts);
    });
  },
);

const dispatchStripeDeauthorization$ = command(
  async (
    { set },
    event: unknown,
    signal: AbortSignal,
  ): Promise<DispatchStripeAutomationEventResult> => {
    const db = set(writeDb$);
    const supported = stripeDeauthorizedEventBaseSchema.safeParse(event);
    if (!supported.success) {
      log.debug("Processed Stripe workflow ingress", {
        eventType: "account.application.deauthorized",
        mode: eventMode(event),
        outcome: "malformed",
      });
      return { kind: "bad_request" };
    }
    if (!supported.data.livemode) {
      log.debug("Processed Stripe workflow ingress", {
        eventType: "account.application.deauthorized",
        mode: "test",
        outcome: "dropped",
      });
      return { kind: "ok", eventKind: "test", queued: 0, duplicates: 0 };
    }
    const parsed = stripeDeauthorizedEventSchema.safeParse(event);
    if (!parsed.success) {
      log.debug("Processed Stripe workflow ingress", {
        eventType: "account.application.deauthorized",
        mode: "live",
        outcome: "malformed",
      });
      return { kind: "bad_request" };
    }
    signal.throwIfAborted();
    const updated = await db
      .update(connectors)
      .set({
        needsReconnect: true,
        reconnectReason: "authorization_expired_or_revoked",
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(connectors.connectorSlug, "stripe"),
          eq(connectors.authMethod, "oauth"),
          eq(connectors.externalId, parsed.data.account),
        ),
      )
      .returning({ id: connectors.id });
    signal.throwIfAborted();
    log.debug("Processed Stripe workflow ingress", {
      eventType: "account.application.deauthorized",
      mode: "live",
      outcome: "deauthorized",
      deauthorizedConnectors: updated.length,
    });
    return {
      kind: "ok",
      eventKind: "deauthorized",
      queued: 0,
      duplicates: 0,
    };
  },
);

export const dispatchStripeAutomationEvent$ = command(
  async (
    { set },
    event: unknown,
    signal: AbortSignal,
  ): Promise<DispatchStripeAutomationEventResult> => {
    const eventType = stripeEventTypeSchema.safeParse(event);
    if (!eventType.success) {
      log.debug("Processed Stripe workflow ingress", {
        eventType: "unknown",
        mode: eventMode(event),
        outcome: "malformed",
      });
      return { kind: "bad_request" };
    }
    if (
      eventType.data.type !== "invoice.paid" &&
      eventType.data.type !== "account.application.deauthorized"
    ) {
      log.debug("Processed Stripe workflow ingress", {
        eventType: eventType.data.type,
        mode: eventMode(event),
        outcome: "unsupported",
      });
      return {
        kind: "ok",
        eventKind: "ignored",
        queued: 0,
        duplicates: 0,
      };
    }

    if (eventType.data.type === "account.application.deauthorized") {
      return await set(dispatchStripeDeauthorization$, event, signal);
    }
    const db = set(writeDb$);
    const supported = stripeInvoicePaidEventBaseSchema.safeParse(event);
    if (!supported.success) {
      log.debug("Processed Stripe workflow ingress", {
        eventType: "invoice.paid",
        mode: eventMode(event),
        outcome: "malformed",
      });
      return { kind: "bad_request" };
    }
    if (!supported.data.livemode) {
      log.debug("Processed Stripe workflow ingress", {
        eventType: "invoice.paid",
        mode: "test",
        outcome: "dropped",
      });
      return { kind: "ok", eventKind: "test", queued: 0, duplicates: 0 };
    }
    const parsed = stripeInvoicePaidEventSchema.safeParse(event);
    if (!parsed.success) {
      log.debug("Processed Stripe workflow ingress", {
        eventType: "invoice.paid",
        mode: "live",
        outcome: "malformed",
      });
      return { kind: "bad_request" };
    }
    await repairMissingStripeIngressProjections(
      db,
      parsed.data.account,
      signal,
    );
    signal.throwIfAborted();
    const fanout = await set(recordStripeInvoiceFanout$, parsed.data, signal);
    signal.throwIfAborted();
    log.debug("Processed Stripe workflow ingress", {
      eventType: "invoice.paid",
      mode: "live",
      outcome: "accepted",
      ...fanout,
    });
    return { kind: "ok", eventKind: "invoice", ...fanout };
  },
);

function deliveryClaimCondition(delivery: StripeWorkflowDeliveryRow) {
  return and(
    eq(stripeWorkflowDeliveries.id, delivery.id),
    eq(stripeWorkflowDeliveries.status, "pending"),
    eq(stripeWorkflowDeliveries.revision, delivery.revision),
  );
}

const claimDueDelivery$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<StripeWorkflowDeliveryRow | null> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const currentTime = nowDate();
    // Scalar candidate reads keep the update on one primary key, while the CTE
    // preserves the ordered SKIP LOCKED pick and revision fence.
    const due = db.$with("due_stripe_delivery").as(
      db
        .select({
          id: stripeWorkflowDeliveries.id,
          revision: stripeWorkflowDeliveries.revision,
        })
        .from(stripeWorkflowDeliveries)
        .where(
          and(
            eq(stripeWorkflowDeliveries.status, "pending"),
            lte(stripeWorkflowDeliveries.nextAttemptAt, currentTime),
            or(
              isNull(stripeWorkflowDeliveries.claimExpiresAt),
              lte(stripeWorkflowDeliveries.claimExpiresAt, currentTime),
            ),
          ),
        )
        .orderBy(
          asc(stripeWorkflowDeliveries.nextAttemptAt),
          asc(stripeWorkflowDeliveries.id),
        )
        .limit(1)
        .for("update", { skipLocked: true }),
    );
    const [claimed] = await db
      .with(due)
      .update(stripeWorkflowDeliveries)
      .set({
        attempts: sql`${stripeWorkflowDeliveries.attempts} + 1`,
        revision: sql`${stripeWorkflowDeliveries.revision} + 1`,
        claimExpiresAt: new Date(
          currentTime.getTime() + STRIPE_DELIVERY_CLAIM_MS,
        ),
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(stripeWorkflowDeliveries.id, db.select({ id: due.id }).from(due)),
          eq(stripeWorkflowDeliveries.status, "pending"),
          eq(
            stripeWorkflowDeliveries.revision,
            db.select({ revision: due.revision }).from(due),
          ),
        ),
      )
      .returning();
    signal.throwIfAborted();
    return claimed ?? null;
  },
);

const stripeDeliveryBindingMatches$ = command(
  async (
    { get },
    args: {
      readonly eventConfig: StripeInvoicePaidEventConfig;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = get(db$);
    const catalogPlan = connectorRuntimeAuthSelectionReadPlan({
      connectorSlugs: ["stripe"],
    });
    const catalogRows = await db
      .select(catalogPlan.columns)
      .from(connectorCatalog)
      .leftJoin(connectorCatalogEntries, catalogPlan.join)
      .where(connectorCatalogCurrentWhere());
    if (signal.aborted) {
      // Keep catalog materialization errors ahead of cancellation.
      connectorRuntimeAuthSelectionFromRows(
        catalogRows,
        catalogPlan.requestedConnectorSlugs,
        catalogPlan.firewallConnectorSlugs,
      );
      signal.throwIfAborted();
    }
    const snapshot = connectorRuntimeAuthSelectionFromRows(
      catalogRows,
      catalogPlan.requestedConnectorSlugs,
      catalogPlan.firewallConnectorSlugs,
    );
    signal.throwIfAborted();
    const connectionInput = {
      snapshot,
      orgId: args.orgId,
      userId: args.userId,
      connectorSlug: "stripe",
      connectorId: args.eventConfig.connectorId,
    };
    const connectionPlan =
      builtinConnectorCredentialConnectionReadPlan(connectionInput);
    const [connectionRow] = await db
      .select(connectionPlan.columns)
      .from(connectors)
      .where(connectionPlan.condition)
      .limit(1);
    if (signal.aborted) {
      // Keep stored credential decoding ahead of cancellation.
      builtinConnectorCredentialConnectionFromRow(
        connectionInput,
        connectionRow,
      );
      signal.throwIfAborted();
    }
    const loaded = builtinConnectorCredentialConnectionFromRow(
      connectionInput,
      connectionRow,
    );
    signal.throwIfAborted();
    const ready = stripeBindingConnectionReadiness(loaded);
    if (ready.kind !== "ok") {
      return false;
    }
    const valuesPlan = stripeLiveModeValuesPlan(ready.connection);
    const valueRows =
      valuesPlan === null
        ? []
        : await db
            .select(valuesPlan.secretColumns)
            .from(secrets)
            .where(valuesPlan.secretCondition)
            .unionAll(
              db
                .select(valuesPlan.variableColumns)
                .from(variables)
                .where(valuesPlan.variableCondition),
            );
    const values = builtinConnectorVariableValuesFromRows(valueRows);
    signal.throwIfAborted();
    return stripeLiveBindingMatches(ready, args.eventConfig, values);
  },
);

const loadStripeDeliveryTarget$ = command(
  async (
    { get, set },
    delivery: StripeWorkflowDeliveryRow,
    signal: AbortSignal,
  ): Promise<StripeDeliveryValidation> => {
    const db = get(db$);
    const [row] = await db
      .select({
        automation: workflowAutomationColumns(),
        agentId: workflows.agentId,
        workflowName: workflows.name,
        chatThreadId: workflowUserAutomationThreads.chatThreadId,
        connectorId: connectors.id,
        connectorNeedsReconnect: connectors.needsReconnect,
        connectorExternalId: connectors.externalId,
      })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
      .leftJoin(
        workflowUserAutomationThreads,
        and(
          eq(workflowUserAutomationThreads.orgId, workflowAutomations.orgId),
          eq(
            workflowUserAutomationThreads.userId,
            workflowAutomations.ownerUserId,
          ),
          eq(
            workflowUserAutomationThreads.workflowId,
            workflowAutomations.workflowId,
          ),
        ),
      )
      .leftJoin(
        connectors,
        and(
          eq(connectors.id, delivery.connectorId),
          eq(connectors.orgId, workflowAutomations.orgId),
          eq(connectors.userId, workflowAutomations.ownerUserId),
          eq(connectors.connectorSlug, "stripe"),
          eq(connectors.authMethod, "oauth"),
        ),
      )
      .where(eq(workflowAutomations.id, delivery.automationId))
      .limit(1);
    signal.throwIfAborted();
    if (!row || !row.chatThreadId || !row.connectorId) {
      return { kind: "skip", reason: "automation_target_unavailable" };
    }
    const config = stripeInvoicePaidEventConfigSchema.safeParse(
      row.automation.eventConfig,
    );
    const billingReason = knownBillingReason(delivery.billingReason);
    if (
      !config.success ||
      row.automation.kind !== "event" ||
      row.automation.eventType !== "stripe-invoice-paid" ||
      !row.automation.enabled ||
      !delivery.livemode ||
      row.automation.eventConnectorId !== delivery.connectorId ||
      config.data.connectorId !== delivery.connectorId ||
      config.data.stripeAccountId !== delivery.stripeAccountId ||
      row.connectorExternalId !== delivery.stripeAccountId ||
      row.connectorNeedsReconnect ||
      !filterMatches(config.data.billingReasons, billingReason)
    ) {
      return { kind: "skip", reason: "automation_no_longer_matches" };
    }
    const owner = {
      orgId: row.automation.orgId,
      userId: row.automation.ownerUserId,
    };
    const featurePlan = stripeInvoicePaidFeatureReadPlan(owner);
    const featureRows = await db
      .select(featurePlan.columns)
      .from(userFeatureSwitches)
      .where(featurePlan.condition);
    if (signal.aborted) {
      // The former reader evaluated feature rows before its abort barrier.
      stripeInvoicePaidFeatureEnabledFromRows(owner, featureRows);
      signal.throwIfAborted();
    }
    if (!stripeInvoicePaidFeatureEnabledFromRows(owner, featureRows)) {
      signal.throwIfAborted();
      return { kind: "skip", reason: "feature_disabled" };
    }
    signal.throwIfAborted();
    const bindingMatches = await set(
      stripeDeliveryBindingMatches$,
      { ...owner, eventConfig: config.data },
      signal,
    );
    if (!bindingMatches) {
      return { kind: "skip", reason: "connector_unavailable" };
    }
    return {
      kind: "ok",
      target: {
        automation: row.automation,
        agentId: row.agentId,
        workflowName: row.workflowName,
        chatThreadId: row.chatThreadId,
      },
    };
  },
);

const loadStripeDeliveryRuntimeSelection$ = command(
  async ({ get }, signal: AbortSignal) => {
    const db = get(db$);
    const plan = connectorRuntimeSlugSelectionReadPlan({
      connectorSlugs: ["stripe"],
    });
    const rows = await db
      .select(plan.columns)
      .from(connectorCatalog)
      .leftJoin(connectorCatalogEntries, plan.join)
      .where(connectorCatalogCurrentWhere());
    if (signal.aborted) {
      // Keep catalog decode and identity failures ahead of cancellation.
      connectorRuntimeSlugSelectionFromRows(plan.selection, rows);
      signal.throwIfAborted();
    }
    const snapshot = connectorRuntimeSlugSelectionFromRows(
      plan.selection,
      rows,
    );
    signal.throwIfAborted();
    return snapshot;
  },
);

async function repairMissingStripeDeliveryProjection(
  db: Db,
  delivery: StripeWorkflowDeliveryRow,
  signal: AbortSignal,
): Promise<void> {
  const [owner] = await db
    .select({
      orgId: workflowAutomations.orgId,
      userId: workflowAutomations.ownerUserId,
      eventConnectorId: workflowAutomations.eventConnectorId,
      eventType: workflowAutomations.eventType,
    })
    .from(workflowAutomations)
    .where(eq(workflowAutomations.id, delivery.automationId))
    .limit(1);
  signal.throwIfAborted();
  if (
    !owner ||
    owner.eventType !== "stripe-invoice-paid" ||
    owner.eventConnectorId !== null
  ) {
    return;
  }
  // No row lock: the repair publishes only while the automation is still
  // unbound (conditional UPDATE); see repairMissingStripeIngressProjections.
  await repairMissingStripeInvoicePaidAutomationProjection(
    db,
    {
      automationId: delivery.automationId,
      orgId: owner.orgId,
      userId: owner.userId,
    },
    signal,
  );
  signal.throwIfAborted();
}

const finishDelivery$ = command(
  async (
    { set },
    args: {
      readonly delivery: StripeWorkflowDeliveryRow;
      readonly status: "skipped" | "failed";
      readonly reason: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    // Fence the terminal outcome and commit its health together, delivery first.
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0257; new non-billing transactions are prohibited.
    const finished = await set(writeDb$).transaction(async (tx) => {
      const currentTime = nowDate();
      const [updated] = await tx
        .update(stripeWorkflowDeliveries)
        .set({
          status: args.status,
          claimExpiresAt: null,
          lastError: args.status === "failed" ? args.reason : null,
          skipReason: args.status === "skipped" ? args.reason : null,
          skippedAt: args.status === "skipped" ? currentTime : null,
          failedAt: args.status === "failed" ? currentTime : null,
          updatedAt: currentTime,
        })
        .where(deliveryClaimCondition(args.delivery))
        .returning({ id: stripeWorkflowDeliveries.id });
      signal.throwIfAborted();
      if (!updated) {
        return false;
      }
      await tx
        .update(stripeWorkflowAutomationHealth)
        .set({
          latestDeliveryStatus: args.status,
          latestDeliveryStatusAt: currentTime,
          updatedAt: currentTime,
        })
        .where(
          and(
            eq(
              stripeWorkflowAutomationHealth.automationId,
              args.delivery.automationId,
            ),
            eq(
              stripeWorkflowAutomationHealth.latestDeliveryId,
              args.delivery.id,
            ),
          ),
        );
      signal.throwIfAborted();
      return true;
    });
    signal.throwIfAborted();
    return finished;
  },
);

function retryDelayMs(attempts: number): number {
  return Math.min(
    STRIPE_DELIVERY_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    STRIPE_DELIVERY_RETRY_MAX_MS,
  );
}

function logDeliveryOutcome(args: {
  readonly delivery: StripeWorkflowDeliveryRow;
  readonly status: "pending" | "delivered" | "skipped" | "failed";
  readonly reasonCategory: string;
}): void {
  log.debug("Processed Stripe workflow delivery", {
    deliveryId: args.delivery.id,
    automationId: args.delivery.automationId,
    status: args.status,
    attempt: args.delivery.attempts,
    reasonCategory: args.reasonCategory,
  });
}

const retryDelivery$ = command(
  async (
    { set },
    delivery: StripeWorkflowDeliveryRow,
    signal: AbortSignal,
  ): Promise<"retried" | "failed" | "lost"> => {
    signal.throwIfAborted();
    const currentTime = nowDate();
    if (
      currentTime.getTime() - delivery.receivedAt.getTime() >=
      STRIPE_DELIVERY_RETRY_CUTOFF_MS
    ) {
      const failed = await set(
        finishDelivery$,
        {
          delivery,
          status: "failed",
          reason: "retry_window_exhausted",
        },
        signal,
      );
      if (failed) {
        logDeliveryOutcome({
          delivery,
          status: "failed",
          reasonCategory: "retry_window_exhausted",
        });
        return "failed";
      }
      return "lost";
    }
    const [updated] = await set(writeDb$)
      .update(stripeWorkflowDeliveries)
      .set({
        claimExpiresAt: null,
        nextAttemptAt: new Date(
          currentTime.getTime() + retryDelayMs(delivery.attempts),
        ),
        lastError: "transient_delivery_error",
        revision: delivery.revision + 1,
        updatedAt: currentTime,
      })
      .where(deliveryClaimCondition(delivery))
      .returning({ id: stripeWorkflowDeliveries.id });
    signal.throwIfAborted();
    if (!updated) {
      return "lost";
    }
    logDeliveryOutcome({
      delivery,
      status: "pending",
      reasonCategory: "transient_delivery_error",
    });
    return "retried";
  },
);

function deliveryContext(args: {
  readonly delivery: StripeWorkflowDeliveryRow;
  readonly target: StripeDeliveryTarget;
}) {
  return storedWorkflowAutomationContext({
    workflowName: args.target.workflowName,
    eventType: "stripe-invoice-paid",
    eventPayload: {
      automationId: args.target.automation.id,
      deliveryId: args.delivery.id,
      ...args.delivery.snapshot,
    },
  });
}

const processClaimedDelivery$ = command(
  async (
    { set },
    args: { readonly delivery: StripeWorkflowDeliveryRow },
    signal: AbortSignal,
  ): Promise<"executed" | "skipped" | "failed" | "retried" | "lost"> => {
    const db = set(writeDb$);
    await repairMissingStripeDeliveryProjection(db, args.delivery, signal);
    const prepared = await set(
      loadStripeDeliveryTarget$,
      args.delivery,
      signal,
    );
    const validation: StripeDeliveryValidation =
      prepared.kind === "ok" &&
      !(await set(
        workflowAutomationCanFire$,
        {
          automation: prepared.target.automation,
          agentId: prepared.target.agentId,
        },
        signal,
      ))
        ? { kind: "skip", reason: "automation_access_revoked" }
        : prepared;
    if (validation.kind === "skip") {
      const skipped = await set(
        finishDelivery$,
        {
          delivery: args.delivery,
          status: "skipped",
          reason: validation.reason,
        },
        signal,
      );
      if (skipped) {
        logDeliveryOutcome({
          delivery: args.delivery,
          status: "skipped",
          reasonCategory: validation.reason,
        });
        return "skipped";
      }
      return "lost";
    }
    const target = validation.target;
    const snapshot = await set(loadStripeDeliveryRuntimeSelection$, signal);
    const started = await settle(
      set(
        runWorkflowAutomationNow$,
        {
          due: {
            automation: target.automation,
            agentId: target.agentId,
            chatThreadId: target.chatThreadId,
          },
          automationContext: deliveryContext({
            delivery: args.delivery,
            target,
          }),
          connectorSourceId: args.delivery.connectorId,
          apiStartTime: now(),
          triggerSource: "automation-event",
          triggerBrief: `Stripe invoice paid: ${args.delivery.snapshot.invoice.id}`,
          replacePendingScheduleTick: false,
          sourcePlan: {
            kind: "stripe",
            source: {
              id: args.delivery.id,
              revision: args.delivery.revision,
              automationId: args.delivery.automationId,
              connectorId: args.delivery.connectorId,
              stripeAccountId: args.delivery.stripeAccountId,
              livemode: args.delivery.livemode,
              billingReason: args.delivery.billingReason,
              orgId: target.automation.orgId,
              userId: target.automation.ownerUserId,
            },
            snapshot,
          },
        },
        signal,
      ),
      signal,
    );
    if (started.ok) {
      // A conflict or immediate run error is observed only after durable queue
      // admission, where the queue command already marked this delivery.
      logDeliveryOutcome({
        delivery: args.delivery,
        status: "delivered",
        reasonCategory: "queue_admitted",
      });
      return "executed";
    }
    if (started.error instanceof StripeDeliveryClaimChangedError) {
      return "lost";
    }
    if (started.error instanceof StripeDeliveryTargetChangedError) {
      const skipped = await set(
        finishDelivery$,
        {
          delivery: args.delivery,
          status: "skipped",
          reason: started.error.reason,
        },
        signal,
      );
      if (skipped) {
        logDeliveryOutcome({
          delivery: args.delivery,
          status: "skipped",
          reasonCategory: started.error.reason,
        });
        return "skipped";
      }
      return "lost";
    }
    return await set(retryDelivery$, args.delivery, signal);
  },
);

export const executeDueStripeAutomationEvents$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<ExecuteDueStripeAutomationEventsResult> => {
    const result = {
      executed: 0,
      skipped: 0,
      failed: 0,
      retried: 0,
    };
    for (let index = 0; index < STRIPE_DELIVERY_BATCH_SIZE; index += 1) {
      const delivery = await set(claimDueDelivery$, signal);
      signal.throwIfAborted();
      if (!delivery) {
        break;
      }
      const processed = await settle(
        set(processClaimedDelivery$, { delivery }, signal),
        signal,
      );
      if (!processed.ok) {
        log.error("Stripe workflow delivery processing failed", {
          deliveryId: delivery.id,
          automationId: delivery.automationId,
          attempt: delivery.attempts,
          category: "unexpected",
        });
        const retry = await set(retryDelivery$, delivery, signal);
        if (retry === "retried") {
          result.retried += 1;
        } else if (retry === "failed") {
          result.failed += 1;
        }
        continue;
      }
      if (processed.value !== "lost") {
        result[processed.value] += 1;
      }
    }
    log.debug("Executed due Stripe workflow deliveries", result);
    return result;
  },
);
