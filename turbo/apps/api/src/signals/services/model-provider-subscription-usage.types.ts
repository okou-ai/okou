export interface SubscriptionUsageWindowMetadata {
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly resetAt: Date | null;
  readonly windowSeconds: number | null;
}

export interface SubscriptionUsageMetadata {
  readonly fiveHour: SubscriptionUsageWindowMetadata | null;
  readonly weekly: SubscriptionUsageWindowMetadata | null;
}

export interface SubscriptionCreditsMetadata {
  readonly balance: number | null;
  readonly unlimited: boolean;
}
