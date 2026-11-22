import { fetchResource } from "../lib/resource-fetch.ts";
import {
  DEFAULT_USER_LOCALE,
  SUPPORTED_USER_LOCALES,
} from "@okouai/api-contracts/validators/user-preferences";
import type { UserLocale } from "@okouai/api-contracts/contracts/user-preferences";
import deDECommonUrl from "./locales/de-DE/common.json?url";
import enUSCommon from "./locales/en-US/common.json";
import esESCommonUrl from "./locales/es-ES/common.json?url";
import frFRCommonUrl from "./locales/fr-FR/common.json?url";
import hiINCommonUrl from "./locales/hi-IN/common.json?url";
import idIDCommonUrl from "./locales/id-ID/common.json?url";
import itITCommonUrl from "./locales/it-IT/common.json?url";
import jaJPCommonUrl from "./locales/ja-JP/common.json?url";
import koKRCommonUrl from "./locales/ko-KR/common.json?url";
import ptBRCommonUrl from "./locales/pt-BR/common.json?url";
import zhHansCommonUrl from "./locales/zh-Hans/common.json?url";
import zhHantCommonUrl from "./locales/zh-Hant/common.json?url";

export const DEFAULT_LOCALE = DEFAULT_USER_LOCALE;
export const DEFAULT_NAMESPACE = "common";
export const SUPPORTED_LOCALES = SUPPORTED_USER_LOCALES;

export type SupportedLocale = UserLocale;
type NonDefaultLocale = Exclude<SupportedLocale, typeof DEFAULT_LOCALE>;

export interface LocaleResourceNamespace {
  readonly [key: string]: string | LocaleResourceNamespace;
}

export interface LocaleResources {
  readonly [namespace: string]: LocaleResourceNamespace;
  readonly common: LocaleResourceNamespace;
}

export function isSupportedLocale(value: string): value is SupportedLocale {
  return SUPPORTED_LOCALES.some((locale) => {
    return locale === value;
  });
}

function localeResourceUrl(locale: NonDefaultLocale): string {
  switch (locale) {
    case "pt-BR": {
      return ptBRCommonUrl;
    }
    case "ja-JP": {
      return jaJPCommonUrl;
    }
    case "ko-KR": {
      return koKRCommonUrl;
    }
    case "id-ID": {
      return idIDCommonUrl;
    }
    case "de-DE": {
      return deDECommonUrl;
    }
    case "es-ES": {
      return esESCommonUrl;
    }
    case "it-IT": {
      return itITCommonUrl;
    }
    case "fr-FR": {
      return frFRCommonUrl;
    }
    case "hi-IN": {
      return hiINCommonUrl;
    }
    case "zh-Hans": {
      return zhHansCommonUrl;
    }
    case "zh-Hant": {
      return zhHantCommonUrl;
    }
  }
}

function isLocaleResourceNamespace(
  value: unknown,
): value is LocaleResourceNamespace {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => {
    return typeof entry === "string" || isLocaleResourceNamespace(entry);
  });
}

async function loadLocaleResourceNamespace(
  resourceUrl: string,
  locale: SupportedLocale,
  namespace: string,
  signal?: AbortSignal,
): Promise<LocaleResourceNamespace> {
  const response = await fetchResource(
    new URL(resourceUrl, location.href),
    {},
    signal,
  );
  if (!response.ok) {
    throw new Error(
      `Failed to load ${locale} ${namespace} locale resources (HTTP ${response.status})`,
    );
  }
  const resource: unknown = JSON.parse(await response.text());
  if (!isLocaleResourceNamespace(resource)) {
    throw new Error(`Invalid ${locale} ${namespace} locale resources`);
  }
  return resource;
}

export async function loadLocaleResources(
  locale: SupportedLocale,
  signal?: AbortSignal,
): Promise<LocaleResources> {
  if (locale === DEFAULT_LOCALE) {
    return { common: enUSCommon };
  }

  const common = await loadLocaleResourceNamespace(
    localeResourceUrl(locale),
    locale,
    "common",
    signal,
  );
  signal?.throwIfAborted();
  return { common };
}

// Clipboard payloads can outlive the locale that created them. Keep this
// cross-locale marker set resident without retaining every full locale bundle.
export const CHAT_ATTACHMENT_HEADINGS = {
  "en-US": "Attachments",
  "pt-BR": "Anexos",
  "ja-JP": "添付ファイル",
  "ko-KR": "첨부파일",
  "id-ID": "Lampiran",
  "de-DE": "Anhänge",
  "es-ES": "Archivos adjuntos",
  "it-IT": "Allegati",
  "fr-FR": "Pièces jointes",
  "hi-IN": "संलग्नक",
  "zh-Hans": "附件",
  "zh-Hant": "附件",
} as const satisfies Record<SupportedLocale, string>;
