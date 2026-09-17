import StripeSDK from "stripe";
import { env } from "../../lib/env";
import { testOverride } from "../../lib/singleton";

/**
 * Stripe gateway. This module is the only place `stripe` is resolved: it
 * belongs to `tsconfig.gateways.json`, so the SDK declaration surface is parsed
 * once in that small program instead of inside the core one, which is what sets
 * the CI peak RSS for apps/api (same move as `@aws-sdk/*` in PR #25714).
 *
 * Everything exported below is an application-owned type; that is what keeps the emitted
 * `.d.ts` free of Stripe types. The mirrors cover exactly the fields callers
 * read and the params they send - widening them is fine, naming a Stripe type
 * in an exported signature is not.
 */

/** Stripe expands a reference either to an id string or to the object. */
export type StripeRef = string | { readonly id: string } | null;

export type StripeMetadataParam = Record<string, string | number | null>;

export interface StripeProduct {
  readonly id: string;
  readonly name: string;
  readonly metadata: Record<string, string>;
  readonly tax_code?: StripeRef;
}

export interface StripeDeletedProduct {
  readonly id: string;
  readonly deleted: true;
}

/** Stripe returns a deleted stub instead of the product once it is removed. */
export type StripeProductRef = string | StripeProduct | StripeDeletedProduct;

export interface StripePriceRecurring {
  readonly interval: "day" | "month" | "week" | "year";
  readonly interval_count: number;
}

export interface StripePrice {
  readonly id: string;
  readonly active: boolean;
  readonly currency?: string;
  readonly type: "one_time" | "recurring";
  readonly unit_amount: number | null;
  readonly metadata?: Record<string, string> | null;
  readonly recurring: StripePriceRecurring | null;
  readonly tax_behavior?: "exclusive" | "inclusive" | "unspecified" | null;
  readonly product: StripeProductRef;
}

export interface StripeSubscriptionItem {
  readonly id: string;
  readonly price: StripePrice;
  readonly quantity?: number;
  readonly current_period_start: number;
  readonly current_period_end: number;
}

export interface StripeSubscription {
  readonly id: string;
  readonly customer: string | { readonly id: string };
  readonly status: string;
  readonly metadata?: Record<string, string> | null;
  readonly trial_end?: number | null;
  readonly cancel_at?: number | null;
  readonly cancel_at_period_end: boolean;
  readonly schedule?: StripeRef;
  readonly discounts?: readonly StripeRef[];
  readonly default_payment_method?: StripeRef;
  readonly default_source?: StripeRef;
  readonly latest_invoice: string | StripeInvoice | null;
  readonly pending_update?: {
    readonly expires_at: number;
    readonly subscription_items?: readonly StripeSubscriptionItem[] | null;
  } | null;
  readonly items: { readonly data: readonly StripeSubscriptionItem[] };
}

export interface StripeSubscriptionPreviousAttributes {
  readonly trial_end?: number | null;
  readonly cancel_at?: number | null;
  readonly cancel_at_period_end?: boolean;
  readonly schedule?: StripeRef;
}

export interface StripeSchedulePhase {
  readonly start_date: number;
  readonly end_date: number;
  readonly add_invoice_items?: readonly unknown[];
  readonly currency?: string | null;
  readonly metadata?: Record<string, string> | null;
  readonly proration_behavior?:
    | "always_invoice"
    | "create_prorations"
    | "none"
    | null;
  readonly items?: readonly {
    readonly price: StripeRef;
    readonly quantity?: number;
    readonly discounts?: readonly StripeScheduleDiscount[] | null;
    readonly metadata?: Record<string, string> | null;
    readonly tax_rates?: readonly StripeRef[] | null;
  }[];
  readonly discounts?: readonly StripeScheduleDiscount[] | null;
}

export interface StripeScheduleDiscount {
  readonly coupon?: StripeRef;
  readonly discount?: StripeRef;
  readonly promotion_code?: StripeRef;
}

export interface StripeSubscriptionSchedule {
  readonly id: string;
  readonly end_behavior?: string;
  readonly current_phase?: StripeSchedulePhase | null;
  readonly phases: readonly StripeSchedulePhase[];
}

export interface StripeSchedulePhaseItemParam {
  readonly price: string;
  readonly quantity?: number;
  readonly discounts?: StripeSchedulePhaseDiscountParam[];
  readonly metadata?: StripeMetadataParam;
  readonly tax_rates?: string[];
}

export type StripeSchedulePhaseDiscountParam =
  | { readonly coupon: string }
  | { readonly discount: string }
  | { readonly promotion_code: string };

export interface StripeSchedulePhaseParam {
  readonly start_date?: number;
  readonly end_date?: number;
  readonly duration?: StripePriceRecurring;
  readonly currency?: string;
  readonly items: StripeSchedulePhaseItemParam[];
  readonly metadata?: StripeMetadataParam;
  readonly proration_behavior?: "always_invoice" | "create_prorations" | "none";
  readonly discounts?: StripeSchedulePhaseDiscountParam[];
}

