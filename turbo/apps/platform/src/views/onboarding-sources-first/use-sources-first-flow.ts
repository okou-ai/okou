import { useGet, useSet } from "ccstate-react";
import {
  captureSourceOnboardingBack$,
  captureSourceOnboardingSkipped$,
} from "../../signals/bootstrap/source-onboarding-telemetry.ts";
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
import { detachedNavigateTo$, searchParams$ } from "../../signals/route.ts";

const STEP_ROUTES: Readonly<Record<SourcesFirstStep, RoutePath>> = {
  industry: ROUTES.onboarding,
  sources: ROUTES.onboardingSources,
  team: ROUTES.onboardingTeam,
  experience: ROUTES.onboardingExperience,
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
  /** The same move, from a step's own Skip or Not now. */
  readonly goSkip: () => void;
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
  const searchParams = useGet(searchParams$);
  const captureBack = useSet(captureSourceOnboardingBack$);
  const captureSkipped = useSet(captureSourceOnboardingSkipped$);
  const previous = previousSourcesFirstStep(step, flow, draft.experienced);
  const progress = sourcesFirstProgress(step, flow, draft.experienced);

  const goTo = (target: SourcesFirstStep): void => {
    // Every step keeps the query it arrived with, so the Marketing `prompt`
    // handoff and a `redeemCode` still reach the last step's completion and
    // first request.
    navigate(STEP_ROUTES[target], {
      searchParams: new URLSearchParams(searchParams),
    });
  };

  const goNext = (): void => {
    const next = nextSourcesFirstStep(step, flow, draft.experienced);
    if (next) {
      goTo(next);
    }
  };

  return {
    flow,
    draft,
    currentStep: progress.current,
    totalSteps: progress.total,
    goBack: previous
      ? () => {
          captureBack(step);
          goTo(previous);
        }
      : undefined,
    goNext,
    goSkip: () => {
      captureSkipped(step);
      goNext();
    },
    goTo,
  };
}
