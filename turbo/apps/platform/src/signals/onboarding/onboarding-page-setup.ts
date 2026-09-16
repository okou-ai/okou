import { bestEffort } from "../utils.ts";
import { command, type Command } from "ccstate";
import { createElement, type ComponentType } from "react";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { VIDEO_TEMPLATE_ITEMS } from "@okouai/core/video-template-items";
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
  OnboardingVideoTemplatePage,
} from "../../views/onboarding/onboarding-template-picker-pages.tsx";
import {
  OnboardingImageRunPage,
  OnboardingPresentationRunPage,
  OnboardingVideoRunPage,
} from "../../views/onboarding/onboarding-template-run-pages.tsx";
import { hideAppSkeleton$, showAppSkeleton$ } from "../app-skeleton.ts";
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
  ONBOARDING_CHECKOUT_STATE_PARAM,
  readOnboardingCheckoutDraft$,
  type OnboardingDraft,
  type OnboardingRouteStep,
} from "./onboarding-state.ts";
import {
  capturePaidOnboardingAppHandoff$,
  capturePaidOnboardingStepViewed$,
} from "../bootstrap/paid-funnel-telemetry.ts";
import { onboardingStatus$ } from "../okou-page/onboarding.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import { enterImpactOnboarding$ } from "./onboarding-impact.ts";

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

function promptHandoffParams(searchParams: URLSearchParams): URLSearchParams {
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
  if (step === "video-run") {
    return VIDEO_TEMPLATE_ITEMS.some((item) => {
      return item.slug === draft.videoTemplateSlug;
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

    if (config.step === "video-run") {
      const checkoutDraft = set(readOnboardingCheckoutDraft$, searchParams);
      const checkoutSessionId = searchParams.get(
        "onboarding_billing_session_id",
      );
      const checkoutPrompt =
        searchParams.get("prompt") ?? checkoutDraft?.prompt ?? null;
      if (checkoutSessionId && checkoutPrompt?.trim()) {
        await set(completeOnboardingCheckoutReturn$, checkoutSessionId, signal);
        await set(
          completeOnboarding$,
          searchParams.get("redeemCode")?.trim() || null,
          signal,
        );
        const handoffParams = promptHandoffParams(searchParams);
        handoffParams.set("prompt", checkoutPrompt);
        await set(capturePaidOnboardingAppHandoff$, checkoutPrompt, signal);
        set(detachedNavigateTo$, ROUTES.prompt, {
          searchParams: handoffParams,
          replace: true,
        });
        return;
      }
    }

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

    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    set(enterImpactOnboarding$, identity);
    set(hydrateOnboardingRoute$, config.step, searchParams);
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
    await bestEffort(
      set(capturePaidOnboardingStepViewed$, config.step, signal),
      signal,
    );
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

export const setupOnboardingVideoTemplatePage$ = createOnboardingPageSetup({
  step: "video-template",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.documentTitles.chooseVideo;
    });
  },
  Page: OnboardingVideoTemplatePage,
});

export const setupOnboardingVideoRunPage$ = createOnboardingPageSetup({
  step: "video-run",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.documentTitles.runVideo;
    });
  },
  Page: OnboardingVideoRunPage,
  fallbackPath: ROUTES.onboardingVideoTemplate,
});
