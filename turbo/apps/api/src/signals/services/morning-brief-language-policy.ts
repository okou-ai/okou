/**
 * Which language a composed Morning Brief is written in, and who decides.
 *
 * The precedence is fixed and is part of the single model request rather than a
 * second pass over it:
 *
 * 1. The pipeline's own constraints — one call, no tools, grounded sources,
 *    validated output, delivery rules — always prevail. Nothing below can relax
 *    them, and a non-language request inside Agent context does not change them.
 * 2. The admitted canonical Agent's complete instruction text may steer the
 *    **output language only**. It is interpreted inside that same summarization
 *    call. There is no language-detection model, no regular expression pulling
 *    directives out of free-form prose, and no prefix sniffing.
 * 3. With no applicable Agent language instruction, the persisted member locale
 *    decides; with no locale, the declared `en-US` default does.
 *
 * Source text is data. A message that says "reply in French" is evidence about
 * someone's day, never an instruction to this pipeline.
 *
 * The rules are described in
 * [the composition contract](../../../../../../docs/morning-brief-composition.md).
 */

import { SUPPORTED_USER_LOCALES } from "@okouai/api-contracts/contracts/user-preferences";

/** The language used when nothing else applies. */
export const MORNING_BRIEF_DEFAULT_LANGUAGE = "en-US";

/**
 * Output languages the brief can be written in.
 *
 * This is deliberately wider than the ten-value UI locale enumeration and is
 * kept separate from it. Chinese has no UI locale at all, yet an Agent whose
 * instructions are written in Simplified Chinese must be able to produce a
 * Simplified Chinese brief — and the Simplified/Traditional distinction has to
 * survive, because they are not interchangeable for a reader. Widening the
 * Settings locale enumeration would be a user-visible product change and is not
 * part of this contract.
 */
export const MORNING_BRIEF_OUTPUT_LANGUAGES = [
  ...SUPPORTED_USER_LOCALES,
  "zh-Hans",
  "zh-Hant",
] as const;

export type MorningBriefOutputLanguage =
  (typeof MORNING_BRIEF_OUTPUT_LANGUAGES)[number];

export function isMorningBriefOutputLanguage(
  value: string,
): value is MorningBriefOutputLanguage {
  return (MORNING_BRIEF_OUTPUT_LANGUAGES as readonly string[]).includes(value);
}

/** Where the request's language instruction came from. */
export type MorningBriefLanguageAuthority =
  /** The Agent's complete instruction text is in the request and may steer it. */
  | "agent-instructions"
  /** No applicable Agent instruction exists; the persisted member locale decides. */
  | "member-locale"
  /** Neither exists; the declared default decides. */
  | "default";

/**
 * The language plan frozen into one model invocation.
 *
 * `fallbackLanguage` is what the model is told to use when the instruction text
 * carries no applicable language directive — which is a decision the same call
 * makes, not one this module makes on its behalf.
 */
export interface MorningBriefLanguagePlan {
  readonly authority: MorningBriefLanguageAuthority;
  readonly fallbackLanguage: MorningBriefOutputLanguage;
  /** The frozen provenance of the instruction text, when there is any. */
  readonly instructionsVersionId: string | null;
  readonly instructionsDigest: string | null;
}

/**
 * Build the plan for one invocation.
 *
 * A complete, valid, nonempty instruction file always stays in the request even
 * when it looks like it says nothing about language: deciding that from here
 * would mean parsing free-form prose, which this contract forbids. The locale
 * or default travels with it as the fallback the same call may apply.
 *
 * An unusable read never arrives here. Missing data under a promised version is
 * a failure, and turning it into `default` would send English while claiming the
 * owner had configured nothing.
 */
export function planMorningBriefLanguage(args: {
  readonly instructions: {
    readonly versionId: string;
    readonly digest: string;
  } | null;
  readonly memberLocale: string | null;
}): MorningBriefLanguagePlan {
  const fallbackLanguage =
    args.memberLocale !== null &&
    isMorningBriefOutputLanguage(args.memberLocale)
      ? args.memberLocale
      : MORNING_BRIEF_DEFAULT_LANGUAGE;
  const localeAuthority: MorningBriefLanguageAuthority =
    args.memberLocale !== null &&
    isMorningBriefOutputLanguage(args.memberLocale)
      ? "member-locale"
      : "default";
  if (args.instructions === null) {
    return {
      authority: localeAuthority,
      fallbackLanguage,
      instructionsVersionId: null,
      instructionsDigest: null,
    };
  }
  return {
    authority: "agent-instructions",
    fallbackLanguage,
    instructionsVersionId: args.instructions.versionId,
    instructionsDigest: args.instructions.digest,
  };
}

/**
 * Accept the language tag the model reported for its own output.
 *
 * This is provenance, not verification. A returned `zh-Hans` records what the
 * invocation said it produced; it is not independent evidence that the prose is
 * Simplified Chinese, and a mocked response proves nothing at all about a real
 * model's compliance. An unrecognized tag is dropped rather than coerced,
 * because storing the fallback locale in its place would assert a language
 * nothing observed.
 */
export function validateReportedLanguage(
  reported: string | null | undefined,
): MorningBriefOutputLanguage | null {
  if (typeof reported !== "string") {
    return null;
  }
  const trimmed = reported.trim();
  return isMorningBriefOutputLanguage(trimmed) ? trimmed : null;
}
