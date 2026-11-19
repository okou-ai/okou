import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { loadMarketingHandoff$ } from "../prompt-page/marketing-handoff.ts";
import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { OnboardingSourcesFirstPromptPage } from "../../views/onboarding-sources-first/onboarding-prompt-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { brandName$ } from "../branding.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { subscribeBuiltinConnectorChanges$ } from "../external/connectors.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import {
  forwardOnboardedVisitor$,
  promptHandoffParams,
} from "./onboarding-actions.ts";
import { trySkipOnboarding$ } from "./onboarding-entry.ts";
import { claimSourcesFirstStartEvent$ } from "./onboarding-sources-first-state.ts";
import {
  clearOnboardingPasteState$,
  hydrateOnboardingRoute$,
} from "./onboarding-state.ts";
import { capturePaidOnboardingStepViewed$ } from "../bootstrap/paid-funnel-telemetry.ts";
import { onboardingStatus$ } from "../okou-page/onboarding.ts";
import { sendEvent$ } from "../marketing/events.ts";

/**
 * The prompt handoff: a visitor who brings a prompt of their own tries it on
 * a single step instead of the source-first flow's questions.
 */
export const setupOnboardingPromptPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const searchParams = get(searchParams$);

    const status = await get(onboardingStatus$);
    signal.throwIfAborted();
    // Legacy prompt links provision a workspace. Hash handoffs also preserve
    // an invited member's task while they complete their personal onboarding.
    if (!status.needsOnboarding) {
      await set(forwardOnboardedVisitor$, status.isAdmin, signal);
      return;
    }
    if (await set(trySkipOnboarding$, signal)) {
      return;
    }
    if (!status.isAdmin && !searchParams.get("handoff")) {
      const prompt =
        searchParams.get("handoff") || searchParams.get("prompt")?.trim();
      set(detachedNavigateTo$, prompt ? ROUTES.prompt : ROUTES.home, {
        searchParams: prompt
          ? promptHandoffParams(searchParams)
          : new URLSearchParams(),
        replace: true,
      });
      return;
    }

    const handoff = await set(loadMarketingHandoff$, signal);
    signal.throwIfAborted();
    if (searchParams.get("handoff") && !handoff) {
      set(detachedNavigateTo$, ROUTES.onboarding, {
        searchParams: get(searchParams$),
        replace: true,
      });
      return;
    }
    set(subscribeBuiltinConnectorChanges$, signal);
    if (set(claimSourcesFirstStartEvent$)) {
      set(sendEvent$, "onboarding-start");
    }
    const features = await get(featureSwitches$);
    signal.throwIfAborted();
    set(
      hydrateOnboardingRoute$,
      searchParams,
      handoff?.manifest,
      features[FeatureSwitchKey.OnboardingMultipleOutputs],
    );
    signal.addEventListener(
      "abort",
      () => {
        // Route cancellation can precede the next screen's first paint. Release
        // retained upload Files without blanking the still-visible draft.
        set(clearOnboardingPasteState$);
      },
      { once: true },
    );

    const title = i18n.t(
      ($) => {
        return $.onboarding.documentTitles.make;
      },
      { brandName: get(brandName$) },
    );
    set(updatePage$, createElement(OnboardingSourcesFirstPromptPage), "none");
    set(updateDocumentTitle$, title);
    await set(hideAppSkeleton$, signal);
    set(capturePaidOnboardingStepViewed$);
  },
);
