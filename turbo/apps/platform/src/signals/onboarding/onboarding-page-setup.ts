import { command, type Command } from "ccstate";
import { createElement, type ComponentType } from "react";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import {
  CUSTOM_WORKFLOW_ID,
  hasOnboardingWorkflow,
} from "../../views/onboarding/onboarding-data.ts";
import { i18n } from "../../i18n/index.ts";
import { OnboardingMakePage } from "../../views/onboarding/onboarding-make-page.tsx";
import { OnboardingWorkflowPickerPage } from "../../views/onboarding/onboarding-workflow-picker-page.tsx";
import { OnboardingWorkflowRunPage } from "../../views/onboarding/onboarding-workflow-run-page.tsx";
import {
  OnboardingImageTemplatePage,
  OnboardingPresentationTemplatePage,
} from "../../views/onboarding/onboarding-template-picker-pages.tsx";
import {
  OnboardingImageRunPage,
  OnboardingPresentationRunPage,
} from "../../views/onboarding/onboarding-template-run-pages.tsx";
import { hideAppSkeleton$, showAppSkeleton$ } from "../app-skeleton.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import { brandName$, type BrandName } from "../branding.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { ROUTES, type RoutePath } from "../route-paths.ts";
import {
  completeOnboarding$,
  completeOnboardingCheckoutReturn$,
} from "./onboarding-actions.ts";
import {
  hydrateOnboardingRoute$,
  onboardingDraft$,
  resetOnboardingDraft$,
  readOnboardingCheckoutDraft$,
  ONBOARDING_CHECKOUT_STATE_PARAM,
  type OnboardingDraft,
  type OnboardingRouteStep,
} from "./onboarding-state.ts";
import { capturePaidOnboardingStepViewed$ } from "../bootstrap/paid-funnel-telemetry.ts";
import { onboardingStatus$ } from "../okou-page/onboarding.ts";
import { sendEvent$ } from "../marketing/events.ts";

interface OnboardingPageConfig {
  readonly step: OnboardingRouteStep;
  readonly title: (brandName: BrandName) => string;
  readonly Page: ComponentType;
  readonly fallbackPath?: RoutePath;
}

const ONBOARDING_TRANSIENT_PARAMS = [
  "choice",
  "category",
  "workflow",
  "onboarding_billing",
  "onboarding_billing_session_id",
  "onboarding_note",
  "onboarding_template",
  ONBOARDING_CHECKOUT_STATE_PARAM,
  "redeemCode",
] as const;

/**
 * The query a prompt handoff carries on, with every parameter that only
 * belonged to the onboarding step itself dropped. Shared with the source-first
 * flow so both hand an already-onboarded visitor the same URL.
 */
export function promptHandoffParams(
  searchParams: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  for (const key of ONBOARDING_TRANSIENT_PARAMS) {
    next.delete(key);
  }
  return next;
}

function hasRequiredSelection(
  step: OnboardingRouteStep,
  draft: OnboardingDraft,
): boolean {
  if (step === "workflow-run") {
    return (
      draft.workflowId === CUSTOM_WORKFLOW_ID ||
      hasOnboardingWorkflow(draft.workflowId)
    );
  }
  if (step === "presentation-run") {
    return PRESENTATION_TEMPLATE_PICKER_ITEMS.some((item) => {
      return item.slug === draft.presentationTemplateSlug;
    });
  }
  if (step === "image-run") {
    return ILLUSTRATION_TEMPLATE_ITEMS.some((item) => {
      return item.slug === draft.imageTemplateSlug;
    });
  }
  return true;
}

function createOnboardingPageSetup(
  config: OnboardingPageConfig,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal) => {
    set(showAppSkeleton$);
    const searchParams = get(searchParams$);
    const { userId } = await get(authenticatedIdentity$);
    signal.throwIfAborted();

    const status = await get(onboardingStatus$);
    signal.throwIfAborted();
    if (!status.needsOnboarding) {
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
    set(hydrateOnboardingRoute$, config.step, searchParams, userId);
    const draft = get(onboardingDraft$);
    if (config.fallbackPath && !hasRequiredSelection(config.step, draft)) {
      set(detachedNavigateTo$, config.fallbackPath, {
        searchParams,
        replace: true,
      });
      return;
    }

    const title = config.title(get(brandName$));
    set(updatePage$, createElement(config.Page), "none");
    set(updateDocumentTitle$, title);
    await set(hideAppSkeleton$, signal);
    set(capturePaidOnboardingStepViewed$, config.step);
  });
}

export const setupOnboardingMakePage$ = createOnboardingPageSetup({
  step: "make",
  title: (brandName) => {
    return i18n.t(
      ($) => {
        return $.onboarding.documentTitles.make;
      },
      { brandName },
    );
  },
  Page: OnboardingMakePage,
});

export const setupOnboardingWorkflowPickerPage$ = createOnboardingPageSetup({
  step: "workflow-picker",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.documentTitles.chooseWorkflow;
    });
  },
  Page: OnboardingWorkflowPickerPage,
});

export const setupOnboardingWorkflowRunPage$ = createOnboardingPageSetup({
  step: "workflow-run",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.documentTitles.runWorkflow;
    });
  },
  Page: OnboardingWorkflowRunPage,
  fallbackPath: ROUTES.onboardingWorkflowPicker,
});

export const setupOnboardingPresentationTemplatePage$ =
  createOnboardingPageSetup({
    step: "presentation-template",
    title: () => {
      return i18n.t(($) => {
        return $.onboarding.documentTitles.choosePresentation;
      });
    },
    Page: OnboardingPresentationTemplatePage,
  });

export const setupOnboardingPresentationRunPage$ = createOnboardingPageSetup({
  step: "presentation-run",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.documentTitles.runPresentation;
    });
  },
  Page: OnboardingPresentationRunPage,
  fallbackPath: ROUTES.onboardingPresentationTemplate,
});

export const setupOnboardingImageTemplatePage$ = createOnboardingPageSetup({
  step: "image-template",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.documentTitles.chooseImage;
    });
  },
  Page: OnboardingImageTemplatePage,
});

export const setupOnboardingImageRunPage$ = createOnboardingPageSetup({
  step: "image-run",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.documentTitles.runImage;
    });
  },
  Page: OnboardingImageRunPage,
  fallbackPath: ROUTES.onboardingImageTemplate,
});

/**
 * Bridge pre-retirement App checkout returns. Remove with #36506 after the
 * replacement App is live, its version floor excludes old checkout creators,
 * the old App is outside the rollback window, and all issued video-onboarding
 * sessions are terminal with payment and onboarding fulfillment reconciled.
 */
export const setupRetiredOnboardingVideoPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(showAppSkeleton$);
    const params = get(searchParams$);
    const { userId } = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    const checkoutDraft = set(readOnboardingCheckoutDraft$, params, userId);
    const prompt =
      checkoutDraft?.note.trim() ||
      params.get("prompt")?.trim() ||
      checkoutDraft?.prompt.trim();
    const checkoutSessionId = params.get("onboarding_billing_session_id");
    if (checkoutSessionId) {
      await set(completeOnboardingCheckoutReturn$, checkoutSessionId, signal);
      await set(
        completeOnboarding$,
        params.get("redeemCode")?.trim() || null,
        signal,
      );
    }
    signal.throwIfAborted();
    set(resetOnboardingDraft$);
    // Open the recovered brief for editing. Do not auto-submit the old
    // template prompt after a completed payment or a stale marketing link.
    set(detachedNavigateTo$, ROUTES.home, {
      searchParams: new URLSearchParams(prompt ? { prompt } : {}),
      replace: true,
    });
  },
);
