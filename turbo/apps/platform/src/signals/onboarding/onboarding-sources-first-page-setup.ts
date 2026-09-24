import { command, type Command } from "ccstate";
import { createElement, type ComponentType } from "react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  OnboardingSkillsPage,
  OnboardingSlackPage,
} from "../../views/onboarding-sources-first/onboarding-import-pages.tsx";
import { OnboardingReadyPage } from "../../views/onboarding-sources-first/onboarding-ready-page.tsx";
import { OnboardingProfilePage } from "../../views/onboarding-sources-first/onboarding-profile-page.tsx";
import {
  OnboardingExperiencePage,
  OnboardingIndustryPage,
  OnboardingTeamPage,
} from "../../views/onboarding-sources-first/onboarding-setup-pages.tsx";
import { OnboardingSourcesPage } from "../../views/onboarding-sources-first/onboarding-sources-page.tsx";
import { i18n } from "../../i18n/index.ts";
import { hideAppSkeleton$, showAppSkeleton$ } from "../app-skeleton.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import { captureSourceOnboardingStepViewed$ } from "../bootstrap/source-onboarding-telemetry.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { builtinConnectors$ } from "../external/connectors.ts";
import { sendEvent$ } from "../marketing/events.ts";
import {
  setAgentPhoneConnectDialogOpen$,
  watchAgentPhoneConnection$,
} from "../okou-page/agentphone.ts";
import { onboardingStatus$ } from "../okou-page/onboarding.ts";
import { watchSlackConnection$ } from "../okou-page/slack.ts";
import { watchTeamsConnection$ } from "../okou-page/teams.ts";
import { page$, updatePage$ } from "../react-router.ts";
import { detachedNavigateTo$, searchParams$ } from "../route.ts";
import { ROUTES, type RoutePath } from "../route-paths.ts";
import { detach, Reason } from "../utils.ts";
import {
  promptHandoffParams,
  setupOnboardingMakePage$,
} from "./onboarding-page-setup.ts";
import { enterSkillImport$ } from "./onboarding-skill-import.ts";
import {
  allowOnboardingRecommendationFallback$,
  resumeOnboardingRecommendation$,
} from "./onboarding-recommendation.ts";
import {
  claimSourcesFirstStartEvent$,
  clearSourcesFirstDraft$,
  restoreSourcesFirstDraft$,
  setSourcesFirstFlow$,
  sourcesFirstDraft$,
  sourcesFirstSteps,
  type SourcesFirstStep,
} from "./onboarding-sources-first-state.ts";

interface SourcesFirstPageConfig {
  readonly step: SourcesFirstStep;
  readonly title: () => string;
  readonly Page: ComponentType;
  /**
   * Live subscriptions this step needs, owned by the step's own signal. They
   * start once the step is known to render, so a redirect never leaves one
   * listening behind it.
   */
  readonly watch?: readonly Command<Promise<void>, [AbortSignal]>[];
  /**
   * Finite work the step needs before it is any use, such as opening a
   * session it has to show. Unlike `watch` it is awaited, so the step's own
   * events stay in order behind `StepViewed`; it owns the route's signal, and
   * it reports its own failure rather than keeping the step from opening.
   */
  readonly enter?: Command<Promise<void>, [AbortSignal]>;
}

const sourcesFirstEnabled$ = command(
  async ({ get }, signal: AbortSignal): Promise<boolean> => {
    const switches = await get(featureSwitches$);
    signal.throwIfAborted();
    return switches[FeatureSwitchKey.OnboardingSourcesFirst] ?? false;
  },
);

/**
 * A redirect inside the flow keeps the query it arrived with: the Marketing
 * `prompt` handoff and a `redeemCode` have to survive until the last step
 * completes onboarding and opens the first request.
 */
const redirectTo$ = command(({ get, set }, path: RoutePath) => {
  set(detachedNavigateTo$, path, {
    searchParams: new URLSearchParams(get(searchParams$)),
    replace: true,
  });
});

/**
 * Nothing is left to onboard, so the visitor goes where the make-something
 * flow sends them: to their prompt when they brought one, and home otherwise.
 */
const forwardOnboardedVisitor$ = command(({ get, set }) => {
  const searchParams = get(searchParams$);
  const prompt = searchParams.get("prompt")?.trim();
  set(detachedNavigateTo$, prompt ? ROUTES.prompt : ROUTES.home, {
    searchParams: prompt
      ? promptHandoffParams(searchParams)
      : new URLSearchParams(),
    replace: true,
  });
});