export interface StripeSubscriptionScheduleUpdateParams {
  readonly end_behavior?: "cancel" | "none" | "release" | "renew";
  readonly proration_behavior?: "always_invoice" | "create_prorations" | "none";
  readonly phases?: StripeSchedulePhaseParam[];
}

export interface StripeRequestOptions {
  readonly idempotencyKey?: string;
}

export interface StripeSubscriptionUpdateItemParam {
  readonly id?: string;
  readonly price?: string;
  readonly quantity?: number;
  readonly deleted?: boolean;
}

export interface StripeSubscriptionUpdateParams {
  readonly billing_cycle_anchor?: "unchanged";
  readonly cancel_at?: number | null;
  readonly cancel_at_period_end?: boolean;
  readonly metadata?: StripeMetadataParam;
  readonly default_payment_method?: string;
  readonly default_source?: string;
  readonly items?: StripeSubscriptionUpdateItemParam[];
  readonly payment_behavior?:
    | "allow_incomplete"
    | "error_if_incomplete"
    | "pending_if_incomplete";
  readonly proration_behavior?: "always_invoice" | "create_prorations" | "none";
  readonly proration_date?: number;
  readonly expand?: string[];
}

export interface StripeSubscriptionCreateParams {
  readonly customer: string;
  readonly items: {
    readonly price: string;
    readonly quantity?: number;
  }[];
  readonly default_payment_method?: string;
  readonly default_source?: string;
  readonly metadata: StripeMetadataParam;
  readonly payment_behavior: "default_incomplete";
  readonly trial_period_days?: number;
  readonly expand?: string[];
}

export interface StripeCustomer {
  readonly id: string;
  /**
   * Mirrors Stripe's own `deleted?: void` marker so that
   * `if (customer.deleted)` still narrows this union for callers.
   */
  readonly deleted?: void;
  readonly metadata: Record<string, string>;
  readonly discount?: {
    readonly source: { readonly coupon: StripeRef };
  } | null;
  readonly invoice_settings?: {
    readonly default_payment_method?: StripeRef;
  } | null;
  readonly default_source?: StripeRef;
}

export interface StripeDeletedCustomer {
  readonly id: string;
  readonly deleted: true;
}

/** Stripe returns a deleted stub instead of the customer once it is removed. */
export type StripeCustomerRef = StripeCustomer | StripeDeletedCustomer;

export interface StripePaymentMethod {
  readonly id: string;
  readonly type: string;
  readonly customer?: StripeRef;
}

export interface StripePaymentIntent {
  readonly id: string;
  readonly customer?: StripeRef;
  readonly payment_method?: StripeRef;
  readonly metadata?: Record<string, string> | null;
  readonly status: string;
  readonly amount_received: number;
  readonly currency: string;
}

export interface StripeRefund {
  readonly id: string;
  readonly status: string | null;
  readonly failure_reason?: string | null;
  readonly amount: number;
  readonly payment_intent: StripeRef;
  readonly metadata: Record<string, string> | null;
}

export interface StripeCreditNote {
  readonly id: string;
  readonly status: "issued" | "void";
  readonly metadata?: Record<string, string> | null;
  readonly pre_payment_amount: number;
  readonly post_payment_amount: number;
  readonly refunds: readonly {
    readonly amount_refunded: number;
    readonly refund: string | StripeRefund;
  }[];
}

export interface StripeCreditNoteLineParam {
  readonly type: "invoice_line_item";
  readonly invoice_line_item: string;
  readonly amount: number;
}

export interface StripeCreditNoteParams {
  readonly invoice: string;
  readonly amount?: number;
  readonly lines?: StripeCreditNoteLineParam[];
  readonly refund_amount?: number;
  readonly refunds?: {
    readonly refund: string;
    readonly amount_refunded?: number;
  }[];
  readonly email_type?: "credit_note" | "none";
  readonly metadata?: StripeMetadataParam;
  readonly reason?:
    | "duplicate"
    | "fraudulent"
    | "order_change"
    | "product_unsatisfactory";
}

export interface StripeInvoiceLine {
  readonly id?: string;
  readonly amount: number;
  readonly discount_amounts?: readonly { readonly amount: number }[] | null;
  readonly subtotal?: number | null;
  readonly metadata?: Record<string, string> | null;
  readonly quantity?: number | null;
  readonly price?: { readonly id: string } | null;
  readonly pricing?: {
    readonly price_details?: {
      readonly price?: StripeRef;
    } | null;
  } | null;
  readonly proration?: boolean;
  readonly taxes?:
    | readonly {
        readonly amount: number;
        readonly tax_behavior: "exclusive" | "inclusive";
        readonly tax_rate_details?: {
          readonly tax_rate: string;
        } | null;
      }[]
    | null;
  readonly period: { readonly start: number; readonly end: number };
  readonly parent: {
    readonly type: "subscription_item_details" | "invoice_item_details";
    readonly subscription_item_details?: {
      readonly proration: boolean;
      readonly proration_details?: {
        readonly credited_items?: unknown;
      } | null;
    } | null;
    readonly invoice_item_details?: {
      readonly proration: boolean;
      readonly proration_details?: {
        readonly credited_items?: unknown;
      } | null;
    } | null;
  } | null;
}

