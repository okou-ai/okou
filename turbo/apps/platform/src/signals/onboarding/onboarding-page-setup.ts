import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { OnboardingSourcesFirstPromptPage } from "../../views/onboarding-sources-first/onboarding-prompt-page.tsx";
import { hideAppSkeleton$, showAppSkeleton$ } from "../app-skeleton.ts";
import { brandName$ } from "../branding.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { promptHandoffParams } from "./onboarding-actions.ts";
import { hydrateOnboardingRoute$ } from "./onboarding-state.ts";
import { capturePaidOnboardingStepViewed$ } from "../bootstrap/paid-funnel-telemetry.ts";
import { onboardingStatus$ } from "../okou-page/onboarding.ts";
import { sendEvent$ } from "../marketing/events.ts";

/**
 * The prompt handoff: a visitor who brings a prompt of their own tries it on
 * a single step instead of the source-first flow's questions.
 */
export const setupOnboardingPromptPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(showAppSkeleton$);
    const searchParams = get(searchParams$);

    const status = await get(onboardingStatus$);
    signal.throwIfAborted();
    // The handoff sets up a workspace, which only an admin does.
    if (!status.needsOnboarding || !status.isAdmin) {
      const prompt = searchParams.get("prompt")?.trim();
      set(detachedNavigateTo$, prompt ? ROUTES.prompt : ROUTES.home, {
        searchParams: prompt
          ? promptHandoffParams(searchParams)
          : new URLSearchParams(),
        replace: true,
      });
      return;
    }

    set(sendEvent$, "onboarding-start");
    set(hydrateOnboardingRoute$, searchParams);

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
