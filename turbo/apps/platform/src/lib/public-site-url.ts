import { userLocaleSchema } from "@okouai/api-contracts/validators/user-preferences";
import type { UserLocale } from "@okouai/api-contracts/contracts/user-preferences";

const PUBLIC_SITE_LOCALES: Readonly<Record<UserLocale, string>> = {
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

/** A page on the public site, in the language the app is showing. */
export function publicSiteUrl(language: string, page: string): string {
  const locale = PUBLIC_SITE_LOCALES[userLocaleSchema.parse(language)];
  return `https://www.okou.ai/${locale}/${page}`;
}
