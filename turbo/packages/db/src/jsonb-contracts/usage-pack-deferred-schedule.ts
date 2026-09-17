/** Immutable Stripe request shared by all attempts at one deferred change. */
export interface UsagePackDeferredSchedule {
  readonly scheduleId: string;
  readonly effectiveAt: number;
  readonly params: {
    readonly end_behavior?: "cancel" | "none" | "release" | "renew";
    readonly proration_behavior?:
      | "always_invoice"
      | "create_prorations"
      | "none";
    readonly phases?: UsagePackDeferredSchedulePhase[];
  };
}

interface UsagePackDeferredSchedulePhase {
  readonly start_date?: number;
  readonly end_date?: number;
  readonly duration?: {
    readonly interval: "day" | "week" | "month" | "year";
    readonly interval_count: number;
  };
  readonly currency?: string;
  readonly items: {
    readonly price: string;
    readonly quantity?: number;
    readonly discounts?: UsagePackDeferredScheduleDiscount[];
    readonly metadata?: Record<string, string | number | null>;
    readonly tax_rates?: string[];
  }[];
  readonly metadata?: Record<string, string | number | null>;
  readonly proration_behavior?: "always_invoice" | "create_prorations" | "none";
  readonly discounts?: UsagePackDeferredScheduleDiscount[];
}

type UsagePackDeferredScheduleDiscount =
  | { readonly coupon: string }
  | { readonly discount: string }
  | { readonly promotion_code: string };
