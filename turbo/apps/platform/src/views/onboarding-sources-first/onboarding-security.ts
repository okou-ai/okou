import {
  userLocaleSchema,
  type UserLocale,
} from "@okouai/api-contracts/contracts/user-preferences";

const SECURITY_PAGE_LOCALES: Readonly<Record<UserLocale, string>> = {
  "de-DE": "de",
  "en-US": "en",
  "es-ES": "es",
  "fr-FR": "fr",
  "hi-IN": "hi",
  "id-ID": "id",
  "it-IT": "it",
  "ja-JP": "ja",
  "ko-KR": "ko",
  "pt-BR": "pt-BR",
  "zh-Hans": "zh-Hans",
  "zh-Hant": "zh-Hant",
};

/** The public security page, in the language the app is showing. */
export function securityPageUrl(language: string): string {
  const locale = SECURITY_PAGE_LOCALES[userLocaleSchema.parse(language)];
  return `https://www.okou.ai/${locale}/security`;
}
