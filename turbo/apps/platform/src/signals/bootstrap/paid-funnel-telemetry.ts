import { compatibleGoogleAdsAttribution } from "@okouai/core/google-ads-attribution";
// Paid-onboarding funnel telemetry. Every event carries the first-touch ad
// attribution captured on the marketing-site hop so PostHog can segment the
// funnel by campaign, and the two website-tag conversion actions that Google
// Ads bids on (`Onboarding Start`, `Checkout Start`) fire from the same call
// sites as their PostHog counterparts.

import {
  GOOGLE_ADS_ADSMARCH_ACCOUNT_ID,
  GOOGLE_ADS_LEGACY_ACCOUNT_ID,
} from "@okouai/core/google-ads-account";
import type { AdAttributionMetadata } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { command } from "ccstate";
import { capturePaidOnboardingEvent } from "../../lib/posthog.ts";
import {
  fireGoogleAdsConversion,
  GOOGLE_ADS_ADSMARCH_CHECKOUT_START_SEND_TO,
  GOOGLE_ADS_ADSMARCH_ONBOARDING_START_SEND_TO,
  GOOGLE_ADS_CHECKOUT_START_SEND_TO,
  GOOGLE_ADS_ONBOARDING_START_SEND_TO,
} from "./google-ads-conversion.ts";
import { readStoredAdAttributionMetadata$ } from "./ad-attribution.ts";
import { sessionStorageSignals } from "../external/session-storage.ts";
import { resolveGoogleAdsAccount$ } from "./google-ads-account.ts";
import type { OnboardingRouteStep } from "../onboarding/onboarding-state.ts";

const ONBOARDING_START_CONVERSION_KEY =
  "vm0.googleAdsOnboardingStartConversionRecorded";
const CHECKOUT_START_CONVERSION_KEY =
  "vm0.googleAdsCheckoutStartConversionRecorded";
const ADSMARCH_ONBOARDING_START_CONVERSION_KEY =
  "vm0.googleAdsAdsmarchOnboardingStartConversionRecorded";
const ADSMARCH_CHECKOUT_START_CONVERSION_KEY =
  "vm0.googleAdsAdsmarchCheckoutStartConversionRecorded";
const ONBOARDING_START_CONVERSION_VALUE_USD = 1;
const CHECKOUT_START_CONVERSION_VALUE_USD = 1;
const ADSMARCH_CHECKOUT_START_CONVERSION_VALUE_USD = 5;
const onboardingStartConversionStorage = sessionStorageSignals(
  ONBOARDING_START_CONVERSION_KEY,
);
const checkoutStartConversionStorage = sessionStorageSignals(
  CHECKOUT_START_CONVERSION_KEY,
);
const adsmarchOnboardingStartConversionStorage = sessionStorageSignals(
  ADSMARCH_ONBOARDING_START_CONVERSION_KEY,
);
const adsmarchCheckoutStartConversionStorage = sessionStorageSignals(
  ADSMARCH_CHECKOUT_START_CONVERSION_KEY,
);

// Ordered so `step_index` / `step_count` stay comparable across the three
// template branches that share the same two-step shape.
const ONBOARDING_STEP_ORDER: readonly OnboardingRouteStep[] = [
  "make",
  "workflow-picker",
  "workflow-run",
  "presentation-template",
  "presentation-run",
  "image-template",
  "image-run",
  "video-template",
  "video-run",
];

type TelemetryProperties = Record<string, string | number | boolean>;

function attributionProperties(
  attribution: AdAttributionMetadata | undefined,
): TelemetryProperties {
  const properties: TelemetryProperties = {
    flow: "paid_onboarding",
    route_path: window.location.pathname,
  };
  if (!attribution) {
    return properties;
  }

  for (const [key, value] of Object.entries(
    compatibleGoogleAdsAttribution(attribution),
  )) {
    if (typeof value === "string" && value) {
      properties[key] = value;
    }
  }
  return properties;
}

