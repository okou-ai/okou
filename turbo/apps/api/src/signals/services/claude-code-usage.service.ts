import { z } from "zod";

import type { ResetPersonalModelProviderSubscriptionUsageResponse } from "@okouai/api-contracts/contracts/personal-model-providers";

import type { SubscriptionUsageMetadata } from "./model-provider-subscription-usage.types";

const CLAUDE_CODE_API_BASE_URL = "https://api.anthropic.com";
const CLAUDE_CODE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.161";
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

// Manual rate-limit resets are granted per program. `cedar_ember` is the grant
// program the current Claude Code client redeems against; the usage endpoint
// only returns its block when asked for it, so the reset-credit read is a
// separate query rather than a field on the plain usage body.
const CLAUDE_CODE_RESET_PROGRAM = "cedar_ember";
const CLAUDE_CODE_RESET_USAGE_PATH =
  "/api/oauth/usage?cedar_ember=1&skip_spend=1";
// Upstream rejects identifiers outside these shapes, so a malformed grant is
// dropped before it can spend the account's redeem attempt on a failed call.
const CLAUDE_CODE_GRANT_ID_PATTERN = /^[a-z0-9_-]{1,40}$/;
const CLAUDE_CODE_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

type SubscriptionResetOutcome =
  ResetPersonalModelProviderSubscriptionUsageResponse["outcome"];

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

// Grants are validated one at a time: upstream may add a grant shape this
// service does not model yet, and dropping that single row keeps the remaining
// reset credits readable instead of failing the whole account's usage read.
const resetGrantSchema = z
  .object({
    id: z.string(),
    // Upstream always states the remaining count; a grant without it is
    // malformed and is dropped rather than counted as spent.
    resets_left: z.number().int().nonnegative(),
    ends_at: z.string().nullable().optional(),
    paused: z.boolean().nullable().optional(),
  })
  .passthrough();

const resetProgramSchema = z
  .object({
    eligible: z.boolean().nullable().optional(),
    grants: z.array(z.unknown()).nullable().optional(),
    next_grant_id: z.string().nullable().optional(),
  })
  .passthrough();

const usageResponseSchema = usageRateLimitsSchema
  .extend({
    rate_limits: usageRateLimitsSchema.nullable().optional(),
    [CLAUDE_CODE_RESET_PROGRAM]: resetProgramSchema.nullable().optional(),
  })
  .passthrough();

