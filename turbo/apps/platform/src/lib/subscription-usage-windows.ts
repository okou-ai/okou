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