export interface StripeInvoice {
  readonly id: string;
  readonly hosted_invoice_url?: string | null;
  readonly customer: StripeRef;
  readonly metadata: Record<string, string> | null;
  readonly automatic_tax?: {
    readonly enabled: boolean;
    readonly liability: {
      readonly type: "account" | "self";
      readonly account?: StripeRef;
    } | null;
  } | null;
  readonly amount_due: number;
  readonly amount_paid?: number;
  readonly currency: string;
  readonly status: "draft" | "open" | "paid" | "uncollectible" | "void" | null;
  readonly paid?: boolean;
  readonly payments?: {
    readonly data: readonly {
      readonly status: string;
      readonly amount_paid?: number | null;
      readonly payment: {
        readonly type: string;
        readonly payment_intent?: StripeRef;
      };
    }[];
  } | null;
  readonly status_transitions?: {
    readonly paid_at?: number | null;
  } | null;
  readonly subtotal?: number | null;
  readonly lines: {
    readonly data: readonly StripeInvoiceLine[];
    readonly has_more: boolean;
  };
  readonly parent: {
    readonly subscription_details: {
      readonly metadata?: Record<string, string> | null;
      readonly subscription: string | { readonly id: string };
    } | null;
  } | null;
}

export interface StripeCheckoutSession {
  readonly id: string;
  readonly url?: string | null;
  readonly status?: string | null;
  readonly mode?: string | null;
  readonly invoice?: StripeRef;
  readonly subscription: StripeRef;
  readonly customer: StripeRef;
  readonly metadata: Record<string, string> | null;
  readonly payment_intent?: StripeRef;
  readonly setup_intent?:
    | string
    | {
        readonly id: string;
        readonly payment_method?: StripeRef;
      }
    | null;
  readonly amount_subtotal?: number | null;
  readonly amount_total?: number | null;
  readonly payment_status?: string | null;
  readonly currency?: string | null;
  readonly expires_at?: number;
}

export interface StripeCoupon {
  readonly id: string;
  readonly valid?: boolean;
  readonly percent_off?: number | null;
  readonly amount_off?: number | null;
}

export interface StripeBillingPortalSession {
  readonly id: string;
  readonly url: string;
}

export interface StripeBillingPortalSessionCreateParams {
  readonly customer: string;
  readonly return_url: string;
  readonly configuration?: string;
  readonly flow_data?: {
    readonly type: "subscription_update_confirm";
    readonly after_completion?: {
      readonly type: "redirect";
      readonly redirect: { readonly return_url: string };
    };
    readonly subscription_update_confirm: {
      readonly subscription: string;
      readonly items: {
        readonly id: string;
        readonly quantity?: number;
      }[];
    };
  };
}

export interface StripeList<T> {
  readonly data: readonly T[];
  readonly has_more: boolean;
}

export type StripeSubscriptionListStatus =
  | "active"
  | "all"
  | "canceled"
  | "ended"
  | "incomplete"
  | "incomplete_expired"
  | "past_due"
  | "paused"
  | "trialing"
  | "unpaid";

export interface StripeSubscriptionListParams {
  readonly customer?: string;
  readonly status?: StripeSubscriptionListStatus;
  readonly price?: string;
  readonly expand?: string[];
}

export interface StripeSubscriptionsApi {
  create(
    params: StripeSubscriptionCreateParams,
    options?: StripeRequestOptions,
  ): Promise<StripeSubscription>;
  retrieve(
    id: string,
    params?: { expand?: string[] },
  ): Promise<StripeSubscription>;
  update(
    id: string,
    params: StripeSubscriptionUpdateParams,
    options?: StripeRequestOptions,
  ): Promise<StripeSubscription>;
  list(
    params: StripeSubscriptionListParams & {
      readonly limit?: number;
      readonly starting_after?: string;
    },
  ): Promise<StripeList<StripeSubscription>>;
  cancel(
    id: string,
    params?: { invoice_now?: boolean; prorate?: boolean },
    options?: StripeRequestOptions,
  ): Promise<StripeSubscription>;
}

