import { accept } from "@okouai/connectors/accept";
import {
  array,
  boolean,
  number,
  object,
  string,
  union,
  type infer as zInfer,
} from "zod";

import { logger } from "../../lib/log";
import type {
  SubscriptionUsageMetadata,
  SubscriptionUsageWindowMetadata,
} from "./model-provider-subscription-usage.types";

const L = logger("antigravity-usage.service");

// The official agy CLI reads the member's plan and grouped quota windows from
// the Cloud Code service that serves its model requests.
const ANTIGRAVITY_API_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_USER_AGENT =
  "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64)";
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

const FIVE_HOUR_WINDOW_PATTERN =
  /^(?:5\s*h(?:ours?|rs?)?|five[\s_-]*hour|session|18000s)$/;
const WEEKLY_WINDOW_PATTERN =
  /^(?:7\s*d(?:ays?)?|1\s*w|week(?:ly)?|seven[\s_-]*day|604800s)$/;
const FIVE_HOUR_TEXT_PATTERN =
  /(?:^|[-_\s])(?:5\s*h(?:ours?|rs?)?|five[\s_-]*hour)(?:$|[-_\s])/;
const WEEKLY_TEXT_PATTERN =
  /(?:^|[-_\s])(?:7\s*d(?:ays?)?|week(?:ly)?|seven[\s_-]*day)(?:$|[-_\s])/;

const tierSchema = object({
  id: string().optional(),
  name: string().optional(),
}).nullish();

const loadCodeAssistSchema = object({
  cloudaicompanionProject: union([
    string(),
    object({ id: string().optional() }),
  ]).nullish(),
  currentTier: tierSchema,
  paidTier: tierSchema,
});

// Matches google/internal/cloud/code/v1internal/quota_summary.proto.
const quotaSummaryBucketSchema = object({
  bucketId: string().nullish(),
  displayName: string().nullish(),
  description: string().nullish(),
  window: string().nullish(),
  remainingFraction: number().nullish(),
  disabled: boolean().nullish(),
  resetTime: string().nullish(),
});

const quotaSummaryGroupSchema = object({
  displayName: string().nullish(),
  description: string().nullish(),
  buckets: array(quotaSummaryBucketSchema).nullish(),
});

const quotaSummarySchema = object({
  groups: array(quotaSummaryGroupSchema).nullish(),
});

type LoadCodeAssistResponse = zInfer<typeof loadCodeAssistSchema>;
type QuotaSummaryBucket = zInfer<typeof quotaSummaryBucketSchema>;
type QuotaSummaryGroup = zInfer<typeof quotaSummaryGroupSchema>;
type QuotaSummaryResponse = zInfer<typeof quotaSummarySchema>;

type QuotaWindowKind = "fiveHour" | "weekly";

interface CandidateBucket {
  readonly fraction: number;
  readonly resetAt: Date | null;
}

interface AntigravitySubscriptionMetadata {
  readonly planType?: string | null;
  readonly subscriptionResetPeriod?: string | null;
  readonly subscriptionNextResetAt?: Date | null;
  readonly subscriptionUsage?: SubscriptionUsageMetadata | null;
}

async function postCloudCode(
  args: {
    readonly accessToken: string;
    readonly method: "loadCodeAssist" | "retrieveUserQuotaSummary";
    readonly body: unknown;
  },
  signal: AbortSignal,
): Promise<unknown> {
  const response = await accept(
    fetch(`${ANTIGRAVITY_API_BASE_URL}/v1internal:${args.method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.accessToken}`,
        "content-type": "application/json",
        "user-agent": ANTIGRAVITY_USER_AGENT,
      },
      body: JSON.stringify(args.body),
      signal,
    }),
    [200],
  );
  return await response.json();
}

function projectId(response: LoadCodeAssistResponse): string | undefined {
  const project = response.cloudaicompanionProject;
  const id = typeof project === "string" ? project : project?.id;
  return id?.trim() || undefined;
}

/** Short plan label for the Settings badge, from the paid or current tier. */
function planTypeFromTiers(response: LoadCodeAssistResponse): string | null {
  for (const tier of [response.paidTier, response.currentTier]) {
    const text = `${tier?.id ?? ""} ${tier?.name ?? ""}`.toLowerCase();
    if (text.includes("ultra")) {
      return "ultra";
    }
    if (text.includes("pro")) {
      return "pro";
    }
    if (text.includes("free")) {
      return "free";
    }
  }
  // Tier identifiers are not secret; record them to extend the mapping.
  L.warn("antigravity plan tier unrecognized", {
    paidTierId: response.paidTier?.id ?? null,
    currentTierId: response.currentTier?.id ?? null,
  });
  return null;
}

function usageWindow(
  remainingFraction: number,
  resetAt: Date | null,
  windowSeconds: number,
): SubscriptionUsageWindowMetadata {
  const remainingPercent =
    Math.round(Math.min(Math.max(remainingFraction, 0), 1) * 1000) / 10;
  return {
    usedPercent: Math.round((100 - remainingPercent) * 10) / 10,
    remainingPercent,
    resetAt,
    windowSeconds,
  };
}

function parseResetTime(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const reset = new Date(value);
  return Number.isNaN(reset.getTime()) ? null : reset;
}

/**
 * Select the general Gemini quota group used by Okou's Gemini 4 models,
 * excluding third-party (Claude/GPT) pools and dedicated Argon preview pools.
 */
function isGeminiQuotaGroup(group: QuotaSummaryGroup): boolean {
  const groupName = (group.displayName ?? "").toLowerCase();
  const bucketTexts = (group.buckets ?? []).map((bucket) => {
    return `${bucket.bucketId ?? ""} ${bucket.displayName ?? ""}`.toLowerCase();
  });
  const allText = [groupName, ...bucketTexts].join(" ");
  if (/\b(?:claude|gpt|3p|argon)\b/.test(allText)) {
    return false;
  }
  return allText.includes("gemini");
}

