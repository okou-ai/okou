import { command, computed, state } from "ccstate";
import {
  cacheClerkLocalization$,
  loadClerkLocalization$,
} from "../i18n/clerk-localization.ts";
import {
  changeI18nLanguageWithResources,
  initializeI18nWithResources,
  loadI18nLanguageResources,
  loadInitialLocaleResources,
} from "../i18n/index.ts";
import { resolveInitialLocaleFallbackFromBrowser } from "../i18n/locale-fallback.ts";
import { DEFAULT_LOCALE, type SupportedLocale } from "../i18n/resources.ts";
import { clerk$ } from "./auth.ts";
import {
  updateUserPreference$,
  userPreferences$,
} from "./okou-page/settings/user-preferences.ts";

const internalLocale$ = state<SupportedLocale>(DEFAULT_LOCALE);

export const locale$ = computed((get) => {
  return get(internalLocale$);
});

export const availableLocalePreferences$ = computed(async (get) => {
  const preferences = await get(userPreferences$);
  return preferences.supportedLocales;
});

export const initLocale$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const requestedLocale = resolveInitialLocaleFallbackFromBrowser();
    const [initial, clerkLocalization] = await Promise.all([
      loadInitialLocaleResources(requestedLocale, signal),
      set(loadClerkLocalization$, requestedLocale, signal),
    ]);
    signal.throwIfAborted();
    const locale = await initializeI18nWithResources(initial, signal);
    signal.throwIfAborted();
    set(cacheClerkLocalization$, initial.locale, clerkLocalization);
    set(internalLocale$, locale);
    document.documentElement.lang = locale;
  },
);

const setLocale$ = command(
  async ({ set }, locale: SupportedLocale, signal: AbortSignal) => {
    const [resources, clerkLocalization] = await Promise.all([
      loadI18nLanguageResources(locale, signal),
      set(loadClerkLocalization$, locale, signal),
    ]);
    signal.throwIfAborted();
    await changeI18nLanguageWithResources(locale, resources, signal);
    signal.throwIfAborted();
    set(cacheClerkLocalization$, locale, clerkLocalization);
    set(internalLocale$, locale);
    document.documentElement.lang = locale;
  },
);

const applyLocalePreference$ = command(
  async ({ get, set }, locale: SupportedLocale, signal: AbortSignal) => {
    if (get(internalLocale$) !== locale) {
      await set(setLocale$, locale, signal);
    }
  },
);

export const syncLocalePreference$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.user || !clerk.organization) {
      return;
    }

    const preferences = await get(userPreferences$);
    signal.throwIfAborted();
    const supportedLocales = preferences.supportedLocales;
    const locale = supportedLocales.includes(preferences.locale)
      ? preferences.locale
      : DEFAULT_LOCALE;
    await set(applyLocalePreference$, locale, signal);
  },
);

export const updateLocalePreference$ = command(
  async ({ get, set }, locale: SupportedLocale, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.user || !clerk.organization) {
      throw new Error("Language preferences require an active workspace");
    }

    const availableLocales = await get(availableLocalePreferences$);
    signal.throwIfAborted();
    if (!availableLocales.includes(locale)) {
      throw new Error(`Unsupported locale: ${locale}`);
    }

    await set(applyLocalePreference$, locale, signal);
    await set(updateUserPreference$, { locale }, signal);
  },
);
