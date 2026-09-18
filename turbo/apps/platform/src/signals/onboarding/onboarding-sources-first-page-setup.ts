import { command, type Command } from "ccstate";
import { createElement, type ComponentType } from "react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  OnboardingSkillsPage,
  OnboardingSlackPage,
} from "../../views/onboarding-sources-first/onboarding-import-pages.tsx";
import { OnboardingReadyPage } from "../../views/onboarding-sources-first/onboarding-ready-page.tsx";
import {
  OnboardingExperiencePage,
  OnboardingIndustryPage,
  OnboardingSubscriptionPage,
  OnboardingTeamPage,
} from "../../views/onboarding-sources-first/onboarding-setup-pages.tsx";
import { OnboardingSourcesPage } from "../../views/onboarding-sources-first/onboarding-sources-page.tsx";
import { i18n } from "../../i18n/index.ts";
import { hideAppSkeleton$, showAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { connectorCatalogStatus$ } from "../external/connectors.ts";
import { onboardingStatus$ } from "../okou-page/onboarding.ts";
import { updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES, type RoutePath } from "../route-paths.ts";
import { setupOnboardingMakePage$ } from "./onboarding-page-setup.ts";
import {
  setSourcesFirstFlow$,
  sourcesFirstDraft$,
  sourcesFirstSteps,
  type SourcesFirstStep,
} from "./onboarding-sources-first-state.ts";

interface SourcesFirstPageConfig {
  readonly step: SourcesFirstStep;
  readonly title: () => string;
  readonly Page: ComponentType;
}

const sourcesFirstEnabled$ = command(
  async ({ get }, signal: AbortSignal): Promise<boolean> => {
    const switches = await get(featureSwitches$);
    signal.throwIfAborted();
    return switches[FeatureSwitchKey.OnboardingSourcesFirst] ?? false;
  },
);

const redirectTo$ = command(({ set }, path: RoutePath) => {
  set(detachedNavigateTo$, path, {
    searchParams: new URLSearchParams(),
    replace: true,
  });
});

function createSourcesFirstPageSetup(
  config: SourcesFirstPageConfig,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal) => {
    set(showAppSkeleton$);

    if (!(await set(sourcesFirstEnabled$, signal))) {
      signal.throwIfAborted();
      set(redirectTo$, ROUTES.onboarding);
      return;
    }

    const status = await get(onboardingStatus$);
    signal.throwIfAborted();
    if (!status.needsOnboarding) {
      set(redirectTo$, ROUTES.home);
      return;
    }

    // A member invited into an existing org runs the flow without the invite
    // and Slack steps.
    const flow = status.isAdmin ? "owner" : "member";
    set(setSourcesFirstFlow$, flow);

    const draft = get(sourcesFirstDraft$);
    if (config.step !== "sources") {
      const { connectors } = await get(connectorCatalogStatus$);
      signal.throwIfAborted();
      const hasSource = connectors.some((connector) => {
        return connector.connected;
      });
      if (!hasSource) {
        set(redirectTo$, ROUTES.onboarding);
        return;
      }
    }

    if (!sourcesFirstSteps(flow, draft.experienced).includes(config.step)) {
      // The step is not part of this run's branch, for example a member
      // opening the invite step or a new user opening the skills step.
      set(redirectTo$, ROUTES.onboardingExperience);
      return;
    }

    set(updatePage$, createElement(config.Page), "none");
    set(updateDocumentTitle$, config.title());
    await set(hideAppSkeleton$, signal);
  });
}

const setupOnboardingSourcesPage$ = createSourcesFirstPageSetup({
  step: "sources",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.sourcesFirst.documentTitles.sources;
    });
  },
  Page: OnboardingSourcesPage,
});

/**
 * `/onboarding` keeps its public path: the switch decides whether it opens the
 * source-first first step or the make-something page.
 */
export const setupOnboardingEntryPage$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    if (await set(sourcesFirstEnabled$, signal)) {
      signal.throwIfAborted();
      await set(setupOnboardingSourcesPage$, signal);
      return;
    }
    signal.throwIfAborted();
    await set(setupOnboardingMakePage$, signal);
  },
);

export const setupOnboardingIndustryPage$ = createSourcesFirstPageSetup({
  step: "industry",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.sourcesFirst.documentTitles.industry;
    });
  },
  Page: OnboardingIndustryPage,
});

export const setupOnboardingTeamPage$ = createSourcesFirstPageSetup({
  step: "team",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.sourcesFirst.documentTitles.team;
    });
  },
  Page: OnboardingTeamPage,
});

export const setupOnboardingExperiencePage$ = createSourcesFirstPageSetup({
  step: "experience",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.sourcesFirst.documentTitles.experience;
    });
  },
  Page: OnboardingExperiencePage,
});

export const setupOnboardingSubscriptionPage$ = createSourcesFirstPageSetup({
  step: "subscription",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.sourcesFirst.documentTitles.subscription;
    });
  },
  Page: OnboardingSubscriptionPage,
});

export const setupOnboardingSkillsPage$ = createSourcesFirstPageSetup({
  step: "skills",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.sourcesFirst.documentTitles.skills;
    });
  },
  Page: OnboardingSkillsPage,
});

export const setupOnboardingSlackPage$ = createSourcesFirstPageSetup({
  step: "slack",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.sourcesFirst.documentTitles.slack;
    });
  },
  Page: OnboardingSlackPage,
});

export const setupOnboardingReadyPage$ = createSourcesFirstPageSetup({
  step: "ready",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.sourcesFirst.documentTitles.ready;
    });
  },
  Page: OnboardingReadyPage,
});
