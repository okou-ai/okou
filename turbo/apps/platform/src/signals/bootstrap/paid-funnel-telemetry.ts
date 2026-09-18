import { compatibleGoogleAdsAttribution } from "@okouai/core/google-ads-attribution";
// Paid-onboarding product analytics. Marketing owns advertising delivery.
import type { AdAttributionMetadata } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { command } from "ccstate";
import { capturePaidOnboardingEvent } from "../../lib/posthog.ts";
import { readStoredAdAttributionMetadata$ } from "./ad-attribution.ts";
import type { OnboardingRouteStep } from "../onboarding/onboarding-state.ts";
import { sendEvent$ } from "../marketing/events.ts";

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
  ({ set }, step: OnboardingRouteStep): void => {
    const stepIndex = ONBOARDING_STEP_ORDER.indexOf(step);
    capturePaidOnboardingEvent("StepViewed", {
      ...attributionProperties(set(readStoredAdAttributionMetadata$)),
      step_key: step,
      step_index: stepIndex,
      step_count: ONBOARDING_STEP_ORDER.length,
    });
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
  ({ set }, checkoutSource: "onboarding_video" | "paywall"): void => {
    set(sendEvent$, "checkout-start");
    capturePaidOnboardingEvent("RedirectToStripe", {
      ...attributionProperties(set(readStoredAdAttributionMetadata$)),
      checkout_source: checkoutSource,
    });
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
