import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";

type SubscriptionUsage = NonNullable<
  ModelProviderResponse["subscriptionUsage"]
>;
type SubscriptionUsageWindow = NonNullable<SubscriptionUsage["fiveHour"]>;

export function subscriptionUsageWindows(
  usage: SubscriptionUsage | null | undefined,
): readonly {
  readonly kind: "fiveHour" | "week";
  readonly window: SubscriptionUsageWindow;
}[] {
  const fiveHour = usage?.fiveHour;
  const weekly = usage?.weekly;
  const weeklyRemaining = remainingPercent(weekly);
  // Both windows constrain availability; an exhausted week blocks 5h usage.
  const weekExhausted =
    weeklyRemaining !== null &&
    Number.isFinite(weeklyRemaining) &&
    weeklyRemaining <= 0;
  const resetAt =
    !isValidResetAt(fiveHour?.resetAt) && isValidResetAt(weekly?.resetAt)
      ? weekly.resetAt
      : (fiveHour?.resetAt ?? null);

  return [
    {
      kind: "fiveHour" as const,
      window: fiveHour
        ? {
            ...fiveHour,
            remainingPercent: weekExhausted ? 0 : fiveHour.remainingPercent,
            usedPercent: weekExhausted ? 100 : fiveHour.usedPercent,
            resetAt,
          }
        : null,
    },
    { kind: "week" as const, window: weekly ?? null },
  ].filter(
    (
      item,
    ): item is {
      kind: "fiveHour" | "week";
      window: SubscriptionUsageWindow;
    } => {
      const window = item.window;
      return (
        window !== null &&
        (window.remainingPercent !== null ||
          window.usedPercent !== null ||
          window.resetAt !== null)
      );
    },
  );
}

interface LimitingSubscriptionUsageWindow {
  readonly kind: "fiveHour" | "week";
  readonly window: SubscriptionUsageWindow;
  /** Clamped to 0-100; null while the provider reports no percentage. */
  readonly remainingPercent: number | null;
}

/**
 * The window that limits the account right now: the one with the least left.
 * A tie goes to the week, because it takes longer to come back. The account
 * menu draws only this window, and the composer names it beside its percent.
 */
export function limitingSubscriptionUsageWindow(
  usage: SubscriptionUsage | null | undefined,
): LimitingSubscriptionUsageWindow | null {
  let limiting: LimitingSubscriptionUsageWindow | null = null;
  for (const { kind, window } of subscriptionUsageWindows(usage)) {
    const raw = remainingPercent(window);
    const remaining =
      raw !== null && Number.isFinite(raw)
        ? Math.min(100, Math.max(0, raw))
        : null;
    if (
      limiting === null ||
      (remaining !== null &&
        (limiting.remainingPercent === null ||
          remaining <= limiting.remainingPercent))
    ) {
      limiting = { kind, window, remainingPercent: remaining };
    }
  }
  return limiting;
}

function remainingPercent(window: SubscriptionUsageWindow | null | undefined) {
  if (!window) {
    return null;
  }
  return (
    window.remainingPercent ??
    (window.usedPercent === null ? null : 100 - window.usedPercent)
  );
}

function isValidResetAt(value: string | null | undefined): value is string {
  return !!value?.trim() && !Number.isNaN(Date.parse(value));
}