export const capturePaidOnboardingStepViewed$ = command(
  async (
    { get, set },
    step: OnboardingRouteStep,
    signal: AbortSignal,
  ): Promise<void> => {
    const stepIndex = ONBOARDING_STEP_ORDER.indexOf(step);
    capturePaidOnboardingEvent("StepViewed", {
      ...attributionProperties(set(readStoredAdAttributionMetadata$)),
      step_key: step,
      step_index: stepIndex,
      step_count: ONBOARDING_STEP_ORDER.length,
    });

    // `Onboarding Start` counts one entry into the onboarding flow, so it is
    // deduped per session rather than fired on every step view.
    const accountId = await set(resolveGoogleAdsAccount$, signal);
    const config =
      accountId === GOOGLE_ADS_LEGACY_ACCOUNT_ID
        ? {
            sendTo: GOOGLE_ADS_ONBOARDING_START_SEND_TO,
            storage: onboardingStartConversionStorage,
            value: ONBOARDING_START_CONVERSION_VALUE_USD,
          }
        : accountId === GOOGLE_ADS_ADSMARCH_ACCOUNT_ID
          ? {
              sendTo: GOOGLE_ADS_ADSMARCH_ONBOARDING_START_SEND_TO,
              storage: adsmarchOnboardingStartConversionStorage,
              value: ONBOARDING_START_CONVERSION_VALUE_USD,
            }
          : null;
    if (!config) {
      return;
    }
    const conversionFired = fireGoogleAdsConversion({
      accountId,
      sendTo: config.sendTo,
      dedupeValue: config.sendTo,
      value: config.value,
      storedDedupeValue: get(config.storage.get$),
    });
    if (conversionFired) {
      set(config.storage.set$, config.sendTo);
    }
  },
);

export const capturePaidOnboardingCheckoutCreated$ = command(
  ({ set }, checkoutSource: string): void => {
    capturePaidOnboardingEvent("CheckoutCreated", {
      ...attributionProperties(set(readStoredAdAttributionMetadata$)),
      checkout_source: checkoutSource,
    });
  },
);

export const capturePaidOnboardingRoleConfirmed$ = command(
  ({ set }, role: string): void => {
    capturePaidOnboardingEvent("RoleConfirmed", {
      ...attributionProperties(set(readStoredAdAttributionMetadata$)),
      role,
    });
  },
);

export const capturePaidOnboardingRedirectToStripe$ = command(
  async (
    { get, set },
    checkoutSource: string,
    signal: AbortSignal,
  ): Promise<void> => {
    capturePaidOnboardingEvent("RedirectToStripe", {
      ...attributionProperties(set(readStoredAdAttributionMetadata$)),
      checkout_source: checkoutSource,
    });

    const accountId = await set(resolveGoogleAdsAccount$, signal);
    const config =
      accountId === GOOGLE_ADS_LEGACY_ACCOUNT_ID
        ? {
            sendTo: GOOGLE_ADS_CHECKOUT_START_SEND_TO,
            storage: checkoutStartConversionStorage,
            value: CHECKOUT_START_CONVERSION_VALUE_USD,
          }
        : accountId === GOOGLE_ADS_ADSMARCH_ACCOUNT_ID
          ? {
              sendTo: GOOGLE_ADS_ADSMARCH_CHECKOUT_START_SEND_TO,
              storage: adsmarchCheckoutStartConversionStorage,
              value: ADSMARCH_CHECKOUT_START_CONVERSION_VALUE_USD,
            }
          : null;
    if (!config) {
      return;
    }
    const conversionFired = fireGoogleAdsConversion({
      accountId,
      sendTo: config.sendTo,
      dedupeValue: config.sendTo,
      value: config.value,
      storedDedupeValue: get(config.storage.get$),
    });
    if (conversionFired) {
      set(config.storage.set$, config.sendTo);
    }
  },
);

export const capturePaidOnboardingAppHandoff$ = command(
  ({ set }, prompt: string): void => {
    capturePaidOnboardingEvent("AppHandoff", {
      ...attributionProperties(set(readStoredAdAttributionMetadata$)),
      destination: "app",
      prompt_present: prompt.trim().length > 0,
      prompt_length: prompt.length,
    });
  },
);
