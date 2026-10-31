import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";
import { defaultOnboardingOutputFormat } from "./onboarding-default-output-format.ts";
import type { OnboardingOutputFormat } from "./onboarding-output-format.ts";

export interface OnboardingDraft {
  readonly prompt: string;
  readonly output: OnboardingOutputFormat | null;
}

function emptyOnboardingDraft(): OnboardingDraft {
  return { prompt: "", output: null };
}

const internalOnboardingDraft$ = state<OnboardingDraft>(emptyOnboardingDraft());

export const onboardingDraft$ = computed((get) => {
  return get(internalOnboardingDraft$);
});

export const editOnboardingPrompt$ = command(({ set }, prompt: string) => {
  set(internalOnboardingDraft$, (current) => {
    return { ...current, prompt };
  });
});

const onboardingPromptInput$ = state<HTMLTextAreaElement | null>(null);

export const setOnboardingPromptInput$ = onRef(
  command(({ set }, element: HTMLTextAreaElement, signal: AbortSignal) => {
    set(onboardingPromptInput$, element);
    signal.addEventListener("abort", () => {
      set(onboardingPromptInput$, null);
    });
  }),
);

export const selectOnboardingPromptOutput$ = command(
  ({ get, set }, format: OnboardingOutputFormat | null): void => {
    set(internalOnboardingDraft$, (current) => {
      return { ...current, output: format };
    });
    // Clear selection unmounts its button; return focus to the task.
    if (format === null) {
      get(onboardingPromptInput$)?.focus();
    }
  },
);

/** Select a task-shaped default once, before the visitor starts editing. */
export const hydrateOnboardingRoute$ = command(
  ({ set }, searchParams: URLSearchParams) => {
    const prompt = searchParams.get("prompt") ?? "";
    set(internalOnboardingDraft$, {
      prompt,
      output: prompt.trim() ? defaultOnboardingOutputFormat(prompt) : null,
    });
  },
);
