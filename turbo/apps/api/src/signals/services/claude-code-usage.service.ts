import { z } from "zod";

import type { SubscriptionUsageMetadata } from "./model-provider-subscription-usage.types";

const CLAUDE_CODE_API_BASE_URL = "https://api.anthropic.com";
const CLAUDE_CODE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.161";
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

const usageWindowSchema = z
  .object({
    limit_window_seconds: z.number().nullable().optional(),
    resets_at: z.string().nullable().optional(),
    resetsAt: z.string().nullable().optional(),
    reset_at: z.string().nullable().optional(),
    resetAt: z.string().nullable().optional(),
    used_percentage: z.number().nullable().optional(),
    used_percent: z.number().nullable().optional(),
    usedPercentage: z.number().nullable().optional(),
    usedPercent: z.number().nullable().optional(),
    utilization: z.number().nullable().optional(),
    window_seconds: z.number().nullable().optional(),
  })
  .passthrough();

const usageRateLimitsSchema = z
  .object({
    five_hour: usageWindowSchema.nullable().optional(),
    seven_day: usageWindowSchema.nullable().optional(),
    seven_day_opus: usageWindowSchema.nullable().optional(),
    seven_day_sonnet: usageWindowSchema.nullable().optional(),
  })
  .passthrough();

const usageResponseSchema = usageRateLimitsSchema
  .extend({
    rate_limits: usageRateLimitsSchema.nullable().optional(),
  })
  .passthrough();

