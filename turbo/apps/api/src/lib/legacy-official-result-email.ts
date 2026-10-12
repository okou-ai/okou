import { z } from "zod";

// Temporary drain-only outbox shape of the retired platform completion email
// (#39524). Release-1 APIs (1.729.0 and earlier) enqueue it from the
// `workflow-automation:result-email` Run callback while they drain; release 2
// only finishes those captured entries. Release 3 of #39378 deletes this module
// with the legacy consumer once no producer-capable API serves or is a rollback
// target and no retryable legacy callback or outbox entry remains.
export const LEGACY_OFFICIAL_RESULT_EMAIL_SUBJECT_MAX_CHARACTERS = 180;
export const LEGACY_OFFICIAL_RESULT_EMAIL_TITLE_MAX_CHARACTERS = 160;
export const LEGACY_OFFICIAL_RESULT_EMAIL_TEXT_MAX_CHARACTERS = 8000;
export const LEGACY_OFFICIAL_RESULT_EMAIL_TEXT_TRUNCATION_MARKER =
  "\n\n[Result truncated]";

function boundedUnicodeString(maxCharacters: number) {
  return z
    .string()
    .min(1)
    .refine(
      (value) => {
        return Array.from(value).length <= maxCharacters;
      },
      { message: `Must contain at most ${maxCharacters} Unicode characters` },
    );
}

export const legacyOfficialResultEmailTemplateSchema = z
  .object({
    template: z.literal("official-automation-result"),
    props: z
      .object({
        title: boundedUnicodeString(
          LEGACY_OFFICIAL_RESULT_EMAIL_TITLE_MAX_CHARACTERS,
        ),
        resultText: boundedUnicodeString(
          LEGACY_OFFICIAL_RESULT_EMAIL_TEXT_MAX_CHARACTERS,
        ),
        runUrl: z.url().max(1024),
        manageUrl: z.url().max(1024),
      })
      .strict(),
  })
  .strict();
