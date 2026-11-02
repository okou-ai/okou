import { command, computed, state } from "ccstate";
import { i18n } from "../../i18n/index.ts";
import { defaultOnboardingOutputFormat } from "./onboarding-default-output-format.ts";
import {
  ONBOARDING_OUTPUT_FORMATS,
  type OnboardingOutputFormat,
} from "./onboarding-output-format.ts";

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

export const selectOnboardingPromptOutput$ = command(
  ({ set }, output: OnboardingOutputFormat | null): void => {
    set(internalOnboardingDraft$, (current) => {
      return { ...current, output };
    });
  },
);

export const resetOnboardingDraft$ = command(({ set }) => {
  set(internalOnboardingDraft$, emptyOnboardingDraft());
});

/** Select a task-shaped default once, independently of the editable task. */
export const hydrateOnboardingRoute$ = command(
  ({ set }, searchParams: URLSearchParams) => {
    set(resetOnboardingDraft$);
    const prompt = searchParams.get("prompt");
    if (prompt === null) {
      return;
    }
    const copy = i18n.t(
      ($) => {
        return $.onboarding.sourcesFirst.outputFormats;
      },
      { returnObjects: true },
    );
    // Shared prompts can already include one of our output instructions.
    // Keep it in the format selection so submission includes it only once.
    const existingFormat = ONBOARDING_OUTPUT_FORMATS.find((format) => {
      return prompt.endsWith(`\n\n${copy.options[format].instruction}`);
    });
    if (existingFormat) {
      set(internalOnboardingDraft$, {
        prompt: prompt.slice(
          0,
          -copy.options[existingFormat].instruction.length - 2,
        ),
        output: existingFormat,
      });
      return;
    }
    set(internalOnboardingDraft$, {
      prompt,
      output: prompt.trim() ? defaultOnboardingOutputFormat(prompt) : null,
    });
  },
);