const profileResponseSchema = z
  .object({
    account: z
      .object({
        uuid: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        display_name: z.string().nullable().optional(),
        full_name: z.string().nullable().optional(),
        has_claude_max: z.boolean().nullable().optional(),
        has_claude_pro: z.boolean().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    organization: z
      .object({
        uuid: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
        organization_name: z.string().nullable().optional(),
        organization_type: z.string().nullable().optional(),
        rate_limit_tier: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

type ProfileResponse = z.infer<typeof profileResponseSchema>;
type UsageResponse = z.infer<typeof usageResponseSchema>;
type UsageWindow = z.infer<typeof usageWindowSchema>;

interface ClaudeCodeSubscriptionMetadata {
  readonly externalAccountId?: string | null;
  readonly accountEmail?: string | null;
  readonly workspaceName?: string | null;
  readonly planType?: string | null;
  readonly subscriptionResetPeriod?: string | null;
  readonly subscriptionNextResetAt?: Date | null;
  readonly subscriptionUsage?: SubscriptionUsageMetadata | null;
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizePlanType(value: string): string {
  return value.replace(/^claude_/, "").replaceAll("_", " ");
}

function maxTierSuffix(rateLimitTier: string | null): string | null {
  const match = rateLimitTier?.match(/(\d+x)$/);
  return match?.[1] ?? null;
}

function planTypeFromProfile(profile: ProfileResponse): string | null {
  const organizationType = nonEmptyString(
    profile.organization?.organization_type,
  );
  const rateLimitTier = nonEmptyString(profile.organization?.rate_limit_tier);

  if (organizationType === "claude_max") {
    const tierSuffix = maxTierSuffix(rateLimitTier);
    return tierSuffix ? `max ${tierSuffix}` : "max";
  }
  if (organizationType) {
    return normalizePlanType(organizationType);
  }
  if (profile.account?.has_claude_max) {
    const tierSuffix = maxTierSuffix(rateLimitTier);
    return tierSuffix ? `max ${tierSuffix}` : "max";
  }
  if (profile.account?.has_claude_pro) {
    return "pro";
  }
  return null;
}

function workspaceNameFromProfile(profile: ProfileResponse): string | null {
  return (
    nonEmptyString(profile.organization?.name) ??
    nonEmptyString(profile.organization?.organization_name) ??
    nonEmptyString(profile.account?.display_name) ??
    nonEmptyString(profile.account?.full_name)
  );
}

function nextResetAt(value: string | null | undefined): Date | null {
  const text = nonEmptyString(value);
  if (!text) {
    return null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function nextResetAtFromWindow(
  window: UsageWindow | null | undefined,
): Date | null {
  return nextResetAt(
    window?.resets_at ??
      window?.resetsAt ??
      window?.reset_at ??
      window?.resetAt,
  );
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function normalizedPercent(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? clampPercent(value)
    : null;
}

function usedPercentFromWindow(
  window: UsageWindow | null | undefined,
): number | null {
  return normalizedPercent(
    window?.utilization ??
      window?.used_percentage ??
      window?.used_percent ??
      window?.usedPercentage ??
      window?.usedPercent,
  );
}

function windowSecondsFromWindow(
  window: UsageWindow | null | undefined,
  fallback: number,
): number {
  const seconds = window?.limit_window_seconds ?? window?.window_seconds;
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? seconds
    : fallback;
}

function subscriptionUsageWindowFromClaudeWindow(
  window: UsageWindow | null | undefined,
  fallbackWindowSeconds: number,
): NonNullable<SubscriptionUsageMetadata["fiveHour"]> | null {
  if (!window) {
    return null;
  }

  const usedPercent = usedPercentFromWindow(window);
  const resetAt = nextResetAtFromWindow(window);
  if (usedPercent === null && resetAt === null) {
    return null;
  }

  return {
    usedPercent,
    remainingPercent:
      usedPercent === null ? null : clampPercent(100 - usedPercent),
    resetAt,
    windowSeconds: windowSecondsFromWindow(window, fallbackWindowSeconds),
  };
}

function directOrNestedWindow(
  usage: UsageResponse,
  key: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet",
): UsageWindow | null | undefined {
  return usage.rate_limits?.[key] ?? usage[key];
}

function chooseClaudeWeeklyWindow(
  usage: UsageResponse,
): NonNullable<SubscriptionUsageMetadata["weekly"]> | null {
  const sevenDay = subscriptionUsageWindowFromClaudeWindow(
    directOrNestedWindow(usage, "seven_day"),
    WEEK_SECONDS,
  );
  if (sevenDay) {
    return sevenDay;
  }

  const candidates = [
    subscriptionUsageWindowFromClaudeWindow(
      directOrNestedWindow(usage, "seven_day_opus"),
      WEEK_SECONDS,
    ),
    subscriptionUsageWindowFromClaudeWindow(
      directOrNestedWindow(usage, "seven_day_sonnet"),
      WEEK_SECONDS,
    ),
  ].filter(
    (window): window is NonNullable<SubscriptionUsageMetadata["weekly"]> => {
      return window !== null;
    },
  );

  candidates.sort((left, right) => {
    return (
      (right.usedPercent ?? -1) - (left.usedPercent ?? -1) ||
      (left.resetAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (right.resetAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
    );
  });

  return candidates[0] ?? null;
}

function subscriptionUsageFromClaudeUsage(
  usage: UsageResponse,
): SubscriptionUsageMetadata | null {
  const fiveHour = subscriptionUsageWindowFromClaudeWindow(
    directOrNestedWindow(usage, "five_hour"),
    FIVE_HOUR_SECONDS,
  );
  const weekly = chooseClaudeWeeklyWindow(usage);

  if (!fiveHour && !weekly) {
    return null;
  }
  return {
    fiveHour,
    weekly,
  };
}

function resetMetadataFromUsage(
  usage: UsageResponse,
): Pick<
  ClaudeCodeSubscriptionMetadata,
  "subscriptionResetPeriod" | "subscriptionNextResetAt"
> {
  const subscriptionUsage = subscriptionUsageFromClaudeUsage(usage);
  const weeklyResetAt = subscriptionUsage?.weekly?.resetAt;
  if (weeklyResetAt) {
    return {
      subscriptionResetPeriod: "weekly",
      subscriptionNextResetAt: weeklyResetAt,
    };
  }

  const fiveHourResetAt = subscriptionUsage?.fiveHour?.resetAt;
  if (fiveHourResetAt) {
    return {
      subscriptionResetPeriod: "5-hour window",
      subscriptionNextResetAt: fiveHourResetAt,
    };
  }

  return {};
}

async function fetchClaudeCodeJson(
  args: {
    readonly accessToken: string;
    readonly path: string;
  },
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`${CLAUDE_CODE_API_BASE_URL}${args.path}`, {
    method: "GET",
    headers: {
      accept: "application/json, text/plain, */*",
      authorization: `Bearer ${args.accessToken}`,
      "anthropic-beta": CLAUDE_CODE_OAUTH_BETA,
      "content-type": "application/json",
      "user-agent": CLAUDE_CODE_USER_AGENT,
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Claude Code metadata request failed with status ${response.status}`,
    );
  }

  return await response.json();
}

async function fetchProfileMetadata(
  args: {
    readonly accessToken: string;
  },
  signal: AbortSignal,
): Promise<
  Pick<
    ClaudeCodeSubscriptionMetadata,
    "externalAccountId" | "accountEmail" | "workspaceName" | "planType"
  >
> {
  const parsed = profileResponseSchema.safeParse(
    await fetchClaudeCodeJson(
      {
        accessToken: args.accessToken,
        path: "/api/oauth/profile",
      },
      signal,
    ),
  );
  if (!parsed.success) {
    throw new Error("Claude Code profile response shape unrecognized");
  }
  return {
    externalAccountId:
      parsed.data.account?.uuid && parsed.data.organization?.uuid
        ? `${parsed.data.account.uuid}:${parsed.data.organization.uuid}`
        : null,
    accountEmail:
      nonEmptyString(parsed.data.account?.email)?.toLowerCase() ?? null,
    workspaceName: workspaceNameFromProfile(parsed.data),
    planType: planTypeFromProfile(parsed.data),
  };
}

async function fetchUsageMetadata(
  args: {
    readonly accessToken: string;
  },
  signal: AbortSignal,
): Promise<
  Pick<
    ClaudeCodeSubscriptionMetadata,
    "subscriptionResetPeriod" | "subscriptionNextResetAt" | "subscriptionUsage"
  >
> {
  const parsed = usageResponseSchema.safeParse(
    await fetchClaudeCodeJson(
      {
        accessToken: args.accessToken,
        path: "/api/oauth/usage",
      },
      signal,
    ),
  );
  if (!parsed.success) {
    throw new Error("Claude Code usage response shape unrecognized");
  }
  const subscriptionUsage = subscriptionUsageFromClaudeUsage(parsed.data);
  return {
    ...resetMetadataFromUsage(parsed.data),
    ...(subscriptionUsage ? { subscriptionUsage } : {}),
  };
}

function hasMetadata(metadata: ClaudeCodeSubscriptionMetadata): boolean {
  return Object.values(metadata).some((value) => {
    return value !== undefined;
  });
}

export async function fetchClaudeCodeSubscriptionMetadata(
  args: {
    readonly accessToken: string;
  },
  signal: AbortSignal,
): Promise<ClaudeCodeSubscriptionMetadata | undefined> {
  const [profile, usage] = await Promise.allSettled([
    fetchProfileMetadata(args, signal),
    fetchUsageMetadata(args, signal),
  ]);
  signal.throwIfAborted();

  const metadata: ClaudeCodeSubscriptionMetadata = {
    ...(profile.status === "fulfilled" ? profile.value : {}),
    ...(usage.status === "fulfilled" ? usage.value : {}),
  };

  return hasMetadata(metadata) ? metadata : undefined;
}
