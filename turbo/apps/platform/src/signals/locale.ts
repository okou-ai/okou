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
import { logger } from "./log.ts";
import {
  updateUserPreference$,
  userPreferences$,
} from "./okou-page/settings/user-preferences.ts";
import { resetSignal, settle } from "./utils.ts";

const internalLocale$ = state<SupportedLocale>(DEFAULT_LOCALE);
const L = logger("Locale");

export const locale$ = computed((get) => {
  return get(internalLocale$);
});

export const availableLocalePreferences$ = computed(async (get) => {
  const preferences = await get(userPreferences$);
  return preferences.supportedLocales;
});

const loadInitialLocale$ = command(
  async ({ set }, locale: SupportedLocale, signal: AbortSignal) => {
    return await Promise.all([
      loadInitialLocaleResources(locale, signal),
      set(loadClerkLocalization$, locale, signal),
    ]);
  },
);

export const initLocale$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const requestedLocale = resolveInitialLocaleFallbackFromBrowser();
    const initialResult = await settle(
      set(loadInitialLocale$, requestedLocale, signal),
      signal,
    );
    if (!initialResult.ok) {
      L.error(
        `Failed to initialize ${requestedLocale}; falling back to ${DEFAULT_LOCALE}`,
        initialResult.error,
      );
    }
    const [initial, clerkLocalization] = initialResult.ok
      ? initialResult.value
      : await set(loadInitialLocale$, DEFAULT_LOCALE, signal);
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
    const preferredLocale =
      preferences.locale ?? resolveInitialLocaleFallbackFromBrowser();
    let locale = supportedLocales.includes(preferredLocale)
      ? preferredLocale
      : DEFAULT_LOCALE;

    if (preferences.locale === null && locale !== DEFAULT_LOCALE) {
      const fallbackResult = await settle(
        set(applyLocalePreference$, locale, signal),
        signal,
      );
      if (!fallbackResult.ok) {
        L.error(
          `Failed to apply locale fallback ${locale}; falling back to ${DEFAULT_LOCALE}`,
          fallbackResult.error,
        );
        locale = DEFAULT_LOCALE;
        await set(applyLocalePreference$, locale, signal);
      }
    } else {
      await set(applyLocalePreference$, locale, signal);
    }

    if (preferences.locale === null) {
      await set(updateUserPreference$, { locale }, signal);
    }
  },
);

const pendingLocalePreference$ = state<{
  readonly locale: SupportedLocale;
  readonly owner: string;
} | null>(null);
const resetLocalePreference$ = resetSignal();

const persistLocalePreference$ = command(
  async (
    { get, set },
    locale: SupportedLocale,
    assertCurrent: () => void,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    assertCurrent();
    const preferences = await get(userPreferences$);
    signal.throwIfAborted();
    assertCurrent();
    if (!preferences.supportedLocales.includes(locale)) {
      throw new Error(`Unsupported locale: ${locale}`);
    }

    await set(applyLocalePreference$, locale, signal);
    signal.throwIfAborted();
    assertCurrent();
    // The applied UI locale can precede a failed save. Only confirmed
    // preferences can make persistence redundant, including on a retry.
    if (preferences.locale !== locale) {
      await set(updateUserPreference$, { locale }, signal);
      signal.throwIfAborted();
      assertCurrent();
    }
  },
);

export const updateLocalePreference$ = command(
  async ({ get, set }, locale: SupportedLocale, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.user || !clerk.organization) {
      throw new Error("Language preferences require an active workspace");
    }

    const owner = JSON.stringify([
      clerk.user.id,
      clerk.organization.id,
      clerk.session?.id,
    ]);
    const pending = get(pendingLocalePreference$);
    if (pending?.owner === owner && pending.locale === locale) {
      return;
    }

    const operationSignal = set(resetLocalePreference$, signal);
    operationSignal.throwIfAborted();
    const attempt = { locale, owner };
    const assertCurrent = () => {
      operationSignal.throwIfAborted();
      if (
        JSON.stringify([
          clerk.user?.id,
          clerk.organization?.id,
          clerk.session?.id,
        ]) !== owner
      ) {
        throw new DOMException(
          "Language preference owner changed",
          "AbortError",
        );
      }
    };
    set(pendingLocalePreference$, attempt);
    const clearPending = () => {
      if (get(pendingLocalePreference$) === attempt) {
        set(pendingLocalePreference$, null);
      }
    };
    operationSignal.addEventListener("abort", clearPending, { once: true });
    // Auth can change while resources or a request token are loading. Abort
    // before either can apply this owner's choice to a different workspace.
    const unsubscribe = clerk.addListener(() => {
      if (
        JSON.stringify([
          clerk.user?.id,
          clerk.organization?.id,
          clerk.session?.id,
        ]) !== owner &&
        get(pendingLocalePreference$) === attempt
      ) {
        set(resetLocalePreference$);
      }
    });
    if (operationSignal.aborted) {
      unsubscribe();
    } else {
      operationSignal.addEventListener("abort", unsubscribe, { once: true });
    }
    return set(
      persistLocalePreference$,
      locale,
      assertCurrent,
      operationSignal,
    ).finally(() => {
      unsubscribe();
      operationSignal.removeEventListener("abort", unsubscribe);
      operationSignal.removeEventListener("abort", clearPending);
      clearPending();
    });
  },
);
