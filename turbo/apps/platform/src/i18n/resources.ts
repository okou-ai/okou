import { fetchResource } from "../lib/resource-fetch.ts";
import {
  DEFAULT_USER_LOCALE,
  SUPPORTED_USER_LOCALES,
} from "@okouai/api-contracts/validators/user-preferences";
import type { UserLocale } from "@okouai/api-contracts/contracts/user-preferences";
import deDEAgentsUrl from "./locales/de-DE/agents.json?url";
import deDECommonUrl from "./locales/de-DE/common.json?url";
import deDEHalloweenUrl from "./locales/de-DE/halloween.json?url";
import enUSAgents from "./locales/en-US/agents.json";
import enUSCommon from "./locales/en-US/common.json";
import enUSHalloweenUrl from "./locales/en-US/halloween.json?url";
import esESAgentsUrl from "./locales/es-ES/agents.json?url";
import esESCommonUrl from "./locales/es-ES/common.json?url";
import esESHalloweenUrl from "./locales/es-ES/halloween.json?url";
import frFRAgentsUrl from "./locales/fr-FR/agents.json?url";
import frFRCommonUrl from "./locales/fr-FR/common.json?url";
import frFRHalloweenUrl from "./locales/fr-FR/halloween.json?url";
import hiINAgentsUrl from "./locales/hi-IN/agents.json?url";
import hiINCommonUrl from "./locales/hi-IN/common.json?url";
import hiINHalloweenUrl from "./locales/hi-IN/halloween.json?url";
import idIDAgentsUrl from "./locales/id-ID/agents.json?url";
import idIDCommonUrl from "./locales/id-ID/common.json?url";
import idIDHalloweenUrl from "./locales/id-ID/halloween.json?url";
import itITAgentsUrl from "./locales/it-IT/agents.json?url";
import itITCommonUrl from "./locales/it-IT/common.json?url";
import itITHalloweenUrl from "./locales/it-IT/halloween.json?url";
import jaJPAgentsUrl from "./locales/ja-JP/agents.json?url";
import jaJPCommonUrl from "./locales/ja-JP/common.json?url";
import jaJPHalloweenUrl from "./locales/ja-JP/halloween.json?url";
import koKRAgentsUrl from "./locales/ko-KR/agents.json?url";
import koKRCommonUrl from "./locales/ko-KR/common.json?url";
import koKRHalloweenUrl from "./locales/ko-KR/halloween.json?url";
import ptBRAgentsUrl from "./locales/pt-BR/agents.json?url";
import ptBRCommonUrl from "./locales/pt-BR/common.json?url";
import ptBRHalloweenUrl from "./locales/pt-BR/halloween.json?url";
import zhHansAgentsUrl from "./locales/zh-Hans/agents.json?url";
import zhHansCommonUrl from "./locales/zh-Hans/common.json?url";
import zhHansHalloweenUrl from "./locales/zh-Hans/halloween.json?url";
import zhHantAgentsUrl from "./locales/zh-Hant/agents.json?url";
import zhHantCommonUrl from "./locales/zh-Hant/common.json?url";
import zhHantHalloweenUrl from "./locales/zh-Hant/halloween.json?url";

export const DEFAULT_LOCALE = DEFAULT_USER_LOCALE;
export const DEFAULT_NAMESPACE = "common";
export const HALLOWEEN_NAMESPACE = "halloween";
export const SUPPORTED_LOCALES = SUPPORTED_USER_LOCALES;

export type SupportedLocale = UserLocale;
type NonDefaultLocale = Exclude<SupportedLocale, typeof DEFAULT_LOCALE>;

export interface LocaleResourceNamespace {
  readonly [key: string]: string | LocaleResourceNamespace;
}

export interface LocaleResources {
  readonly [namespace: string]: LocaleResourceNamespace;
  readonly agents: LocaleResourceNamespace;
  readonly common: LocaleResourceNamespace;
}

interface LocaleResourceUrls {
  readonly agents: string;
  readonly common: string;
}

const HALLOWEEN_RESOURCE_URLS = {
  "de-DE": deDEHalloweenUrl,
  "en-US": enUSHalloweenUrl,
  "es-ES": esESHalloweenUrl,
  "fr-FR": frFRHalloweenUrl,
  "hi-IN": hiINHalloweenUrl,
  "id-ID": idIDHalloweenUrl,
  "it-IT": itITHalloweenUrl,
  "ja-JP": jaJPHalloweenUrl,
  "ko-KR": koKRHalloweenUrl,
  "pt-BR": ptBRHalloweenUrl,
  "zh-Hans": zhHansHalloweenUrl,
  "zh-Hant": zhHantHalloweenUrl,
} as const satisfies Record<SupportedLocale, string>;

export function isSupportedLocale(value: string): value is SupportedLocale {
  return SUPPORTED_LOCALES.some((locale) => {
    return locale === value;
  });
}

function localeResourceUrls(locale: NonDefaultLocale): LocaleResourceUrls {
  switch (locale) {
    case "pt-BR": {
      return { agents: ptBRAgentsUrl, common: ptBRCommonUrl };
    }
    case "ja-JP": {
      return { agents: jaJPAgentsUrl, common: jaJPCommonUrl };
    }
    case "ko-KR": {
      return { agents: koKRAgentsUrl, common: koKRCommonUrl };
    }
    case "id-ID": {
      return { agents: idIDAgentsUrl, common: idIDCommonUrl };
    }
    case "de-DE": {
      return { agents: deDEAgentsUrl, common: deDECommonUrl };
    }
    case "es-ES": {
      return { agents: esESAgentsUrl, common: esESCommonUrl };
    }
    case "it-IT": {
      return { agents: itITAgentsUrl, common: itITCommonUrl };
    }
    case "fr-FR": {
      return { agents: frFRAgentsUrl, common: frFRCommonUrl };
    }
    case "hi-IN": {
      return { agents: hiINAgentsUrl, common: hiINCommonUrl };
    }
    case "zh-Hans": {
      return { agents: zhHansAgentsUrl, common: zhHansCommonUrl };
    }
    case "zh-Hant": {
      return { agents: zhHantAgentsUrl, common: zhHantCommonUrl };
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

export function loadHalloweenResources(
  locale: SupportedLocale,
  signal?: AbortSignal,
): Promise<LocaleResourceNamespace> {
  return loadLocaleResourceNamespace(
    HALLOWEEN_RESOURCE_URLS[locale],
    locale,
    HALLOWEEN_NAMESPACE,
    signal,
  );
}

export async function loadLocaleResources(
  locale: SupportedLocale,
  signal?: AbortSignal,
): Promise<LocaleResources> {
  if (locale === DEFAULT_LOCALE) {
    return { agents: enUSAgents, common: enUSCommon };
  }

  const urls = localeResourceUrls(locale);
  const [agents, common] = await Promise.all([
    loadLocaleResourceNamespace(urls.agents, locale, "agents", signal),
    loadLocaleResourceNamespace(urls.common, locale, "common", signal),
  ]);
  signal?.throwIfAborted();
  return { agents, common };
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
