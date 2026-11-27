import { accept } from "@okouai/connectors/accept";
import {
  number,
  object,
  record,
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

// The official agy CLI reads the member's plan and Gemini quota from the same
// Cloud Code service that serves its model requests. These request bodies
// match what agy 1.5.15 sends.
const ANTIGRAVITY_API_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_USER_AGENT =
  "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64)";
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
// Google AI Pro and Ultra quotas refresh every five hours; a later reset
// belongs to the weekly allowance.
const FIVE_HOUR_WINDOW_TOLERANCE_SECONDS = 10 * 60;
const GEMINI_4_MODEL_PREFIX = "gemini-4-";

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

const availableModelsSchema = object({
  models: record(
    string(),
    object({
      quotaInfo: object({
        remainingFraction: number().optional(),
        resetTime: string().optional(),
      }).nullish(),
    }),
  ).nullish(),
});

type LoadCodeAssistResponse = zInfer<typeof loadCodeAssistSchema>;
type AvailableModelsResponse = zInfer<typeof availableModelsSchema>;

interface AntigravitySubscriptionMetadata {
  readonly planType?: string | null;
  readonly subscriptionUsage?: SubscriptionUsageMetadata | null;
}

async function postCloudCode(
  args: {
    readonly accessToken: string;
    readonly method: "loadCodeAssist" | "fetchAvailableModels";
    readonly body: unknown;
  },
  _signal: AbortSignal,
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

/**
 * Gemini 4 quota as one window: the most constrained Gemini 4 model, placed
 * in the five-hour or weekly slot by how far away its reset is.
 */
function usageFromModels(
  response: AvailableModelsResponse,
  now: Date,
): SubscriptionUsageMetadata | null {
  let tightest: { fraction: number; resetAt: Date | null } | null = null;
  for (const [model, entry] of Object.entries(response.models ?? {})) {
    const fraction = entry.quotaInfo?.remainingFraction;
    if (!model.startsWith(GEMINI_4_MODEL_PREFIX) || fraction === undefined) {
      continue;
    }
    const reset = entry.quotaInfo?.resetTime
      ? new Date(entry.quotaInfo.resetTime)
      : null;
    const resetAt = reset && !Number.isNaN(reset.getTime()) ? reset : null;
    if (!tightest || fraction < tightest.fraction) {
      tightest = { fraction, resetAt };
    }
  }
  if (!tightest) {
    // Model identifiers are not secret; record them to adjust the filter.
    L.warn("antigravity quota has no gemini 4 model", {
      models: Object.keys(response.models ?? {}).slice(0, 20),
    });
    return null;
  }
  const secondsToReset = tightest.resetAt
    ? (tightest.resetAt.getTime() - now.getTime()) / 1000
    : 0;
  if (secondsToReset > FIVE_HOUR_SECONDS + FIVE_HOUR_WINDOW_TOLERANCE_SECONDS) {
    return {
      fiveHour: null,
      weekly: usageWindow(tightest.fraction, tightest.resetAt, WEEK_SECONDS),
    };
  }
  return {
    fiveHour: usageWindow(
      tightest.fraction,
      tightest.resetAt,
      FIVE_HOUR_SECONDS,
    ),
    weekly: null,
  };
}

/**
 * Read the member's Google AI plan and Gemini 4 quota. The quota request
 * needs the Cloud Code project that loadCodeAssist returns.
 */
export async function fetchAntigravitySubscriptionMetadata(
  args: {
    readonly accessToken: string;
    readonly now: Date;
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
  const models = availableModelsSchema.safeParse(
    await postCloudCode(
      {
        accessToken: args.accessToken,
        method: "fetchAvailableModels",
        body: project ? { project } : {},
      },
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!models.success) {
    throw new Error(
      "Google AI fetchAvailableModels response shape unrecognized",
    );
  }
  const planType = planTypeFromTiers(loaded.data);
  const subscriptionUsage = usageFromModels(models.data, args.now);
  if (!planType && !subscriptionUsage) {
    return undefined;
  }
  return {
    ...(planType ? { planType } : {}),
    ...(subscriptionUsage ? { subscriptionUsage } : {}),
  };
}
