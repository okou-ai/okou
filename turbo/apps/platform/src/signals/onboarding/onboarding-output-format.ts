import { enum as zEnum } from "zod";
import { i18n } from "../../i18n/index.ts";

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

export const onboardingOutputFormatSchema = zEnum(ONBOARDING_OUTPUT_FORMATS);

/** Compose the request at submission; the editable task never contains format copy. */
export function onboardingPromptWithFormat(
  prompt: string,
  format: OnboardingOutputFormat | null,
): string {
  if (format === null) {
    return prompt;
  }
  const instruction = i18n.t(($) => {
    return $.onboarding.sourcesFirst.outputFormats.options[format].instruction;
  });
  return `${prompt}\n\n${instruction}`;
}
