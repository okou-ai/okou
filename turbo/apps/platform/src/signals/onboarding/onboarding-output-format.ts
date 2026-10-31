import { enum as zEnum, number, object } from "zod";

export const STARTING_PROMPT_MAX_LENGTH = 1000;

export const ONBOARDING_OUTPUT_FORMATS = [
  "image",
  "presentation",
  "website",
  "report",
  "research",
  "people",
] as const;

export type OnboardingOutputFormat = (typeof ONBOARDING_OUTPUT_FORMATS)[number];

/** Version-2 browser drafts store the format paragraph inside the prompt. */
export const persistedStartingPromptOutputSchema = object({
  format: zEnum(ONBOARDING_OUTPUT_FORMATS),
  start: number().int().min(0).max(STARTING_PROMPT_MAX_LENGTH),
  end: number().int().min(0).max(STARTING_PROMPT_MAX_LENGTH),
});

export interface StartingPromptOutput {
  readonly format: OnboardingOutputFormat;
  /** Applied only at submission; retains custom text from existing drafts. */
  readonly suffix: string;
}
