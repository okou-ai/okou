import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "./resources.ts";

export const OKOU_LOCALE_COOKIE_NAME = "__Secure-okou-locale";

const OKOU_LOCALE_COOKIE_VERSION = "v1";

function decodeOkouLocale(value: string | null): SupportedLocale | null {
  if (!value?.startsWith(`${OKOU_LOCALE_COOKIE_VERSION}.`)) {
    return null;
  }

  const locale = value.slice(OKOU_LOCALE_COOKIE_VERSION.length + 1);
  return isSupportedLocale(locale) ? locale : null;
}

function readOkouLocaleCookie(cookieHeader: string): SupportedLocale | null {
  const prefix = `${OKOU_LOCALE_COOKIE_NAME}=`;
  for (const part of cookieHeader.split(";")) {
    const cookie = part.trim();
    if (cookie.startsWith(prefix)) {
      const locale = decodeOkouLocale(cookie.slice(prefix.length));
      if (locale) {
        return locale;
      }
    }
  }
  return null;
}

// Chinese is the one supported language carried by two locales, and they are
// separated by script rather than by region. Matching on the primary subtag
// alone would hand every zh-TW and zh-HK reader the Simplified bundle, so the
// script is read first and the region only decides when no script is declared.
function isTraditionalChineseRegion(subtag: string): boolean {
  return subtag === "tw" || subtag === "hk" || subtag === "mo";
}

function chineseLocaleForSubtags(subtags: readonly string[]): SupportedLocale {
  if (subtags.includes("hant")) {
    return "zh-Hant";
  }
  if (subtags.includes("hans")) {
    return "zh-Hans";
  }
  return subtags.some(isTraditionalChineseRegion) ? "zh-Hant" : "zh-Hans";
}

function localeForBrowserLanguage(language: string): SupportedLocale | null {
  const subtags = language.trim().toLowerCase().split("-");
  const primaryLanguage = subtags[0];
  if (primaryLanguage === "no") {
    return "nb-NO";
  }
  if (primaryLanguage === "iw") {
    return "he-IL";
  }
  if (primaryLanguage === "zh") {
    return chineseLocaleForSubtags(subtags.slice(1));
  }
  return (
    SUPPORTED_LOCALES.find((locale) => {
      return locale.toLowerCase().split("-")[0] === primaryLanguage;
    }) ?? null
  );
}

function resolveBrowserLocale(languages: readonly string[]): SupportedLocale {
  for (const language of languages) {
    const locale = localeForBrowserLanguage(language);
    if (locale) {
      return locale;
    }
  }
  return DEFAULT_LOCALE;
}

function resolveInitialLocaleFallback({
  cookieHeader,
  browserLanguages,
}: {
  readonly cookieHeader: string;
  readonly browserLanguages: readonly string[];
}): SupportedLocale {
  // Site and browser values are initial hints. Authenticated
  // workspace preference sync remains authoritative after bootstrap.
  return (
    readOkouLocaleCookie(cookieHeader) ?? resolveBrowserLocale(browserLanguages)
  );
}

export function resolveInitialLocaleFallbackFromBrowser(): SupportedLocale {
  const browserLanguages =
    navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  return resolveInitialLocaleFallback({
    cookieHeader: document.cookie,
    browserLanguages,
  });
}
