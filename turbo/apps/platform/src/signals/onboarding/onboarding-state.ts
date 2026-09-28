import { command, computed, state } from "ccstate";

export interface OnboardingDraft {
  readonly prompt: string;
}

function emptyOnboardingDraft(): OnboardingDraft {
  return { prompt: "" };
}

const internalOnboardingDraft$ = state<OnboardingDraft>(emptyOnboardingDraft());

export const onboardingDraft$ = computed((get) => {
  return get(internalOnboardingDraft$);
});

export const updateOnboardingDraft$ = command(
  ({ set }, patch: Partial<OnboardingDraft>) => {
    set(internalOnboardingDraft$, (current) => {
      return { ...current, ...patch };
    });
  },
);

export const resetOnboardingDraft$ = command(({ set }) => {
  set(internalOnboardingDraft$, emptyOnboardingDraft());
});

/** The prompt handoff starts from the prompt its link brought. */
export const hydrateOnboardingRoute$ = command(
  ({ set }, searchParams: URLSearchParams) => {
    set(resetOnboardingDraft$);
    const prompt = searchParams.get("prompt");
    if (prompt !== null) {
      set(updateOnboardingDraft$, { prompt });
    }
  },
);