export interface StripeSubscriptionSchedulesApi {
  retrieve(id: string): Promise<StripeSubscriptionSchedule>;
  create(
    params: {
      from_subscription: string;
    },
    options?: StripeRequestOptions,
  ): Promise<StripeSubscriptionSchedule>;
  update(
    id: string,
    params: StripeSubscriptionScheduleUpdateParams,
    options?: StripeRequestOptions,
  ): Promise<StripeSubscriptionSchedule>;
  release(
    id: string,
    params?: { readonly preserve_cancel_date?: boolean },
  ): Promise<StripeSubscriptionSchedule>;
}

export interface StripeCustomersApi {
  retrieve(id: string): Promise<StripeCustomerRef>;
  create(params: {
    metadata?: StripeMetadataParam;
    email?: string;
  }): Promise<StripeCustomer>;
  update(
    id: string,
    params: {
      metadata?: StripeMetadataParam;
      invoice_settings?: { default_payment_method?: string };
    },
  ): Promise<StripeCustomer>;
}

export interface StripePricesApi {
  retrieve(id: string, params?: { expand?: string[] }): Promise<StripePrice>;
}

export interface StripeCouponsApi {
  retrieve(id: string): Promise<StripeCoupon>;
}

export interface StripeInvoicesApi {
  list(params: {
    subscription?: string;
    customer?: string;
    status?: "draft" | "open" | "paid" | "uncollectible" | "void";
    limit?: number;
    starting_after?: string;
  }): Promise<StripeList<StripeInvoice>>;
  listLineItems(
    id: string,
    params?: { limit?: number; starting_after?: string },
  ): Promise<StripeList<StripeInvoiceLine>>;
  create(
    params: {
      customer: string;
      auto_advance?: boolean;
      automatic_tax?: StripeInvoiceAutomaticTaxParam;
      default_payment_method?: string;
      default_source?: string;
      discounts?: "" | { readonly coupon: string }[];
      metadata?: StripeMetadataParam;
    },
    options?: StripeRequestOptions,
  ): Promise<StripeInvoice>;
  del(
    id: string,
    params: Record<string, never>,
    options: StripeRequestOptions,
  ): Promise<{ readonly id: string; readonly deleted: true }>;
  finalizeInvoice(id: string): Promise<StripeInvoice>;
  finalizeInvoice(
    id: string,
    params: Record<string, never>,
    options: StripeRequestOptions,
  ): Promise<StripeInvoice>;
  pay(id: string): Promise<StripeInvoice>;
  pay(
    id: string,
    params: Record<string, never>,
    options: StripeRequestOptions,
  ): Promise<StripeInvoice>;
  retrieve(
    id: string,
    params?: { readonly expand?: readonly string[] },
  ): Promise<StripeInvoice>;
  createPreview(
    params: StripeInvoiceCreatePreviewParams,
  ): Promise<StripeInvoice>;
  voidInvoice(
    id: string,
    params?: Record<string, never>,
    options?: StripeRequestOptions,
  ): Promise<StripeInvoice>;
}

type StripeInvoicePreviewCancellationParams =
  | {
      readonly cancel_at?: never;
      readonly cancel_at_period_end?: boolean;
    }
  | {
      readonly cancel_at?: "" | number | "max_period_end" | "min_period_end";
      readonly cancel_at_period_end?: never;
    };

export interface StripeInvoiceCreatePreviewParams {
  readonly customer?: string;
  readonly subscription?: string;
  readonly schedule?: string;
  readonly preview_mode: "next" | "recurring";
  readonly discounts?: "" | { readonly coupon: string }[];
  readonly invoice_items?: {
    readonly price: string;
    readonly quantity: number;
    readonly metadata?: StripeMetadataParam;
  }[];
  readonly subscription_details?: StripeInvoicePreviewCancellationParams & {
    readonly items: StripeSubscriptionUpdateItemParam[];
    readonly proration_behavior?:
      | "always_invoice"
      | "create_prorations"
      | "none";
    readonly proration_date?: number;
  };
  readonly schedule_details?: {
    readonly end_behavior?: "cancel" | "release";
    readonly proration_behavior?:
      | "always_invoice"
      | "create_prorations"
      | "none";
    readonly phases?: StripeSchedulePhaseParam[];
  };
}

export interface StripeInvoiceItemsApi {
  create(
    params: {
      invoice?: string;
      customer: string;
      amount?: number;
      currency?: string;
      description?: string;
      discountable?: boolean;
      metadata?: StripeMetadataParam;
      period?: { readonly start: number; readonly end: number };
      pricing?: { readonly price: string };
      quantity?: number;
      subscription?: string;
      tax_behavior?: "exclusive" | "inclusive" | "unspecified";
      tax_code?: string;
      tax_rates?: string[];
    },
    options?: StripeRequestOptions,
  ): Promise<{ readonly id: string }>;
}

export interface StripeInvoiceAutomaticTaxParam {
  readonly enabled: true;
  readonly liability?:
    | { readonly type: "self" }
    | { readonly type: "account"; readonly account: string };
}

