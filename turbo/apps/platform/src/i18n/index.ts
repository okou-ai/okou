import { createInstance, type Resource } from "i18next";
import { initReactI18next } from "react-i18next";
import { ASSISTANT_NAME, BRAND_NAME } from "../signals/branding.ts";
import {
  DEFAULT_LOCALE,
  DEFAULT_NAMESPACE,
  HALLOWEEN_NAMESPACE,
  loadHalloweenResources,
  loadLocaleResources,
  SUPPORTED_LOCALES,
  type LocaleResourceNamespace,
  type LocaleResources,
  type SupportedLocale,
} from "./resources.ts";

export const i18n = createInstance().use(initReactI18next);

// bootstrap$ awaits initializeI18n before rendering production callers.
export function currentLocale(): string {
  return i18n.resolvedLanguage ?? i18n.language;
}

interface InitialLocaleResources {
  readonly locale: SupportedLocale;
  readonly resources: Resource;
}

export async function loadInitialLocaleResources(
  locale: SupportedLocale,
  signal?: AbortSignal,
): Promise<InitialLocaleResources> {
  const fallbackResources = await loadLocaleResources(DEFAULT_LOCALE, signal);
  if (locale === DEFAULT_LOCALE) {
    return {
      locale,
      resources: { [DEFAULT_LOCALE]: fallbackResources },
    };
  }

  const localizedResources = await loadLocaleResources(locale, signal);
  return {
    locale,
    resources: {
      [DEFAULT_LOCALE]: fallbackResources,
      [locale]: localizedResources,
    },
  };
}

export async function initializeI18nWithResources(
  initial: InitialLocaleResources,
  signal?: AbortSignal,
): Promise<SupportedLocale> {
  signal?.throwIfAborted();
  await i18n.init({
    defaultNS: DEFAULT_NAMESPACE,
    enableSelector: true,
    fallbackLng: DEFAULT_LOCALE,
    interpolation: {
      defaultVariables: {
        assistantName: ASSISTANT_NAME,
        brandName: BRAND_NAME,
      },
      escapeValue: false,
    },
    lng: initial.locale,
    resources: initial.resources,
    returnNull: false,
    supportedLngs: SUPPORTED_LOCALES,
  });
  signal?.throwIfAborted();
  return initial.locale;
}

function addLocaleResources(
  locale: SupportedLocale,
  resources: LocaleResources,
): void {
  i18n.addResourceBundle(locale, "agents", resources.agents, true, true);
  i18n.addResourceBundle(locale, "common", resources.common, true, true);
}

function addHalloweenResources(
  locale: SupportedLocale,
  resources: LocaleResourceNamespace,
): void {
  i18n.addResourceBundle(locale, HALLOWEEN_NAMESPACE, resources, true, true);
}

export async function ensureHalloweenI18nResources(
  locale: SupportedLocale,
  signal?: AbortSignal,
): Promise<void> {
  const locales: readonly SupportedLocale[] =
    locale === DEFAULT_LOCALE ? [locale] : [DEFAULT_LOCALE, locale];
  const missing = locales.filter((candidate) => {
    return !i18n.hasResourceBundle(candidate, HALLOWEEN_NAMESPACE);
  });
  const resources = await Promise.all(
    missing.map(async (candidate) => {
      return {
        locale: candidate,
        resources: await loadHalloweenResources(candidate, signal),
      };
    }),
  );
  signal?.throwIfAborted();
  for (const loaded of resources) {
    addHalloweenResources(loaded.locale, loaded.resources);
  }
}

export function loadI18nLanguageResources(
  locale: SupportedLocale,
  signal?: AbortSignal,
): Promise<LocaleResources | undefined> {
  return !i18n.hasResourceBundle(locale, "agents") ||
    !i18n.hasResourceBundle(locale, "common")
    ? loadLocaleResources(locale, signal)
    : Promise.resolve(undefined);
}

export async function changeI18nLanguageWithResources(
  locale: SupportedLocale,
  resources: LocaleResources | undefined,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (resources) {
    addLocaleResources(locale, resources);
  }
  if (i18n.hasResourceBundle(DEFAULT_LOCALE, HALLOWEEN_NAMESPACE)) {
    await ensureHalloweenI18nResources(locale, signal);
  }
  await i18n.changeLanguage(locale);
  signal?.throwIfAborted();
}
