import { http, HttpResponse } from "msw";

import deDE from "../../i18n/clerk-localizations/de-DE.json";
import deDEUrl from "../../i18n/clerk-localizations/de-DE.json?url";
import esES from "../../i18n/clerk-localizations/es-ES.json";
import esESUrl from "../../i18n/clerk-localizations/es-ES.json?url";
import frFR from "../../i18n/clerk-localizations/fr-FR.json";
import frFRUrl from "../../i18n/clerk-localizations/fr-FR.json?url";
import hiIN from "../../i18n/clerk-localizations/hi-IN.json";
import hiINUrl from "../../i18n/clerk-localizations/hi-IN.json?url";
import idID from "../../i18n/clerk-localizations/id-ID.json";
import idIDUrl from "../../i18n/clerk-localizations/id-ID.json?url";
import itIT from "../../i18n/clerk-localizations/it-IT.json";
import itITUrl from "../../i18n/clerk-localizations/it-IT.json?url";
import jaJP from "../../i18n/clerk-localizations/ja-JP.json";
import jaJPUrl from "../../i18n/clerk-localizations/ja-JP.json?url";
import koKR from "../../i18n/clerk-localizations/ko-KR.json";
import koKRUrl from "../../i18n/clerk-localizations/ko-KR.json?url";
import ptBR from "../../i18n/clerk-localizations/pt-BR.json";
import ptBRUrl from "../../i18n/clerk-localizations/pt-BR.json?url";
import zhHans from "../../i18n/clerk-localizations/zh-Hans.json";
import zhHansUrl from "../../i18n/clerk-localizations/zh-Hans.json?url";
import zhHant from "../../i18n/clerk-localizations/zh-Hant.json";
import zhHantUrl from "../../i18n/clerk-localizations/zh-Hant.json?url";
import type { SupportedLocale } from "../../i18n/resources.ts";

export type ClerkLocalizationLocale = Exclude<SupportedLocale, "en-US">;

const clerkLocalizationFixtures = [
  { locale: "de-DE", localization: deDE, url: deDEUrl },
  { locale: "es-ES", localization: esES, url: esESUrl },
  { locale: "fr-FR", localization: frFR, url: frFRUrl },
  { locale: "hi-IN", localization: hiIN, url: hiINUrl },
  { locale: "id-ID", localization: idID, url: idIDUrl },
  { locale: "it-IT", localization: itIT, url: itITUrl },
  { locale: "ja-JP", localization: jaJP, url: jaJPUrl },
  { locale: "ko-KR", localization: koKR, url: koKRUrl },
  { locale: "pt-BR", localization: ptBR, url: ptBRUrl },
  { locale: "zh-Hans", localization: zhHans, url: zhHansUrl },
  { locale: "zh-Hant", localization: zhHant, url: zhHantUrl },
] as const;

export function clerkLocalizationFixtureForRequest(requestUrl: string) {
  const requestPath = new URL(requestUrl, location.href).pathname;
  return clerkLocalizationFixtures.find(({ url }) => {
    return new URL(url, location.href).pathname === requestPath;
  });
}

export const clerkLocalizationHandlers = clerkLocalizationFixtures.map(
  ({ localization, url }) => {
    return http.get(url, () => {
      return HttpResponse.json(localization);
    });
  },
);
