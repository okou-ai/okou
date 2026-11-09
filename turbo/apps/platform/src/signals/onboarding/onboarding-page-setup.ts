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
import { promptHandoffParams } from "./onboarding-actions.ts";
import {
  hydrateOnboardingRoute$,
  resetOnboardingDraft$,
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
    if (
      !status.needsOnboarding ||
      (!status.isAdmin && !searchParams.get("handoff"))
    ) {
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

    set(subscribeBuiltinConnectorChanges$, signal);
    set(sendEvent$, "onboarding-start");
    const handoff = await set(loadMarketingHandoff$, signal);
    signal.throwIfAborted();
    set(hydrateOnboardingRoute$, searchParams, handoff?.manifest);
    signal.addEventListener(
      "abort",
      () => {
        set(resetOnboardingDraft$);
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
