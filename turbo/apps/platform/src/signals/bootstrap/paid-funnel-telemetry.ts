// Paid-onboarding product analytics. Marketing owns attribution and advertising delivery.
import { command } from "ccstate";
import { capturePaidOnboardingEvent } from "../../lib/posthog.ts";
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

function telemetryProperties(): TelemetryProperties {
  return {
    flow: "paid_onboarding",
    route_path: window.location.pathname,
  };
}

export const capturePaidOnboardingStepViewed$ = command(
  (_context, step: OnboardingRouteStep): void => {
    const stepIndex = ONBOARDING_STEP_ORDER.indexOf(step);
    capturePaidOnboardingEvent("StepViewed", {
      ...telemetryProperties(),
      step_key: step,
      step_index: stepIndex,
      step_count: ONBOARDING_STEP_ORDER.length,
    });
  },
);

export const capturePaidOnboardingCheckoutCreated$ = command(
  (_context, checkoutSource: string): void => {
    capturePaidOnboardingEvent("CheckoutCreated", {
      ...telemetryProperties(),
      checkout_source: checkoutSource,
    });
  },
);

export const capturePaidOnboardingRoleConfirmed$ = command(
  (_context, role: string): void => {
    capturePaidOnboardingEvent("RoleConfirmed", {
      ...telemetryProperties(),
      role,
    });
  },
);

export const capturePaidOnboardingRedirectToStripe$ = command(
  ({ set }, checkoutSource: "onboarding_video" | "paywall"): void => {
    set(sendEvent$, "checkout-start");
    capturePaidOnboardingEvent("RedirectToStripe", {
      ...telemetryProperties(),
      checkout_source: checkoutSource,
    });
  },
);

export const capturePaidOnboardingAppHandoff$ = command(
  (_context, prompt: string): void => {
    capturePaidOnboardingEvent("AppHandoff", {
      ...telemetryProperties(),
      destination: "app",
      prompt_present: prompt.trim().length > 0,
      prompt_length: prompt.length,
    });
  },
);