export interface StripeCheckoutSessionCreateParams {
  readonly mode: "payment" | "setup" | "subscription";
  readonly customer?: string;
  readonly currency?: string;
  readonly line_items?: {
    readonly price?: string;
    readonly price_data?: {
      readonly currency: string;
      readonly product: string;
      readonly unit_amount: number;
    };
    readonly quantity?: number;
  }[];
  readonly allow_promotion_codes?: boolean;
  readonly discounts?: { readonly coupon: string }[];
  readonly success_url?: string;
  readonly cancel_url?: string;
  readonly expires_at?: number;
  readonly metadata?: StripeMetadataParam;
  readonly subscription_data?: {
    readonly metadata?: StripeMetadataParam;
    readonly trial_period_days?: number;
  };
  readonly invoice_creation?: {
    readonly enabled: boolean;
    readonly invoice_data?: { readonly metadata?: StripeMetadataParam };
  };
  readonly payment_intent_data?: {
    readonly setup_future_usage?: "off_session" | "on_session";
    readonly metadata?: StripeMetadataParam;
  };
  readonly setup_intent_data?: { readonly metadata?: StripeMetadataParam };
}

export interface StripeCheckoutSessionsApi {
  create(
    params: StripeCheckoutSessionCreateParams,
    options?: StripeRequestOptions,
  ): Promise<StripeCheckoutSession>;
  retrieve(
    id: string,
    params?: { expand?: string[] },
  ): Promise<StripeCheckoutSession>;
  expire(id: string): Promise<StripeCheckoutSession>;
}

export interface StripeRefundsApi {
  list(params: {
    readonly payment_intent: string;
    readonly limit: number;
    readonly starting_after?: string;
  }): Promise<StripeList<StripeRefund>>;
  retrieve(id: string): Promise<StripeRefund>;
  create(
    params: {
      readonly payment_intent: string;
      readonly amount: number;
      readonly metadata?: StripeMetadataParam;
    },
    options?: StripeRequestOptions,
  ): Promise<StripeRefund>;
}

export interface StripeCreditNotesApi {
  list(params: {
    invoice: string;
    limit?: number;
    starting_after?: string;
  }): Promise<StripeList<StripeCreditNote>>;
  preview(params: StripeCreditNoteParams): Promise<StripeCreditNote>;
  create(
    params: StripeCreditNoteParams,
    options?: StripeRequestOptions,
  ): Promise<StripeCreditNote>;
  retrieve(id: string): Promise<StripeCreditNote>;
}

export interface StripePaymentMethodsApi {
  retrieve(id: string): Promise<StripePaymentMethod>;
  list(params: {
    customer: string;
    /** Only card payment methods are read today; widen when that changes. */
    type?: "card";
    limit?: number;
  }): Promise<StripeList<StripePaymentMethod>>;
}

export interface StripeBillingPortalApi {
  readonly sessions: {
    create(
      params: StripeBillingPortalSessionCreateParams,
    ): Promise<StripeBillingPortalSession>;
  };
}

export interface StripeClient {
  readonly subscriptions: StripeSubscriptionsApi;
  readonly subscriptionSchedules: StripeSubscriptionSchedulesApi;
  readonly customers: StripeCustomersApi;
  readonly prices: StripePricesApi;
  readonly coupons: StripeCouponsApi;
  readonly invoices: StripeInvoicesApi;
  readonly invoiceItems: StripeInvoiceItemsApi;
  readonly checkout: { readonly sessions: StripeCheckoutSessionsApi };
  readonly paymentMethods: StripePaymentMethodsApi;
  readonly refunds: StripeRefundsApi;
  readonly creditNotes: StripeCreditNotesApi;
  readonly billingPortal: StripeBillingPortalApi;
}

interface StripeListedInvoice {
  readonly id: string;
  readonly number: string | null;
  readonly created: number;
  readonly amount_paid: number;
  readonly status: string | null;
  readonly hosted_invoice_url: string | null;
  readonly invoice_pdf: string | null;
}

interface StripeInvoiceCreatedRange {
  readonly gte: number;
  readonly lt: number;
}

const {
  get: getMockedListInvoices,
  set: setMockedListInvoices,
  clear: clearMockedListInvoices,
} = testOverride<
  | ((
      customerId: string,
      created?: StripeInvoiceCreatedRange,
    ) => Promise<readonly StripeListedInvoice[]>)
  | undefined
>(() => {
  return undefined;
});

