import { command, computed, state } from "ccstate";
import { i18n } from "../../i18n/index.ts";
import { onRef } from "../utils.ts";
import { defaultOnboardingOutputFormat } from "./onboarding-default-output-format.ts";
import {
  ONBOARDING_OUTPUT_FORMATS,
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

/** Select a task-shaped default once, before the visitor starts editing. */
export const hydrateOnboardingRoute$ = command(
  ({ set }, searchParams: URLSearchParams) => {
    set(resetOnboardingDraft$);
    const prompt = searchParams.get("prompt");
    if (prompt !== null) {
      set(editOnboardingPrompt$, prompt);
      if (prompt.trim()) {
        const copy = i18n.t(
          ($) => {
            return $.onboarding.sourcesFirst.outputFormats;
          },
          { returnObjects: true },
        );
        // A shared prompt may already contain one of our format paragraphs.
        const existingOutput = ONBOARDING_OUTPUT_FORMATS.flatMap((format) => {
          const instruction = copy.options[format].instruction;
          return [instruction, `${instruction} ${copy.selectionPriority}`].map(
            (text) => {
              return { format, instruction: text };
            },
          );
        }).find(({ instruction }) => {
          return prompt.endsWith(`\n\n${instruction}`);
        });
        if (existingOutput) {
          set(internalOnboardingDraft$, {
            prompt,
            output: {
              format: existingOutput.format,
              start: prompt.length - existingOutput.instruction.length - 2,
              end: prompt.length,
            },
          });
          return;
        }
        const format = defaultOnboardingOutputFormat(prompt);
        if (format) {
          set(
            selectOnboardingPromptOutput$,
            format,
            copy.options[format].instruction,
          );
        }
      }
    }
  },
);
