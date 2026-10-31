import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";
import {
  editedStartingPromptOutput,
  withStartingPromptOutput,
  type OnboardingOutputFormat,
  type StartingPromptOutput,
} from "./onboarding-output-format.ts";

export interface OnboardingDraft {
  readonly prompt: string;
  readonly output: StartingPromptOutput | null;
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
    return {
      prompt,
      output: editedStartingPromptOutput(
        current.prompt,
        prompt,
        current.output,
      ),
    };
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
  (
    { get, set },
    format: OnboardingOutputFormat | null,
    instruction: string,
  ): void => {
    const { prompt, output } = get(internalOnboardingDraft$);
    if (output?.format === format) {
      return;
    }
    const next = withStartingPromptOutput(prompt, output, instruction);
    set(internalOnboardingDraft$, {
      prompt: next.text,
      output: format ? { format, start: next.start, end: next.end } : null,
    });
    get(onboardingPromptInput$)?.focus();
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
      set(editOnboardingPrompt$, prompt);
    }
  },
);
