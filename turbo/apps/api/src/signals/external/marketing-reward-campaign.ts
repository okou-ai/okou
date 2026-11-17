import { getStartedStatusSchema } from "@okouai/api-contracts/contracts/get-started";
import type { MarketingRewardSourceEvent } from "../../lib/marketing-reward-events";
import { env } from "../../lib/env";
import { startUntrackedBestEffortCleanup } from "../utils";

export function marketingRewardCampaignConfigured() {
  return Boolean(
    env("MARKETING_REWARDS_EVENTS_ORIGIN") &&
    env("MARKETING_REWARDS_CAMPAIGN_SECRET"),
  );
}

function requestCampaign(
  path: "status" | "check-in",
  body: unknown,
  signal: AbortSignal,
) {
  const origin = env("MARKETING_REWARDS_EVENTS_ORIGIN");
  const secret = env("MARKETING_REWARDS_CAMPAIGN_SECRET");
  if (!origin || !secret) {
    throw new Error("Marketing reward campaign is not configured");
  }
  return fetch(`${origin}/api/internal/marketing/get-started/${path}`, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
  });
}

export async function readMarketingRewardStatus(
  identity: {
    readonly userId: string;
    readonly orgId: string;
    readonly admin: boolean;
  },
  signal: AbortSignal,
) {
  const response = await requestCampaign("status", identity, signal);
  if (response.status !== 200) {
    if (response.body) {
      startUntrackedBestEffortCleanup(response.body.cancel());
    }
    throw new Error("Marketing reward status is unavailable");
  }
  return getStartedStatusSchema.parse(await response.json());
}

/** Processing acknowledgement is not proof of money; the caller reads the App ledger. */
export async function requestMarketingCheckin(
  source: Extract<MarketingRewardSourceEvent, { version: 5 }>,
  signal: AbortSignal,
) {
  const response = await requestCampaign("check-in", source, signal);
  if (response.body) {
    startUntrackedBestEffortCleanup(response.body.cancel());
  }
  if (response.status !== 200 && response.status !== 202) {
    throw new Error("Marketing check-in processing is unavailable");
  }
}