const resetResponseSchema = z
  .object({
    result: z.enum([
      "reset",
      "already_used",
      "not_limited",
      "cooldown",
      "ineligible",
      "unavailable",
    ]),
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
  readonly subscriptionResetCredits?: number | null;
  readonly subscriptionResetCreditsNextExpiresAt?: Date | null;
}

interface ClaudeCodeResetGrants {
  /** Redeemable resets across every grant, or null when upstream said nothing. */
  readonly credits: number | null;
  readonly nextExpiresAt: Date | null;
  /** The grant upstream wants redeemed next; only it may be sent to the API. */
  readonly nextGrantId: string | null;
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

function resetGrantsFromUsage(usage: UsageResponse): ClaudeCodeResetGrants {
  const program = usage[CLAUDE_CODE_RESET_PROGRAM];
  if (!program) {
    return { credits: null, nextExpiresAt: null, nextGrantId: null };
  }

  const grants = (program.grants ?? []).flatMap((candidate) => {
    const parsed = resetGrantSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });

  // A paused grant still exists upstream but cannot be redeemed, so it is left
  // out of the count the UI offers to spend.
  const redeemable = grants.filter((grant) => {
    return !grant.paused && grant.resets_left > 0;
  });
  const credits = redeemable.reduce((total, grant) => {
    return total + grant.resets_left;
  }, 0);

  const expiries = redeemable
    .flatMap((grant) => {
      const expiresAt = nextResetAt(grant.ends_at);
      return expiresAt ? [expiresAt.getTime()] : [];
    })
    .sort((left, right) => {
      return left - right;
    });

  const nextGrantId = nonEmptyString(program.next_grant_id);
  return {
    credits,
    nextExpiresAt: expiries[0] === undefined ? null : new Date(expiries[0]),
    nextGrantId:
      nextGrantId &&
      CLAUDE_CODE_GRANT_ID_PATTERN.test(nextGrantId) &&
      redeemable.some((grant) => {
        return grant.id === nextGrantId;
      })
        ? nextGrantId
        : null,
  };
}

async function claudeCodeApiResponse(
  args: {
    readonly accessToken: string;
    readonly path: string;
    readonly body?: unknown;
  },
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetch(`${CLAUDE_CODE_API_BASE_URL}${args.path}`, {
    method: args.body === undefined ? "GET" : "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      authorization: `Bearer ${args.accessToken}`,
      "anthropic-beta": CLAUDE_CODE_OAUTH_BETA,
      "content-type": "application/json",
      "user-agent": CLAUDE_CODE_USER_AGENT,
    },
    ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Claude Code metadata request failed with status ${response.status}`,
    );
  }

  return response;
}

async function fetchClaudeCodeJson(
  args: {
    readonly accessToken: string;
    readonly path: string;
  },
  signal: AbortSignal,
): Promise<unknown> {
  const response = await claudeCodeApiResponse(args, signal);
  return await response.json();
}

export async function fetchClaudeCodeProfileMetadata(
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

async function fetchUsageResponse(
  args: {
    readonly accessToken: string;
    readonly includeResetGrants: boolean;
  },
  signal: AbortSignal,
): Promise<UsageResponse> {
  const parsed = usageResponseSchema.safeParse(
    await fetchClaudeCodeJson(
      {
        accessToken: args.accessToken,
        path: args.includeResetGrants
          ? CLAUDE_CODE_RESET_USAGE_PATH
          : "/api/oauth/usage",
      },
      signal,
    ),
  );
  if (!parsed.success) {
    throw new Error("Claude Code usage response shape unrecognized");
  }
  return parsed.data;
}

async function fetchUsageMetadata(
  args: {
    readonly accessToken: string;
    readonly includeResetGrants: boolean;
  },
  signal: AbortSignal,
): Promise<
  Pick<
    ClaudeCodeSubscriptionMetadata,
    | "subscriptionResetPeriod"
    | "subscriptionNextResetAt"
    | "subscriptionUsage"
    | "subscriptionResetCredits"
    | "subscriptionResetCreditsNextExpiresAt"
  >
> {
  const usage = await fetchUsageResponse(args, signal);
  const subscriptionUsage = subscriptionUsageFromClaudeUsage(usage);
  const grants = args.includeResetGrants
    ? resetGrantsFromUsage(usage)
    : undefined;
  return {
    ...resetMetadataFromUsage(usage),
    ...(subscriptionUsage ? { subscriptionUsage } : {}),
    // The field's presence is what offers the reset entry, so an account with
    // nothing left to redeem omits it instead of showing a spent action.
    ...(grants?.credits
      ? {
          subscriptionResetCredits: grants.credits,
          subscriptionResetCreditsNextExpiresAt: grants.nextExpiresAt,
        }
      : {}),
  };
}

async function fetchResetOrganizationUuid(
  args: {
    readonly accessToken: string;
  },
  signal: AbortSignal,
): Promise<string | null> {
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
  return nonEmptyString(parsed.data.organization?.uuid);
}

function resetOutcome(
  result: z.infer<typeof resetResponseSchema>["result"],
): SubscriptionResetOutcome {
  switch (result) {
    case "reset": {
      return "reset";
    }
    case "already_used": {
      return "alreadyRedeemed";
    }
    case "not_limited": {
      return "nothingToReset";
    }
    // A cooldown, a withdrawn grant, and an unavailable program all leave the
    // account with nothing it can redeem right now, which is what the caller
    // reports as having no credit.
    case "cooldown":
    case "ineligible":
    case "unavailable": {
      return "noCredit";
    }
  }
}

/**
 * Redeem one manual rate-limit reset for a Claude Code subscription.
 *
 * The grant to redeem and the owning organization both come from upstream, so
 * an account with no redeemable grant reports `noCredit` without issuing the
 * request: the redeem attempt itself is the scarce resource.
 */
export async function consumeClaudeCodeSubscriptionReset(
  args: {
    readonly accessToken: string;
    readonly idempotencyKey: string;
  },
  signal: AbortSignal,
): Promise<{ readonly outcome: SubscriptionResetOutcome }> {
  if (!CLAUDE_CODE_REQUEST_ID_PATTERN.test(args.idempotencyKey)) {
    throw new Error("Claude Code reset request id shape unsupported");
  }

  const [usage, organizationUuid] = await Promise.all([
    fetchUsageResponse(
      { accessToken: args.accessToken, includeResetGrants: true },
      signal,
    ),
    fetchResetOrganizationUuid(args, signal),
  ]);
  signal.throwIfAborted();

  const grantId = resetGrantsFromUsage(usage).nextGrantId;
  if (!grantId || !organizationUuid) {
    return { outcome: "noCredit" };
  }

  const response = await claudeCodeApiResponse(
    {
      accessToken: args.accessToken,
      path: `/api/organizations/${encodeURIComponent(organizationUuid)}/reset_rate_limits`,
      body: {
        program: CLAUDE_CODE_RESET_PROGRAM,
        grant_id: grantId,
        request_id: args.idempotencyKey,
      },
    },
    signal,
  );

  const parsed = resetResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Claude Code reset response shape unrecognized");
  }
  return { outcome: resetOutcome(parsed.data.result) };
}

function hasMetadata(metadata: ClaudeCodeSubscriptionMetadata): boolean {
  return Object.values(metadata).some((value) => {
    return value !== undefined;
  });
}

export async function fetchClaudeCodeSubscriptionMetadata(
  args: {
    readonly accessToken: string;
    readonly includeResetGrants: boolean;
  },
  signal: AbortSignal,
): Promise<ClaudeCodeSubscriptionMetadata | undefined> {
  const [profile, usage] = await Promise.allSettled([
    fetchClaudeCodeProfileMetadata(args, signal),
    fetchUsageMetadata(args, signal),
  ]);
  signal.throwIfAborted();

  const metadata: ClaudeCodeSubscriptionMetadata = {
    ...(profile.status === "fulfilled" ? profile.value : {}),
    ...(usage.status === "fulfilled" ? usage.value : {}),
  };

  return hasMetadata(metadata) ? metadata : undefined;
}
