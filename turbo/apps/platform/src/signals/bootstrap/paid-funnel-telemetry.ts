// Paid-onboarding product analytics. Marketing owns attribution and advertising delivery.
import { command } from "ccstate";
import { capturePaidOnboardingEvent } from "../../lib/posthog.ts";
import { sendEvent$ } from "../marketing/events.ts";

type TelemetryProperties = Record<string, string | number | boolean>;

function telemetryProperties(): TelemetryProperties {
  return {
    flow: "paid_onboarding",
    route_path: window.location.pathname,
  };
}

/**
 * The prompt handoff is the one onboarding step this funnel still sees. It
 * keeps the `make` key the step has always reported under.
 */
export const capturePaidOnboardingStepViewed$ = command((): void => {
  capturePaidOnboardingEvent("StepViewed", {
    ...telemetryProperties(),
    step_key: "make",
    step_index: 0,
    step_count: 1,
  });
});

export const capturePaidOnboardingCheckoutCreated$ = command(
  (_context, checkoutSource: string): void => {
    capturePaidOnboardingEvent("CheckoutCreated", {
      ...telemetryProperties(),
      checkout_source: checkoutSource,
    });
  },
);

export const capturePaidOnboardingRedirectToStripe$ = command(
  ({ set }, checkoutSource: "paywall"): void => {
    set(sendEvent$, "checkout-start");
    capturePaidOnboardingEvent("RedirectToStripe", {
      ...telemetryProperties(),
      checkout_source: checkoutSource,
    });
  },
);
