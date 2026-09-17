import { z } from "zod";

import { now } from "../../lib/time";
import type { prepareCodexResetCreditExpiryRead } from "./codex-reset-credit-expiry.service";
import type {
  SubscriptionUsageMetadata,
  SubscriptionUsageWindowMetadata,
} from "./model-provider-subscription-usage.types";
import { extractCodexAccountEmailFromIdToken } from "./codex-auth-json-parser";

const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CHATGPT_RESET_CREDITS_CONSUME_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_USER_AGENT = "codex_cli_rs/0.0.0";
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;
const FIVE_HOUR_SECONDS = 5 * HOUR_SECONDS;
const MINUTE_SECONDS = 60;

const rateLimitWindowSchema = z
  .object({
    limit_window_seconds: z.number().nullable().optional(),
    reset_after_seconds: z.number().nullable().optional(),
    reset_at: z.number().nullable().optional(),
    used_percent: z.number().nullable().optional(),
  })
  .passthrough();

const rateLimitDetailsSchema = z
  .object({
    primary_window: rateLimitWindowSchema.nullable().optional(),
    secondary_window: rateLimitWindowSchema.nullable().optional(),
  })
  .passthrough();

const rateLimitResetCreditsSchema = z
  .object({
    available_count: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();

const namedMetadataSchema = z
  .object({
    title: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    display_name: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
  })
  .passthrough();

const codexUsageResponseSchema = z
  .object({
    plan_type: z.string().nullable().optional(),
    account: namedMetadataSchema.nullable().optional(),
    account_name: z.string().nullable().optional(),
    chatgpt_account_name: z.string().nullable().optional(),
    chatgpt_organization_name: z.string().nullable().optional(),
    chatgpt_workspace_display_name: z.string().nullable().optional(),
    chatgpt_workspace_name: z.string().nullable().optional(),
    chatgpt_workspace_title: z.string().nullable().optional(),
    organization: namedMetadataSchema.nullable().optional(),
    organization_name: z.string().nullable().optional(),
    rate_limit: rateLimitDetailsSchema.nullable().optional(),
    rate_limit_reset_credits: rateLimitResetCreditsSchema.nullable().optional(),
    workspace: namedMetadataSchema.nullable().optional(),
    workspace_name: z.string().nullable().optional(),
  })
  .passthrough();

const codexRateLimitResetCreditConsumeResponseSchema = z
  .object({
    code: z.enum([
      "reset",
      "nothing_to_reset",
      "no_credit",
      "already_redeemed",
    ]),
    windows_reset: z.number().nullable().optional(),
  })
  .passthrough();

type RateLimitWindow = z.infer<typeof rateLimitWindowSchema>;
type CodexNamedMetadata = z.infer<typeof namedMetadataSchema>;
type CodexUsageResponse = z.infer<typeof codexUsageResponseSchema>;

interface CodexUsageMetadata {
  readonly accountEmail: string | null;
  readonly planType: string | null;
  readonly workspaceName: string | null;
  readonly subscriptionResetPeriod: string | null;
  readonly subscriptionNextResetAt: Date | null;
  readonly subscriptionUsage: SubscriptionUsageMetadata | null;
  readonly subscriptionResetCredits: number | null;
  readonly subscriptionResetCreditsNextExpiresAt: Date | null;
}

export type CodexRateLimitResetCreditOutcome =
  | "reset"
  | "nothingToReset"
  | "noCredit"
  | "alreadyRedeemed";

interface UsageResetWindow {
  readonly period: string | null;
  readonly nextResetAt: Date | null;
  readonly limitWindowSeconds: number | null;
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function nameFromMetadata(
  metadata: CodexNamedMetadata | null | undefined,
): string | null {
  if (!metadata) {
    return null;
  }
  return (
    nonEmptyString(metadata.title) ??
    nonEmptyString(metadata.name) ??
    nonEmptyString(metadata.display_name) ??
    nonEmptyString(metadata.displayName) ??
    null
  );
}

function workspaceNameFromUsage(usage: CodexUsageResponse): string | null {
  return (
    nameFromMetadata(usage.organization) ??
    nameFromMetadata(usage.workspace) ??
    nonEmptyString(usage.chatgpt_workspace_name) ??
    nonEmptyString(usage.chatgpt_workspace_title) ??
    nonEmptyString(usage.chatgpt_workspace_display_name) ??
    nonEmptyString(usage.chatgpt_organization_name) ??
    nonEmptyString(usage.organization_name) ??
    nonEmptyString(usage.workspace_name) ??
    nameFromMetadata(usage.account) ??
    nonEmptyString(usage.chatgpt_account_name) ??
    nonEmptyString(usage.account_name) ??
    null
  );
}

function periodLabel(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return null;
  }
  if (seconds === WEEK_SECONDS) {
    return "weekly";
  }
  if (seconds === DAY_SECONDS) {
    return "daily";
  }
  if (seconds === HOUR_SECONDS) {
    return "hourly";
  }
  if (seconds % WEEK_SECONDS === 0) {
    return `${seconds / WEEK_SECONDS}-week window`;
  }
  if (seconds % DAY_SECONDS === 0) {
    return `${seconds / DAY_SECONDS}-day window`;
  }
  if (seconds % HOUR_SECONDS === 0) {
    return `${seconds / HOUR_SECONDS}-hour window`;
  }
  if (seconds % MINUTE_SECONDS === 0) {
    return `${seconds / MINUTE_SECONDS}-minute window`;
  }
  return `${seconds}-second window`;
}

function dateFromResetWindow(window: RateLimitWindow): Date | null {
  if (typeof window.reset_at === "number" && Number.isFinite(window.reset_at)) {
    return new Date(window.reset_at * 1000);
  }
  if (
    typeof window.reset_after_seconds === "number" &&
    Number.isFinite(window.reset_after_seconds)
  ) {
    return new Date(now() + window.reset_after_seconds * 1000);
  }
  return null;
}

function resetWindowFromUsageWindow(
  window: RateLimitWindow | null | undefined,
): UsageResetWindow | null {
  if (!window) {
    return null;
  }
  const period = periodLabel(window.limit_window_seconds);
  const nextResetAt = dateFromResetWindow(window);
  if (!period && !nextResetAt) {
    return null;
  }
  return {
    period,
    nextResetAt,
    limitWindowSeconds: window.limit_window_seconds ?? null,
  };
}

function chooseSubscriptionResetWindow(
  rateLimit: z.infer<typeof rateLimitDetailsSchema> | null | undefined,
): UsageResetWindow | null {
  if (!rateLimit) {
    return null;
  }

  const windows = [
    resetWindowFromUsageWindow(rateLimit.primary_window),
    resetWindowFromUsageWindow(rateLimit.secondary_window),
  ].filter((window): window is UsageResetWindow => {
    return window !== null;
  });

  windows.sort((left, right) => {
    return (
      (right.limitWindowSeconds ?? 0) - (left.limitWindowSeconds ?? 0) ||
      (left.nextResetAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (right.nextResetAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
    );
  });
  return windows[0] ?? null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function normalizedPercent(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? clampPercent(value)
    : null;
}

function subscriptionUsageWindowFromCodexWindow(
  window: RateLimitWindow | null | undefined,
): SubscriptionUsageWindowMetadata | null {
  if (!window) {
    return null;
  }

  const usedPercent = normalizedPercent(window.used_percent);
  const resetAt = dateFromResetWindow(window);
  const usageWindow = {
    usedPercent,
    remainingPercent:
      usedPercent === null ? null : clampPercent(100 - usedPercent),
    resetAt,
    windowSeconds: window.limit_window_seconds ?? null,
  };

  return usedPercent !== null || resetAt !== null ? usageWindow : null;
}

function subscriptionUsageFromRateLimit(
  rateLimit: z.infer<typeof rateLimitDetailsSchema> | null | undefined,
): SubscriptionUsageMetadata | null {
  if (!rateLimit) {
    return null;
  }

  const primary = subscriptionUsageWindowFromCodexWindow(
    rateLimit.primary_window,
  );
  const secondary = subscriptionUsageWindowFromCodexWindow(
    rateLimit.secondary_window,
  );
  const windows = [primary, secondary].filter(
    (window): window is SubscriptionUsageWindowMetadata => {
      return window !== null;
    },
  );
  const windowBySeconds = (seconds: number) => {
    return (
      windows.find((window) => {
        return window.windowSeconds === seconds;
      }) ?? null
    );
  };

  const fiveHour =
    windowBySeconds(FIVE_HOUR_SECONDS) ??
    (primary?.windowSeconds === WEEK_SECONDS ? null : primary);
  const weekly =
    windowBySeconds(WEEK_SECONDS) ??
    (secondary?.windowSeconds === FIVE_HOUR_SECONDS ? null : secondary);

  if (!fiveHour && !weekly) {
    return null;
  }
  return {
    fiveHour,
    weekly,
  };
}

export async function fetchCodexUsageMetadata(
  args: {
    readonly accessToken: string;
    readonly accountId: string;
    readonly idToken?: string | null;
    readonly readResetCreditExpiry: ReturnType<
      typeof prepareCodexResetCreditExpiryRead
    >;
  },
  signal: AbortSignal,
): Promise<CodexUsageMetadata | null> {
  const detailsWaiter = new AbortController();
  const detailsSignal = AbortSignal.any([signal, detailsWaiter.signal]);
  const [response, resetCreditExpiry] = await Promise.all([
    fetch(CHATGPT_USAGE_URL, {
      method: "GET",
      headers: {
        authorization: `Bearer ${args.accessToken}`,
        "chatgpt-account-id": args.accountId,
        originator: CODEX_ORIGINATOR,
        "user-agent": CODEX_USER_AGENT,
      },
      signal,
    }),
    args.readResetCreditExpiry(args, detailsSignal),
  ]).finally(() => {
    detailsWaiter.abort(new Error("Codex usage metadata read settled"));
  });

  if (!response.ok) {
    throw new Error(
      `Codex usage request failed with status ${response.status}`,
    );
  }

  const parsed = codexUsageResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Codex usage response shape unrecognized");
  }

  signal.throwIfAborted();
  const resetWindow = chooseSubscriptionResetWindow(parsed.data.rate_limit);
  return {
    accountEmail: extractCodexAccountEmailFromIdToken(args.idToken),
    planType: nonEmptyString(parsed.data.plan_type),
    workspaceName: workspaceNameFromUsage(parsed.data),
    subscriptionResetPeriod: resetWindow?.period ?? null,
    subscriptionNextResetAt: resetWindow?.nextResetAt ?? null,
    subscriptionUsage: subscriptionUsageFromRateLimit(parsed.data.rate_limit),
    subscriptionResetCredits:
      parsed.data.rate_limit_reset_credits?.available_count ?? null,
    subscriptionResetCreditsNextExpiresAt: resetCreditExpiry(),
  };
}

function codexResetCreditOutcome(
  code: z.infer<typeof codexRateLimitResetCreditConsumeResponseSchema>["code"],
): CodexRateLimitResetCreditOutcome {
  switch (code) {
    case "reset": {
      return "reset";
    }
    case "nothing_to_reset": {
      return "nothingToReset";
    }
    case "no_credit": {
      return "noCredit";
    }
    case "already_redeemed": {
      return "alreadyRedeemed";
    }
  }
}

export async function consumeCodexRateLimitResetCredit(
  args: {
    readonly accessToken: string;
    readonly accountId: string;
    readonly idempotencyKey: string;
  },
  signal: AbortSignal,
): Promise<{
  readonly outcome: CodexRateLimitResetCreditOutcome;
}> {
  const response = await fetch(CHATGPT_RESET_CREDITS_CONSUME_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      "chatgpt-account-id": args.accountId,
      "content-type": "application/json",
      originator: CODEX_ORIGINATOR,
      "user-agent": CODEX_USER_AGENT,
    },
    body: JSON.stringify({
      redeem_request_id: args.idempotencyKey,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Codex reset credit consume request failed with status ${response.status}`,
    );
  }

  const parsed = codexRateLimitResetCreditConsumeResponseSchema.safeParse(
    await response.json(),
  );
  if (!parsed.success) {
    throw new Error("Codex reset credit consume response shape unrecognized");
  }

  return {
    outcome: codexResetCreditOutcome(parsed.data.code),
  };
}
