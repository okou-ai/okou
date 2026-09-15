import { command } from "ccstate";
import {
  enqueueMarketingEvent$,
  flushMarketingEvent$,
} from "./marketing-events.ts";
import type { OnboardingRouteStep } from "../onboarding/onboarding-state.ts";

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
export const capturePaidOnboardingStepViewed$ = command(
  async ({ set }, step: OnboardingRouteStep, signal: AbortSignal) => {
    await set(
      enqueueMarketingEvent$,
      "StepViewed",
      {
        route_path: window.location.pathname,
        step_key: step,
        step_index: ONBOARDING_STEP_ORDER.indexOf(step),
        step_count: ONBOARDING_STEP_ORDER.length,
      },
      signal,
    );
  },
);
export const capturePaidOnboardingCheckoutCreated$ = command(
  async ({ set }, checkoutSource: string, signal: AbortSignal) => {
    await set(
      enqueueMarketingEvent$,
      "CheckoutCreated",
      { checkout_source: checkoutSource },
      signal,
    );
  },
);
export const capturePaidOnboardingRoleConfirmed$ = command(
  async ({ set }, role: string, signal: AbortSignal) => {
    await set(enqueueMarketingEvent$, "RoleConfirmed", { role }, signal);
  },
);
export const capturePaidOnboardingRedirectToStripe$ = command(
  async ({ set }, checkoutSource: string, signal: AbortSignal) => {
    const id = await set(
      enqueueMarketingEvent$,
      "RedirectToStripe",
      { checkout_source: checkoutSource },
      signal,
    );
    await set(flushMarketingEvent$, id, signal);
  },
);
export const capturePaidOnboardingAppHandoff$ = command(
  async ({ set }, prompt: string, signal: AbortSignal) => {
    await set(
      enqueueMarketingEvent$,
      "AppHandoff",
      {
        destination: "app",
        prompt_present: prompt.trim().length > 0,
        prompt_length: prompt.length,
      },
      signal,
    );
  },
);