function createSourcesFirstPageSetup(
  config: SourcesFirstPageConfig,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (!get(page$)) {
      set(showAppSkeleton$);
    }

    if (!(await set(sourcesFirstEnabled$, signal))) {
      signal.throwIfAborted();
      set(redirectTo$, ROUTES.onboarding);
      return;
    }

    const status = await get(onboardingStatus$);
    signal.throwIfAborted();
    if (status.hasOrg) {
      const { orgId, userId } = await get(authenticatedIdentity$);
      signal.throwIfAborted();
      set(restoreSourcesFirstDraft$, { orgId, userId });
    }
    if (!status.needsOnboarding) {
      set(clearSourcesFirstDraft$);
      set(forwardOnboardedVisitor$);
      return;
    }
    set(resumeOnboardingRecommendation$, signal);

    // The run started, whichever step this setup ended up on: a guard redirect
    // below, or the way back, still belongs to the same run.
    if (set(claimSourcesFirstStartEvent$)) {
      set(sendEvent$, "onboarding-start");
    }

    // A member invited into an existing org runs the flow without the invite
    // and Slack steps.
    const flow = status.isAdmin ? "owner" : "member";
    set(setSourcesFirstFlow$, flow);

    const draft = get(sourcesFirstDraft$);
    if (config.step === "profile" && draft.industry === null) {
      set(redirectTo$, ROUTES.onboarding);
      return;
    }
    if (config.step !== "industry" && config.step !== "sources") {
      // The user's own connections, reloaded on connect, decide whether any
      // source is there yet; the catalog is not needed for that.
      const { connectors } = await get(builtinConnectors$);
      signal.throwIfAborted();
      const hasSource = connectors.length > 0;
      if (!hasSource) {
        set(redirectTo$, ROUTES.onboarding);
        return;
      }
    }

    if (!sourcesFirstSteps(flow, draft.provider).includes(config.step)) {
      // The step is not part of this run's branch, for example a member
      // opening the invite step or a new user opening the skills step.
      set(redirectTo$, ROUTES.onboardingExperience);
      return;
    }

    set(updatePage$, createElement(config.Page), "none");
    set(updateDocumentTitle$, config.title());
    // One integration's status decides what a step offers, never whether the
    // step opens: a daemon keeps a failing integration out of the flow's way,
    // and the step says what it could not reach.
    for (const watch$ of config.watch ?? []) {
      detach(set(watch$, signal), Reason.Daemon, "onboarding step status");
    }
    await set(hideAppSkeleton$, signal);
    set(captureSourceOnboardingStepViewed$, config.step);
    // The step is on screen first, so its own work is something the person
    // watches happen rather than something they wait through.
    if (config.enter) {
      await set(config.enter, signal);
    }
  });
}

export const setupOnboardingSourcesPage$ = createSourcesFirstPageSetup({
  step: "sources",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.sourcesFirst.documentTitles.sources;
    });
  },
  Page: OnboardingSourcesPage,
});

const setupOnboardingIndustryEntryPage$ = createSourcesFirstPageSetup({
  step: "industry",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.sourcesFirst.documentTitles.industry;
    });
  },
  Page: OnboardingIndustryPage,
});

/**
 * `/onboarding` keeps its public path: the switch decides whether it opens the
 * source-first flow's first question or the make-something page.
 */
export const setupOnboardingEntryPage$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    if (await set(sourcesFirstEnabled$, signal)) {
      signal.throwIfAborted();
      await set(setupOnboardingIndustryEntryPage$, signal);
      return;
    }
    signal.throwIfAborted();
    await set(setupOnboardingMakePage$, signal);
  },
);

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

export const setupOnboardingSkillsPage$ = createSourcesFirstPageSetup({
  step: "skills",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.sourcesFirst.documentTitles.skills;
    });
  },
  Page: OnboardingSkillsPage,
  enter: enterSkillImport$,
});

export const setupOnboardingProfilePage$ = createSourcesFirstPageSetup({
  step: "profile",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.sourcesFirst.documentTitles.profile;
    });
  },
  Page: OnboardingProfilePage,
});

/**
 * The AgentPhone tile shows a real link, so the step watches that link for as
 * long as it is open. It is behind the same switch as the Works page entry,
 * and the watcher only runs where the tile does.
 */
const watchOnboardingAgentPhone$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const switches = await get(featureSwitches$);
    signal.throwIfAborted();
    if (!switches[FeatureSwitchKey.AgentPhoneEntry]) {
      return;
    }
    set(setAgentPhoneConnectDialogOpen$, false);
    await set(watchAgentPhoneConnection$, signal);
  },
);

export const setupOnboardingSlackPage$ = createSourcesFirstPageSetup({
  step: "slack",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.sourcesFirst.documentTitles.slack;
    });
  },
  Page: OnboardingSlackPage,
  // The install finishes in the provider's own tab, so the step only learns it
  // happened from the realtime change these watchers subscribe to. AgentPhone
  // is linked from a phone, which the step never sees either.
  watch: [
    watchSlackConnection$,
    watchTeamsConnection$,
    watchOnboardingAgentPhone$,
  ],
});

export const setupOnboardingReadyPage$ = createSourcesFirstPageSetup({
  step: "ready",
  title: () => {
    return i18n.t(($) => {
      return $.onboarding.sourcesFirst.documentTitles.ready;
    });
  },
  Page: OnboardingReadyPage,
  enter: allowOnboardingRecommendationFallback$,
});