function classifyBucketWindow(
  bucket: QuotaSummaryBucket,
): QuotaWindowKind | null {
  const explicit = bucket.window?.trim().toLowerCase() ?? "";
  if (explicit.length > 0) {
    if (FIVE_HOUR_WINDOW_PATTERN.test(explicit)) {
      return "fiveHour";
    }
    if (WEEKLY_WINDOW_PATTERN.test(explicit)) {
      return "weekly";
    }
    return null;
  }
  const text = `${bucket.bucketId ?? ""} ${bucket.displayName ?? ""}`
    .trim()
    .toLowerCase();
  if (FIVE_HOUR_TEXT_PATTERN.test(text)) {
    return "fiveHour";
  }
  if (WEEKLY_TEXT_PATTERN.test(text)) {
    return "weekly";
  }
  return null;
}

function isTighterCandidate(
  candidate: CandidateBucket,
  current: CandidateBucket | null,
): boolean {
  if (!current) {
    return true;
  }
  if (candidate.fraction !== current.fraction) {
    return candidate.fraction < current.fraction;
  }
  return (
    (candidate.resetAt?.getTime() ?? Number.MAX_SAFE_INTEGER) <
    (current.resetAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
  );
}

/**
 * Gemini 5-hour and weekly quota windows from retrieveUserQuotaSummary.
 */
function usageFromQuotaSummary(
  response: QuotaSummaryResponse,
): SubscriptionUsageMetadata | null {
  let fiveHour: CandidateBucket | null = null;
  let weekly: CandidateBucket | null = null;

  for (const group of response.groups ?? []) {
    if (!isGeminiQuotaGroup(group)) {
      continue;
    }
    for (const bucket of group.buckets ?? []) {
      if (bucket.disabled === true) {
        continue;
      }
      const fraction = bucket.remainingFraction;
      if (typeof fraction !== "number" || !Number.isFinite(fraction)) {
        continue;
      }
      const kind = classifyBucketWindow(bucket);
      if (!kind) {
        continue;
      }
      const candidate: CandidateBucket = {
        fraction,
        resetAt: parseResetTime(bucket.resetTime),
      };
      if (kind === "fiveHour" && isTighterCandidate(candidate, fiveHour)) {
        fiveHour = candidate;
      } else if (kind === "weekly" && isTighterCandidate(candidate, weekly)) {
        weekly = candidate;
      }
    }
  }

  if (!fiveHour && !weekly) {
    // Group and bucket identifiers are not secret; record them to adjust matching.
    L.warn("antigravity quota summary has no gemini window", {
      groups: (response.groups ?? []).slice(0, 10).map((group) => {
        return {
          displayName: group.displayName ?? null,
          buckets: (group.buckets ?? []).slice(0, 10).map((bucket) => {
            return {
              bucketId: bucket.bucketId ?? null,
              window: bucket.window ?? null,
            };
          }),
        };
      }),
    });
    return null;
  }

  return {
    fiveHour: fiveHour
      ? usageWindow(fiveHour.fraction, fiveHour.resetAt, FIVE_HOUR_SECONDS)
      : null,
    weekly: weekly
      ? usageWindow(weekly.fraction, weekly.resetAt, WEEK_SECONDS)
      : null,
  };
}

function resetMetadataFromUsage(
  usage: SubscriptionUsageMetadata | null,
): Pick<
  AntigravitySubscriptionMetadata,
  "subscriptionResetPeriod" | "subscriptionNextResetAt"
> {
  const weeklyResetAt = usage?.weekly?.resetAt;
  if (weeklyResetAt) {
    return {
      subscriptionResetPeriod: "weekly",
      subscriptionNextResetAt: weeklyResetAt,
    };
  }
  const fiveHourResetAt = usage?.fiveHour?.resetAt;
  if (fiveHourResetAt) {
    return {
      subscriptionResetPeriod: "5-hour window",
      subscriptionNextResetAt: fiveHourResetAt,
    };
  }
  return {};
}

/**
 * Read the member's Google AI plan and Gemini 5-hour/weekly quota windows.
 * The quota summary request needs the Cloud Code project returned by
 * loadCodeAssist.
 */
export async function fetchAntigravitySubscriptionMetadata(
  args: {
    readonly accessToken: string;
  },
  signal: AbortSignal,
): Promise<AntigravitySubscriptionMetadata | undefined> {
  const loaded = loadCodeAssistSchema.safeParse(
    await postCloudCode(
      {
        accessToken: args.accessToken,
        method: "loadCodeAssist",
        body: { metadata: { ideType: "ANTIGRAVITY" } },
      },
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!loaded.success) {
    throw new Error("Google AI loadCodeAssist response shape unrecognized");
  }
  const project = projectId(loaded.data);
  const summary = quotaSummarySchema.safeParse(
    await postCloudCode(
      {
        accessToken: args.accessToken,
        method: "retrieveUserQuotaSummary",
        body: project ? { project } : {},
      },
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!summary.success) {
    throw new Error(
      "Google AI retrieveUserQuotaSummary response shape unrecognized",
    );
  }
  const planType = planTypeFromTiers(loaded.data);
  const subscriptionUsage = usageFromQuotaSummary(summary.data);
  if (!planType && !subscriptionUsage) {
    return undefined;
  }
  return {
    ...(planType ? { planType } : {}),
    ...resetMetadataFromUsage(subscriptionUsage),
    ...(subscriptionUsage ? { subscriptionUsage } : {}),
  };
}
