import { useGet, useSet } from "ccstate-react";
import {
  nextSourcesFirstStep,
  previousSourcesFirstStep,
  sourcesFirstDraft$,
  sourcesFirstFlow$,
  sourcesFirstStepIndex,
  sourcesFirstSteps,
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
};

export function sourcesFirstStepRoute(step: SourcesFirstStep): RoutePath {
  return STEP_ROUTES[step];
}

export interface SourcesFirstFlowState {
  readonly flow: SourcesFirstFlow;
  readonly draft: SourcesFirstDraft;
  /** 1-based index for the progress bar. */
  readonly currentStep: number;
  readonly totalSteps: number;
  readonly goBack: (() => void) | undefined;
  /** Moves to the next step, or opens the welcome handoff on the last one. */
  readonly goNext: () => void;
  readonly goTo: (step: SourcesFirstStep) => void;
}

/**
 * Shared step arithmetic: which steps this run has, where the current one sits,
 * and where Back and Continue lead.
 */
export function useSourcesFirstFlow(
  step: SourcesFirstStep,
  onFinish: () => void,
): SourcesFirstFlowState {
  const flow = useGet(sourcesFirstFlow$);
  const draft = useGet(sourcesFirstDraft$);
  const navigate = useSet(detachedNavigateTo$);
  const steps = sourcesFirstSteps(flow, draft.experienced);
  const previous = previousSourcesFirstStep(step, flow, draft.experienced);

  const goTo = (target: SourcesFirstStep): void => {
    navigate(STEP_ROUTES[target], { searchParams: new URLSearchParams() });
  };

  return {
    flow,
    draft,
    currentStep: sourcesFirstStepIndex(step, flow, draft.experienced) + 1,
    totalSteps: steps.length,
    goBack: previous
      ? () => {
          goTo(previous);
        }
      : undefined,
    goNext: () => {
      const next = nextSourcesFirstStep(step, flow, draft.experienced);
      if (next) {
        goTo(next);
        return;
      }
      onFinish();
    },
    goTo,
  };
}
