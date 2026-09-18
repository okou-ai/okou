import { useGet, useSet } from "ccstate-react";
import {
  nextSourcesFirstStep,
  previousSourcesFirstStep,
  sourcesFirstDraft$,
  sourcesFirstFlow$,
  sourcesFirstProgress,
  type SourcesFirstDraft,
  type SourcesFirstFlow,
  type SourcesFirstStep,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";
import { ROUTES, type RoutePath } from "../../signals/route-paths.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";

const STEP_ROUTES: Readonly<Record<SourcesFirstStep, RoutePath>> = {
  sources: ROUTES.onboarding,
  industry: ROUTES.onboardingIndustry,
  team: ROUTES.onboardingTeam,
  experience: ROUTES.onboardingExperience,
  subscription: ROUTES.onboardingSubscription,
  skills: ROUTES.onboardingSkills,
  slack: ROUTES.onboardingSlack,
  ready: ROUTES.onboardingReady,
};

interface SourcesFirstFlowState {
  readonly flow: SourcesFirstFlow;
  readonly draft: SourcesFirstDraft;
  /** 1-based index for the progress bar. */
  readonly currentStep: number;
  readonly totalSteps: number;
  readonly goBack: (() => void) | undefined;
  /** Moves to the next step; the last step's action is its own. */
  readonly goNext: () => void;
  readonly goTo: (step: SourcesFirstStep) => void;
}

/**
 * Shared step arithmetic: which steps this run has, where the current one sits,
 * and where Back and Continue lead.
 */
export function useSourcesFirstFlow(
  step: SourcesFirstStep,
): SourcesFirstFlowState {
  const flow = useGet(sourcesFirstFlow$);
  const draft = useGet(sourcesFirstDraft$);
  const navigate = useSet(detachedNavigateTo$);
  const previous = previousSourcesFirstStep(step, flow, draft.experienced);
  const progress = sourcesFirstProgress(step, flow, draft.experienced);

  const goTo = (target: SourcesFirstStep): void => {
    navigate(STEP_ROUTES[target], { searchParams: new URLSearchParams() });
  };

  return {
    flow,
    draft,
    currentStep: progress.current,
    totalSteps: progress.total,
    goBack: previous
      ? () => {
          goTo(previous);
        }
      : undefined,
    goNext: () => {
      const next = nextSourcesFirstStep(step, flow, draft.experienced);
      if (next) {
        goTo(next);
      }
    },
    goTo,
  };
}
