import type { UserLocale } from "@okouai/api-contracts/contracts/user-preferences";
import { derivePlatformServiceOrigin } from "@okouai/core/platform-service-origin";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import {
  WELCOME_THREAD_ASSETS,
  MY_OKOU_WELCOME_THREAD_ASSETS,
} from "@okouai/core/welcome-thread-assets";

import myOkouDe from "./welcome-thread-content/my-okou/de-DE.json";
import myOkouEn from "./welcome-thread-content/my-okou/en-US.json";
import myOkouEs from "./welcome-thread-content/my-okou/es-ES.json";
import myOkouFr from "./welcome-thread-content/my-okou/fr-FR.json";
import myOkouHi from "./welcome-thread-content/my-okou/hi-IN.json";
import myOkouId from "./welcome-thread-content/my-okou/id-ID.json";
import myOkouIt from "./welcome-thread-content/my-okou/it-IT.json";
import myOkouJa from "./welcome-thread-content/my-okou/ja-JP.json";
import myOkouKo from "./welcome-thread-content/my-okou/ko-KR.json";
import myOkouPt from "./welcome-thread-content/my-okou/pt-BR.json";
import myOkouZhHans from "./welcome-thread-content/my-okou/zh-Hans.json";
import myOkouZhHant from "./welcome-thread-content/my-okou/zh-Hant.json";

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
  version: 3,
  locales: {
    "en-US": myOkouEn,
    "pt-BR": myOkouPt,
    "ja-JP": myOkouJa,
    "ko-KR": myOkouKo,
    "id-ID": myOkouId,
    "de-DE": myOkouDe,
    "es-ES": myOkouEs,
    "it-IT": myOkouIt,
    "fr-FR": myOkouFr,
    "hi-IN": myOkouHi,
    "zh-Hans": myOkouZhHans,
    "zh-Hant": myOkouZhHant,
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
    ...MY_OKOU_WELCOME_THREAD_ASSETS,
    assistantName: BRAND_PRESENTATION.assistantName,
    origin,
    worksUrl: `${origin}/works`,
    myOkouUrl: `${origin}/?settings=my-okou&focus=instructions`,
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
