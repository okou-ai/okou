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
  } satisfies Record<UserLocale, WelcomeContent>,
});

// These immutable official examples are shared by every recipient. Their
// ordinary chat previews are implemented separately in #33205's S2.
const IMAGE_URL =
  "https://static.vm0.io/vm0/artifact-templates/illustration/assets/bb2f13d1-f849-4a5c-a493-524bc0eda5c2/ref-bookshop-interior.jpg";
const PRESENTATION_URL =
  "https://static.vm0.io/vm0/artifact-templates/presentation/daf7c2d1-5195-4c09-ad4b-8d85778fc104/playful-launch-presentation.html";
const VIDEO_URL =
  "https://static.vm0.io/vm0/artifact-templates/video/df99de74-8eea-420c-86d1-c104ba5ba6b6/video-df99de74.mp4";

export function welcomeThreadContent(args: {
  readonly locale: UserLocale;
  readonly appUrl: string;
}): WelcomeContent {
  const template = WELCOME_THREAD_TEMPLATE.locales[args.locale];
  const origin = new URL(args.appUrl).origin;
  const values: Readonly<Record<string, string>> = {
    ...WELCOME_THREAD_ASSETS,
    assistantName: PUBLIC_BRAND_PRESENTATION.assistantName,
    imageUrl: IMAGE_URL,
    presentationPreviewUrl: PRESENTATION_URL,
    presentationUrl: PRESENTATION_URL,
    slideCount: "15",
    workflowGuideSlideCount: "14",
    videoUrl: VIDEO_URL,
    worksUrl: `${origin}/works`,
    inviteUrl: `${origin}/?settings=people`,
    docsUrl: `${derivePlatformServiceOrigin(origin, "www")}/docs`,
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
