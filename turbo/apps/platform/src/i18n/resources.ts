import { fetchResource } from "../lib/resource-fetch.ts";
import {
  SUPPORTED_USER_LOCALES,
  type UserLocale,
} from "@okouai/api-contracts/contracts/user-preferences";
import deDEAgentsUrl from "./locales/de-DE/agents.json?url";
import deDECommonUrl from "./locales/de-DE/common.json?url";
import enUSAgents from "./locales/en-US/agents.json";
import enUSCommon from "./locales/en-US/common.json";
import esESAgentsUrl from "./locales/es-ES/agents.json?url";
import esESCommonUrl from "./locales/es-ES/common.json?url";
import frFRAgentsUrl from "./locales/fr-FR/agents.json?url";
import frFRCommonUrl from "./locales/fr-FR/common.json?url";
import hiINAgentsUrl from "./locales/hi-IN/agents.json?url";
import hiINCommonUrl from "./locales/hi-IN/common.json?url";
import idIDAgentsUrl from "./locales/id-ID/agents.json?url";
import idIDCommonUrl from "./locales/id-ID/common.json?url";
import itITAgentsUrl from "./locales/it-IT/agents.json?url";
import itITCommonUrl from "./locales/it-IT/common.json?url";
import jaJPAgentsUrl from "./locales/ja-JP/agents.json?url";
import jaJPCommonUrl from "./locales/ja-JP/common.json?url";
import koKRAgentsUrl from "./locales/ko-KR/agents.json?url";
import koKRCommonUrl from "./locales/ko-KR/common.json?url";
import ptBRAgentsUrl from "./locales/pt-BR/agents.json?url";
import ptBRCommonUrl from "./locales/pt-BR/common.json?url";
import zhHansAgentsUrl from "./locales/zh-Hans/agents.json?url";
import zhHansCommonUrl from "./locales/zh-Hans/common.json?url";
import zhHantAgentsUrl from "./locales/zh-Hant/agents.json?url";
import zhHantCommonUrl from "./locales/zh-Hant/common.json?url";
import trTRAgentsUrl from "./locales/tr-TR/agents.json?url";
import trTRCommonUrl from "./locales/tr-TR/common.json?url";
import viVNAgentsUrl from "./locales/vi-VN/agents.json?url";
import viVNCommonUrl from "./locales/vi-VN/common.json?url";
import thTHAgentsUrl from "./locales/th-TH/agents.json?url";
import thTHCommonUrl from "./locales/th-TH/common.json?url";
import nlNLAgentsUrl from "./locales/nl-NL/agents.json?url";
import nlNLCommonUrl from "./locales/nl-NL/common.json?url";
import svSEAgentsUrl from "./locales/sv-SE/agents.json?url";
import svSECommonUrl from "./locales/sv-SE/common.json?url";
import daDKAgentsUrl from "./locales/da-DK/agents.json?url";
import daDKCommonUrl from "./locales/da-DK/common.json?url";
import nbNOAgentsUrl from "./locales/nb-NO/agents.json?url";
import nbNOCommonUrl from "./locales/nb-NO/common.json?url";
import fiFIAgentsUrl from "./locales/fi-FI/agents.json?url";
import fiFICommonUrl from "./locales/fi-FI/common.json?url";
import heILAgentsUrl from "./locales/he-IL/agents.json?url";
import heILCommonUrl from "./locales/he-IL/common.json?url";
import plPLAgentsUrl from "./locales/pl-PL/agents.json?url";
import plPLCommonUrl from "./locales/pl-PL/common.json?url";
import csCZAgentsUrl from "./locales/cs-CZ/agents.json?url";
import csCZCommonUrl from "./locales/cs-CZ/common.json?url";

export const DEFAULT_LOCALE = "en-US";
export const DEFAULT_NAMESPACE = "common";
export const SUPPORTED_LOCALES = SUPPORTED_USER_LOCALES;

export type SupportedLocale = UserLocale;
type NonDefaultLocale = Exclude<SupportedLocale, typeof DEFAULT_LOCALE>;

export function localeDirection(locale: SupportedLocale): "ltr" | "rtl" {
  return locale === "he-IL" ? "rtl" : "ltr";
}

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

export function isSupportedLocale(value: string): value is SupportedLocale {
  return SUPPORTED_LOCALES.some((locale) => {
    return locale === value;
  });
}

const LOCALE_RESOURCE_URLS = {
  "pt-BR": { agents: ptBRAgentsUrl, common: ptBRCommonUrl },
  "ja-JP": { agents: jaJPAgentsUrl, common: jaJPCommonUrl },
  "ko-KR": { agents: koKRAgentsUrl, common: koKRCommonUrl },
  "id-ID": { agents: idIDAgentsUrl, common: idIDCommonUrl },
  "de-DE": { agents: deDEAgentsUrl, common: deDECommonUrl },
  "es-ES": { agents: esESAgentsUrl, common: esESCommonUrl },
  "it-IT": { agents: itITAgentsUrl, common: itITCommonUrl },
  "fr-FR": { agents: frFRAgentsUrl, common: frFRCommonUrl },
  "hi-IN": { agents: hiINAgentsUrl, common: hiINCommonUrl },
  "zh-Hans": { agents: zhHansAgentsUrl, common: zhHansCommonUrl },
  "zh-Hant": { agents: zhHantAgentsUrl, common: zhHantCommonUrl },
  "tr-TR": { agents: trTRAgentsUrl, common: trTRCommonUrl },
  "vi-VN": { agents: viVNAgentsUrl, common: viVNCommonUrl },
  "th-TH": { agents: thTHAgentsUrl, common: thTHCommonUrl },
  "nl-NL": { agents: nlNLAgentsUrl, common: nlNLCommonUrl },
  "sv-SE": { agents: svSEAgentsUrl, common: svSECommonUrl },
  "da-DK": { agents: daDKAgentsUrl, common: daDKCommonUrl },
  "nb-NO": { agents: nbNOAgentsUrl, common: nbNOCommonUrl },
  "fi-FI": { agents: fiFIAgentsUrl, common: fiFICommonUrl },
  "he-IL": { agents: heILAgentsUrl, common: heILCommonUrl },
  "pl-PL": { agents: plPLAgentsUrl, common: plPLCommonUrl },
  "cs-CZ": { agents: csCZAgentsUrl, common: csCZCommonUrl },
} as const satisfies Record<NonDefaultLocale, LocaleResourceUrls>;

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
  locale: NonDefaultLocale,
  namespace: "agents" | "common",
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
    return { agents: enUSAgents, common: enUSCommon };
  }

  const urls = LOCALE_RESOURCE_URLS[locale];
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
  "tr-TR": "Ekler",
  "vi-VN": "Tệp đính kèm",
  "th-TH": "ไฟล์แนบ",
  "nl-NL": "Bijlagen",
  "sv-SE": "Bilagor",
  "da-DK": "Vedhæftninger",
  "nb-NO": "Vedlegg",
  "fi-FI": "Liitteet",
  "he-IL": "קבצים מצורפים",
  "pl-PL": "Załączniki",
  "cs-CZ": "Přílohy",
} as const satisfies Record<SupportedLocale, string>;
