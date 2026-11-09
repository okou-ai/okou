import { enum as zEnum, number, object } from "zod";
import { i18n } from "../../i18n/index.ts";

export const STARTING_PROMPT_MAX_LENGTH = 1000;

export const ONBOARDING_OUTPUT_FORMATS = [
  "image",
  "presentation",
  "website",
  // Document keeps the persisted ID so version-2 drafts survive app rollbacks.
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

/** Count and submit the same suffix, including migrated report instructions. */
export function onboardingOutputSuffix(
  output: StartingPromptOutput | null,
): string {
  let suffix = output?.suffix ?? "";
  if (output?.format === "report") {
    const documentSuffix = `\n\n${i18n.t(($) => {
      return $.onboarding.sourcesFirst.outputFormats.options.report.instruction;
    })}`;
    // Older drafts can contain custom report instructions. Preserve those
    // while applying Document's artifact delivery contract at submission.
    if (suffix !== documentSuffix) {
      suffix += documentSuffix;
    }
  }
  return suffix;
}
