import type { UserLocale } from "@okouai/api-contracts/contracts/user-preferences";
import { derivePlatformServiceOrigin } from "@okouai/core/platform-service-origin";
import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/public-brand";
import { WELCOME_THREAD_ASSETS } from "@okouai/core/welcome-thread-assets";

import de from "./welcome-thread-content/de-DE.json";
import en from "./welcome-thread-content/en-US.json";
import es from "./welcome-thread-content/es-ES.json";
import fr from "./welcome-thread-content/fr-FR.json";
import hi from "./welcome-thread-content/hi-IN.json";
import id from "./welcome-thread-content/id-ID.json";
import it from "./welcome-thread-content/it-IT.json";
import ja from "./welcome-thread-content/ja-JP.json";
import ko from "./welcome-thread-content/ko-KR.json";
import pt from "./welcome-thread-content/pt-BR.json";
import zhHans from "./welcome-thread-content/zh-Hans.json";
import zhHant from "./welcome-thread-content/zh-Hant.json";

import trTR from "./welcome-thread-content/tr-TR.json";
import viVN from "./welcome-thread-content/vi-VN.json";
import thTH from "./welcome-thread-content/th-TH.json";
import nlNL from "./welcome-thread-content/nl-NL.json";
import svSE from "./welcome-thread-content/sv-SE.json";
import daDK from "./welcome-thread-content/da-DK.json";
import nbNO from "./welcome-thread-content/nb-NO.json";
import fiFI from "./welcome-thread-content/fi-FI.json";
import heIL from "./welcome-thread-content/he-IL.json";
import plPL from "./welcome-thread-content/pl-PL.json";
import csCZ from "./welcome-thread-content/cs-CZ.json";

interface WelcomeContent {
  readonly title: string;
  readonly content: string;
}

/**
 * Copy and media for newly created welcome threads. This version belongs to
 * the source template; persisted messages are immutable, and their retry
 * identity must remain independent of this version and localized text.
 */
const WELCOME_THREAD_TEMPLATE = Object.freeze({
  version: 2,
  locales: {
    "en-US": en,
    "pt-BR": pt,
    "ja-JP": ja,
    "ko-KR": ko,
    "id-ID": id,
    "de-DE": de,
    "es-ES": es,
    "it-IT": it,
    "fr-FR": fr,
    "hi-IN": hi,
    "zh-Hans": zhHans,
    "zh-Hant": zhHant,
    "tr-TR": trTR,
    "vi-VN": viVN,
    "th-TH": thTH,
    "nl-NL": nlNL,
    "sv-SE": svSE,
    "da-DK": daDK,
    "nb-NO": nbNO,
    "fi-FI": fiFI,
    "he-IL": heIL,
    "pl-PL": plPL,
    "cs-CZ": csCZ,
  } satisfies Record<UserLocale, WelcomeContent>,
});

export function welcomeThreadContent(args: {
  readonly locale: UserLocale;
  readonly appUrl: string;
}): WelcomeContent {
  const template = WELCOME_THREAD_TEMPLATE.locales[args.locale];
  const origin = new URL(args.appUrl).origin;
  const wwwUrl = derivePlatformServiceOrigin(origin, "www");
  const values: Readonly<Record<string, string>> = {
    // The official examples and scene shots are shared by every recipient.
    ...WELCOME_THREAD_ASSETS,
    assistantName: PUBLIC_BRAND_PRESENTATION.assistantName,
    origin,
    worksUrl: `${origin}/works`,
    inviteUrl: `${origin}/?settings=people`,
    wwwUrl,
    webServicesUrl: `${wwwUrl}/en/web-services`,
    workflowExamplesUrl: `${wwwUrl}/en/workflow-automation-examples`,
  };
  const interpolate = (text: string) => {
    return text.replace(/\{\{(\w+)\}\}/gu, (_, key: string) => {
      const value = values[key];
      if (value === undefined) {
        throw new Error(`Unknown welcome template placeholder: ${key}`);
      }
      return value;
    });
  };
  return {
    title: interpolate(template.title),
    content: interpolate(template.content),
  };
}
