import type { UsagePackDeferredSchedule } from "@okouai/db/jsonb-contracts/usage-pack-deferred-schedule";
import type {
  StripeMetadataParam,
  StripePriceRecurring,
  StripeScheduleDiscount,
  StripeSchedulePhase,
  StripeSchedulePhaseDiscountParam,
  StripeSchedulePhaseItemParam,
  StripeSchedulePhaseParam,
  StripeSubscriptionSchedule,
} from "../external/stripe-client";

function referenceId(
  value: string | { readonly id: string } | null,
): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function metadataMatches(
  actual: Readonly<Record<string, string>> | null | undefined,
  expected: StripeMetadataParam | undefined,
): boolean {
  return Object.entries(expected ?? {}).every(([key, value]) => {
    return value === null || value === ""
      ? !actual?.[key]
      : actual?.[key] === String(value);
  });
}

function discountsMatch(
  actual: readonly StripeScheduleDiscount[] | null | undefined,
  expected: readonly StripeSchedulePhaseDiscountParam[] | undefined,
): boolean {
  return (
    !expected ||
    (actual?.length === expected.length &&
      expected.every((discount, index) => {
        const current = actual[index];
        if (!current) {
          return false;
        }
        if ("discount" in discount) {
          return referenceId(current.discount ?? null) === discount.discount;
        }
        if ("coupon" in discount) {
          return referenceId(current.coupon ?? null) === discount.coupon;
        }
        return (
          referenceId(current.promotion_code ?? null) ===
          discount.promotion_code
        );
      }))
  );
}

function itemsMatch(
  actual: StripeSchedulePhase["items"],
  expected: readonly StripeSchedulePhaseItemParam[],
): boolean {
  return (
    actual?.length === expected.length &&
    expected.every((item) => {
      const matches = actual.filter((candidate) => {
        return referenceId(candidate.price) === item.price;
      });
      const current = matches[0];
      return (
        matches.length === 1 &&
        current !== undefined &&
        (current.quantity ?? 1) === (item.quantity ?? 1) &&
        metadataMatches(current.metadata, item.metadata) &&
        discountsMatch(current.discounts, item.discounts) &&
        (!item.tax_rates ||
          (current.tax_rates?.length === item.tax_rates.length &&
            item.tax_rates.every((rate) => {
              return current.tax_rates?.some((value) => {
                return referenceId(value) === rate;
              });
            })))
      );
    })
  );
}

function recurringEnd(start: number, duration: StripePriceRecurring): number {
  const end = new Date(start * 1000);
  if (duration.interval === "day" || duration.interval === "week") {
    end.setUTCDate(
      end.getUTCDate() +
        duration.interval_count * (duration.interval === "week" ? 7 : 1),
    );
  } else {
    const day = end.getUTCDate();
    end.setUTCDate(1);
    end.setUTCMonth(
      end.getUTCMonth() +
        duration.interval_count * (duration.interval === "year" ? 12 : 1),
    );
    const monthEnd = new Date(end);
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
    monthEnd.setUTCDate(0);
    end.setUTCDate(Math.min(day, monthEnd.getUTCDate()));
  }
  return Math.floor(end.getTime() / 1000);
}

function phaseEnd(phase: StripeSchedulePhaseParam): number | undefined {
  return (
    phase.end_date ??
    (phase.start_date !== undefined && phase.duration
      ? recurringEnd(phase.start_date, phase.duration)
      : undefined)
  );
}

/** Compare Stripe's expanded/defaulted response with the original write intent. */
export function deferredScheduleMatchesRequest(
  schedule: StripeSubscriptionSchedule,
  request: UsagePackDeferredSchedule,
): boolean {
  if (
    schedule.id !== request.scheduleId ||
    schedule.end_behavior !== request.params.end_behavior ||
    !schedule.current_phase ||
    !request.params.phases?.length
  ) {
    return false;
  }
  const currentStart = schedule.current_phase.start_date;
  const expected = request.params.phases.filter((phase) => {
    const end = phaseEnd(phase);
    return end !== undefined && end > currentStart;
  });
  const actual = schedule.phases.filter((phase) => {
    return phase.end_date > currentStart;
  });
  return (
    expected.length > 0 &&
    expected.length === actual.length &&
    expected.every((phase, index) => {
      const current = actual[index];
      return (
        current !== undefined &&
        current.start_date === phase.start_date &&
        current.end_date === phaseEnd(phase) &&
        (current.add_invoice_items?.length ?? 0) === 0 &&
        (!phase.currency || current.currency === phase.currency) &&
        (!phase.proration_behavior ||
          (current.proration_behavior ?? "none") ===
            phase.proration_behavior) &&
        itemsMatch(current.items, phase.items) &&
        metadataMatches(current.metadata, phase.metadata) &&
        discountsMatch(current.discounts, phase.discounts)
      );
    })
  );
}