export async function listStripeInvoices(
  customerId: string,
  created?: StripeInvoiceCreatedRange,
): Promise<readonly StripeListedInvoice[]> {
  const mocked = getMockedListInvoices();
  if (mocked) {
    return await mocked(customerId, created);
  }

  const stripe = new StripeSDK(env("STRIPE_SECRET_KEY"));
  const result = await stripe.invoices.list({
    customer: customerId,
    limit: created ? 100 : 24,
    ...(created ? { created } : {}),
  });

  return result.data.map((inv) => {
    return {
      id: inv.id,
      number: inv.number ?? null,
      created: inv.created,
      amount_paid: inv.amount_paid,
      status: inv.status ?? null,
      hosted_invoice_url: inv.hosted_invoice_url ?? null,
      invoice_pdf: inv.invoice_pdf ?? null,
    };
  });
}

export function mockListStripeInvoices(
  fn: (
    customerId: string,
    created?: StripeInvoiceCreatedRange,
  ) => Promise<readonly StripeListedInvoice[]>,
): void {
  setMockedListInvoices(fn);
}

export function clearMockListStripeInvoices(): void {
  clearMockedListInvoices();
}

const { get: getMockedStripeClient, set: setMockedStripeClient } = testOverride<
  StripeSDK | undefined
>(() => {
  return undefined;
});

function stripeSdk(): StripeSDK {
  const mocked = getMockedStripeClient();
  if (mocked) {
    return mocked;
  }
  return new StripeSDK(env("STRIPE_SECRET_KEY"));
}

/**
 * Per-call Stripe SDK instantiation, narrowed to the application-owned client surface.
 *
 * In tests, override via `mockStripeClient(fakeSdk)` so the wrapper doesn't
 * construct a real Stripe client. (The centralized `vi.mock("stripe")` factory
 * in `__tests__/mocks.ts` doesn't compose with `new StripeSDK()` as a
 * constructor - vi.fn() isn't a real constructor - so we route through this
 * override instead.)
 */
export function getStripeClient(): StripeClient {
  return stripeSdk();
}

