import { fetchResource } from "../lib/resource-fetch.ts";
import { enUS } from "@clerk/localizations/en-US";
import { command, computed, state } from "ccstate";
import deDEUrl from "./clerk-localizations/de-DE.json?url";
import esESUrl from "./clerk-localizations/es-ES.json?url";
import frFRUrl from "./clerk-localizations/fr-FR.json?url";
import hiINUrl from "./clerk-localizations/hi-IN.json?url";
import idIDUrl from "./clerk-localizations/id-ID.json?url";
import itITUrl from "./clerk-localizations/it-IT.json?url";
import jaJPUrl from "./clerk-localizations/ja-JP.json?url";
import koKRUrl from "./clerk-localizations/ko-KR.json?url";
import ptBRUrl from "./clerk-localizations/pt-BR.json?url";
import zhHansUrl from "./clerk-localizations/zh-Hans.json?url";
import zhHantUrl from "./clerk-localizations/zh-Hant.json?url";
import { DEFAULT_LOCALE, type SupportedLocale } from "./resources.ts";

type ClerkLocalization = typeof enUS;
type ClerkLocalizationCache = ReadonlyMap<SupportedLocale, ClerkLocalization>;
type NonDefaultLocale = Exclude<SupportedLocale, typeof DEFAULT_LOCALE>;

const internalClerkLocalizations$ = state<ClerkLocalizationCache>(
  new Map([[DEFAULT_LOCALE, enUS]]),
);

export const clerkLocalizations$ = computed((get) => {
  return get(internalClerkLocalizations$);
});

function clerkLocalizationUrl(locale: NonDefaultLocale): string {
  switch (locale) {
    case "pt-BR": {
      return ptBRUrl;
    }
    case "ja-JP": {
      return jaJPUrl;
    }
    case "ko-KR": {
      return koKRUrl;
    }
    case "id-ID": {
      return idIDUrl;
    }
    case "de-DE": {
      return deDEUrl;
    }
    case "es-ES": {
      return esESUrl;
    }
    case "it-IT": {
      return itITUrl;
    }
    case "fr-FR": {
      return frFRUrl;
    }
    case "hi-IN": {
      return hiINUrl;
    }
    case "zh-Hans": {
      return zhHansUrl;
    }
    case "zh-Hant": {
      return zhHantUrl;
    }
  }
}

function isClerkLocalizationValue(value: unknown): boolean {
  if (typeof value === "string") {
    return true;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(isClerkLocalizationValue);
}

function isClerkLocalization(
  value: unknown,
  locale: NonDefaultLocale,
): value is ClerkLocalization {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "locale" in value &&
    value.locale === locale &&
    Object.values(value).every(isClerkLocalizationValue)
  );
}

async function fetchClerkLocalization(
  locale: NonDefaultLocale,
  signal?: AbortSignal,
): Promise<ClerkLocalization> {
  const response = await fetchResource(
    new URL(clerkLocalizationUrl(locale), location.href),
    {},
    signal,
  );
  if (!response.ok) {
    throw new Error(
      `Failed to load ${locale} Clerk localization (HTTP ${response.status})`,
    );
  }
  const localization: unknown = JSON.parse(await response.text());
  signal?.throwIfAborted();
  if (!isClerkLocalization(localization, locale)) {
    throw new Error(`Invalid ${locale} Clerk localization`);
  }
  return localization;
}

export const loadClerkLocalization$ = command(
  async (
    { get },
    locale: SupportedLocale,
    signal: AbortSignal,
  ): Promise<ClerkLocalization> => {
    signal.throwIfAborted();
    if (locale === DEFAULT_LOCALE) {
      return enUS;
    }
    const loaded = get(internalClerkLocalizations$).get(locale);
    if (loaded) {
      return loaded;
    }

    return await fetchClerkLocalization(locale, signal);
  },
);

export const cacheClerkLocalization$ = command(
  ({ get, set }, locale: SupportedLocale, localization: ClerkLocalization) => {
    if (get(internalClerkLocalizations$).has(locale)) {
      return;
    }
    const next = new Map(get(internalClerkLocalizations$));
    next.set(locale, localization);
    set(internalClerkLocalizations$, next);
  },
);

export function clerkLocalizationForLocale(
  localizations: ClerkLocalizationCache,
  locale: SupportedLocale,
): ClerkLocalization {
  const localization = localizations.get(locale);
  if (!localization) {
    throw new Error(`Clerk localization for ${locale} has not been loaded`);
  }
  return {
    ...localization,
    // Clerk uses this string as the email input's native title. An empty
    // public localization override suppresses hover hints in every locale.
    formFieldInput__emailAddress_format: "",
  };
}
