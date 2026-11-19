import {
  ONBOARDING_STARTING_PROMPT_MAX_LENGTH,
  onboardingStartingPromptFormatSchema,
} from "@okouai/api-contracts/validators/onboarding";
import { i18n } from "../../i18n/index.ts";

export const STARTING_PROMPT_MAX_LENGTH = ONBOARDING_STARTING_PROMPT_MAX_LENGTH;

export const ONBOARDING_OUTPUT_FORMATS =
  onboardingStartingPromptFormatSchema.options;

export type OnboardingOutputFormat = (typeof ONBOARDING_OUTPUT_FORMATS)[number];

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