export async function listAllStripeSubscriptions(
  stripe: StripeClient,
  params: StripeSubscriptionListParams,
  signal?: AbortSignal,
): Promise<readonly StripeSubscription[]> {
  const subscriptions: StripeSubscription[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const page = await stripe.subscriptions.list({
      ...params,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    signal?.throwIfAborted();
    subscriptions.push(...page.data);
    if (!page.has_more) {
      return subscriptions;
    }
    const last = page.data.at(-1);
    if (!last) {
      throw new Error(
        "Stripe returned an empty subscription page with has_more",
      );
    }
    startingAfter = last.id;
  }
}

export function mockStripeClient(fakeSdk: unknown): void {
  setMockedStripeClient(fakeSdk as StripeSDK);
}

/**
 * Stripe's `Event` is a wide discriminated union, and narrowing it is the only
 * reason the webhook dispatcher would need the SDK types. The gateway does that
 * narrowing once and hands core an application-owned envelope instead.
 */
export type StripeWebhookEvent =
  | {
      readonly kind: "payment_intent.succeeded";
      readonly id: string;
      readonly type: string;
      readonly created: number;
      readonly object: StripePaymentIntent;
    }
  | {
      readonly kind: "checkout.session.paid";
      readonly id: string;
      readonly type: string;
      readonly created: number;
      readonly object: StripeCheckoutSession;
    }
  | {
      readonly kind: "checkout.session.failed";
      readonly id: string;
      readonly type: string;
      readonly created: number;
      readonly object: StripeCheckoutSession;
    }
  | {
      readonly kind: "invoice.paid";
      readonly id: string;
      readonly type: string;
      readonly created: number;
      readonly object: StripeInvoice;
    }
  | {
      readonly kind: "customer.subscription.created";
      readonly id: string;
      readonly type: string;
      readonly created: number;
      readonly object: StripeSubscription;
    }
  | {
      readonly kind: "customer.subscription.updated";
      readonly id: string;
      readonly type: string;
      readonly created: number;
      readonly object: StripeSubscription;
      readonly previousAttributes?: StripeSubscriptionPreviousAttributes;
    }
  | {
      readonly kind: "customer.subscription.deleted";
      readonly id: string;
      readonly type: string;
      readonly created: number;
      readonly object: StripeSubscription;
    }
  | {
      readonly kind: "subscription_schedule.released";
      readonly id: string;
      readonly type: string;
      readonly created: number;
      readonly object: StripeSubscriptionSchedule;
    }
  | {
      readonly kind: "subscription_schedule.ended";
      readonly id: string;
      readonly type: string;
      readonly created: number;
      readonly object: StripeSubscriptionSchedule;
    }
  | {
      readonly kind: "unhandled";
      readonly id: string;
      readonly type: string;
      readonly created: number;
    };

export interface UndeliveredStripePaidInvoice {
  readonly eventId: string;
  readonly created: number;
  readonly invoice: StripeInvoice;
}

export interface UndeliveredStripePaidCheckoutSession {
  readonly eventId: string;
  readonly eventType:
    | "checkout.session.completed"
    | "checkout.session.async_payment_succeeded";
  readonly created: number;
  readonly session: StripeCheckoutSession;
}

const PAID_CHECKOUT_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
] as const;

/**
 * Lists still-undelivered paid Checkout events, oldest first. Immediate
 * payments settle on `checkout.session.completed`; delayed methods settle on
 * `checkout.session.async_payment_succeeded`.
 */
export async function listUndeliveredStripePaidCheckoutSessions(
  signal: AbortSignal,
): Promise<readonly UndeliveredStripePaidCheckoutSession[]> {
  const stripe = stripeSdk();
  const sessions: UndeliveredStripePaidCheckoutSession[] = [];
  for (const type of PAID_CHECKOUT_EVENT_TYPES) {
    let startingAfter: string | undefined;
    while (true) {
      const page = await stripe.events.list({
        delivery_success: false,
        type,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      signal.throwIfAborted();
      for (const event of page.data) {
        if (
          event.type === "checkout.session.completed" ||
          event.type === "checkout.session.async_payment_succeeded"
        ) {
          sessions.push({
            eventId: event.id,
            eventType: event.type,
            created: event.created,
            session: event.data.object,
          });
        }
      }
      if (!page.has_more) {
        break;
      }
      const last = page.data.at(-1);
      if (!last) {
        throw new Error("Stripe returned an empty Event page with has_more");
      }
      startingAfter = last.id;
    }
  }
  return sessions.sort((left, right) => {
    return (
      left.created - right.created || left.eventId.localeCompare(right.eventId)
    );
  });
}

/**
 * Lists Stripe's still-undelivered `invoice.paid` events, oldest first.
 * Stripe retains Events for 30 days, which is substantially longer than the
 * hourly billing reconciliation interval. Keeping the SDK event union at
 * this gateway lets the billing service consume only application-owned invoice types.
 */
export async function listUndeliveredStripePaidInvoices(
  signal: AbortSignal,
): Promise<readonly UndeliveredStripePaidInvoice[]> {
  const stripe = stripeSdk();
  const invoices: UndeliveredStripePaidInvoice[] = [];
  let startingAfter: string | undefined;
  while (true) {
    const page = await stripe.events.list({
      delivery_success: false,
      type: "invoice.paid",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    signal.throwIfAborted();
    for (const event of page.data) {
      if (event.type === "invoice.paid") {
        invoices.push({
          eventId: event.id,
          created: event.created,
          invoice: event.data.object,
        });
      }
    }
    if (!page.has_more) {
      return invoices.sort((left, right) => {
        return (
          left.created - right.created ||
          left.eventId.localeCompare(right.eventId)
        );
      });
    }
    const last = page.data.at(-1);
    if (!last) {
      throw new Error("Stripe returned an empty Event page with has_more");
    }
    startingAfter = last.id;
  }
}

type StripeWebhookEventConstructor = (
  rawBody: string,
  signature: string,
  secret: string,
) => unknown;

const {
  get: getMockedStripeWebhookEventConstructor,
  set: setMockedStripeWebhookEventConstructor,
} = testOverride<StripeWebhookEventConstructor | undefined>(() => {
  return undefined;
});

/**
 * Raw event for the automation-event ingress, which zod-parses the payload
 * itself rather than branching on Stripe's union.
 */
export function constructStripeWebhookEvent(
  rawBody: string,
  signature: string,
  secret: string,
): unknown {
  const mocked = getMockedStripeWebhookEventConstructor();
  if (mocked) {
    return mocked(rawBody, signature, secret);
  }
  return stripeSdk().webhooks.constructEvent(rawBody, signature, secret);
}

export function mockStripeWebhookEventConstructor(
  constructor: StripeWebhookEventConstructor,
): void {
  setMockedStripeWebhookEventConstructor(constructor);
}

export function constructStripeBillingWebhookEvent(
  rawBody: string,
  signature: string,
  secret: string,
): StripeWebhookEvent {
  const event = stripeSdk().webhooks.constructEvent(rawBody, signature, secret);
  const envelope = { id: event.id, type: event.type, created: event.created };

  switch (event.type) {
    case "payment_intent.succeeded": {
      return {
        kind: "payment_intent.succeeded",
        ...envelope,
        object: event.data.object,
      };
    }
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      return {
        kind: "checkout.session.paid",
        ...envelope,
        object: event.data.object,
      };
    }
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired": {
      return {
        kind: "checkout.session.failed",
        ...envelope,
        object: event.data.object,
      };
    }
    case "invoice.paid": {
      return { kind: "invoice.paid", ...envelope, object: event.data.object };
    }
    case "customer.subscription.created": {
      return {
        kind: "customer.subscription.created",
        ...envelope,
        object: event.data.object,
      };
    }
    case "customer.subscription.updated": {
      return {
        kind: "customer.subscription.updated",
        ...envelope,
        object: event.data.object,
        previousAttributes: event.data.previous_attributes,
      };
    }
    case "customer.subscription.deleted": {
      return {
        kind: "customer.subscription.deleted",
        ...envelope,
        object: event.data.object,
      };
    }
    case "subscription_schedule.released": {
      return {
        kind: "subscription_schedule.released",
        ...envelope,
        object: event.data.object,
      };
    }
    case "subscription_schedule.canceled":
    case "subscription_schedule.aborted": {
      return {
        kind: "subscription_schedule.ended",
        ...envelope,
        object: event.data.object,
      };
    }
    default: {
      return { kind: "unhandled", ...envelope };
    }
  }
}

const PAYMENT_METHOD_PORTAL_CONFIGURATION_NAME = "Okou payment methods";
const PAYMENT_METHOD_PORTAL_CONFIGURATION_IDEMPOTENCY_KEY =
  "vm0-payment-method-portal-v1";
const PAYMENT_METHOD_PORTAL_METADATA = {
  managed_by: "vm0",
  purpose: "payment_method_management",
} as const;

function paymentMethodPortalFeatures(): StripeSDK.BillingPortal.ConfigurationCreateParams.Features {
  return {
    customer_update: { enabled: false },
    invoice_history: { enabled: false },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: false },
    subscription_update: { enabled: false },
  };
}

function isManagedPaymentMethodPortalConfiguration(
  configuration: StripeSDK.BillingPortal.Configuration,
): boolean {
  return (
    configuration.metadata?.managed_by ===
      PAYMENT_METHOD_PORTAL_METADATA.managed_by &&
    configuration.metadata.purpose === PAYMENT_METHOD_PORTAL_METADATA.purpose
  );
}

function isRestrictedPaymentMethodPortalConfiguration(
  configuration: StripeSDK.BillingPortal.Configuration,
): boolean {
  return (
    configuration.active &&
    !configuration.features.customer_update.enabled &&
    !configuration.features.invoice_history.enabled &&
    configuration.features.payment_method_update.enabled &&
    !configuration.features.subscription_cancel.enabled &&
    !configuration.features.subscription_update.enabled &&
    !configuration.login_page.enabled
  );
}

/**
 * Billing portal configurations are the one caller that reads the SDK's nested
 * feature flags, so the whole reconcile loop lives behind the boundary and
 * hands back just the configuration id.
 */
export async function ensurePaymentMethodPortalConfiguration(
  signal: AbortSignal,
): Promise<string> {
  const stripe = stripeSdk();
  const configurations = await stripe.billingPortal.configurations.list({
    limit: 100,
  });
  signal.throwIfAborted();

  const existing = configurations.data.find(
    isManagedPaymentMethodPortalConfiguration,
  );
  if (!existing) {
    const created = await stripe.billingPortal.configurations.create(
      {
        name: PAYMENT_METHOD_PORTAL_CONFIGURATION_NAME,
        features: paymentMethodPortalFeatures(),
        login_page: { enabled: false },
        metadata: PAYMENT_METHOD_PORTAL_METADATA,
      },
      { idempotencyKey: PAYMENT_METHOD_PORTAL_CONFIGURATION_IDEMPOTENCY_KEY },
    );
    signal.throwIfAborted();
    return created.id;
  }

  if (isRestrictedPaymentMethodPortalConfiguration(existing)) {
    return existing.id;
  }

  const updated = await stripe.billingPortal.configurations.update(
    existing.id,
    {
      active: true,
      name: PAYMENT_METHOD_PORTAL_CONFIGURATION_NAME,
      features: paymentMethodPortalFeatures(),
      login_page: { enabled: false },
      metadata: PAYMENT_METHOD_PORTAL_METADATA,
    },
  );
  signal.throwIfAborted();
  return updated.id;
}

export interface StripeErrorInfo {
  readonly type: string;
  readonly code: string | null;
  readonly message: string;
}

/** Reports Stripe API failures without exposing the SDK error classes. */
export function stripeErrorInfo(error: unknown): StripeErrorInfo | null {
  if (!(error instanceof StripeSDK.errors.StripeError)) {
    return null;
  }
  return {
    type: error.type,
    code: error.code ?? null,
    message: error.message,
  };
}

/**
 * Raises the same `resource_missing` failure Stripe itself would raise, so a
 * campaign that drifted out of configuration is reported to callers exactly
 * like a deleted Stripe resource.
 */
export function stripeResourceMissingError(message: string): Error {
  return new StripeSDK.errors.StripeInvalidRequestError({
    type: "invalid_request_error",
    code: "resource_missing",
    message,
  });
}

/** `resource_missing` is the only Stripe error code callers branch on. */
export function isStripeResourceMissingError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as {
    readonly code?: unknown;
    readonly raw?: { readonly code?: unknown };
  };
  return (
    candidate.code === "resource_missing" ||
    candidate.raw?.code === "resource_missing"
  );
}
