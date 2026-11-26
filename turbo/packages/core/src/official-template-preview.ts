import { ILLUSTRATION_TEMPLATE_ITEMS } from "./illustration-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "./presentation-template-items";
import { HISTORICAL_VIDEO_TEMPLATE_PREVIEW_URLS } from "./historical-video-template-preview-urls";
import {
  WELCOME_THREAD_ASSETS,
  MY_OKOU_WELCOME_THREAD_ASSETS,
} from "./welcome-thread-assets";

// These exact, public publications also need media identity when the App's
// preview deployment does not resolve production okou.app hostnames.
const welcomePreviewContentTypes: Readonly<Record<string, string | undefined>> =
  Object.freeze({
    [WELCOME_THREAD_ASSETS.campaignVisualUrl]: "image/jpeg",
    [WELCOME_THREAD_ASSETS.slackSceneUrl]: "image/png",
    [WELCOME_THREAD_ASSETS.telegramSceneUrl]: "image/png",
    [MY_OKOU_WELCOME_THREAD_ASSETS.myOkouQuickStartUrl]: "text/html",
    [MY_OKOU_WELCOME_THREAD_ASSETS.personalInstructionsUrl]: "image/png",
    [MY_OKOU_WELCOME_THREAD_ASSETS.workflowInstructionsUrl]: "image/png",
    [MY_OKOU_WELCOME_THREAD_ASSETS.workflowSharingUrl]: "image/png",
    "https://welcome-my-okou-20261125.okou.app": "text/html",
    // Keep image paths from the earlier refresh as images in saved messages.
    "https://welcome-my-okou-20261125.okou.app/assets/campaign-visual-b41da7d23fb9.jpg":
      "image/jpeg",
    "https://welcome-my-okou-20261125.okou.app/assets/slack-scene-9ce10cf40647.png":
      "image/png",
    "https://welcome-my-okou-20261125.okou.app/assets/telegram-scene-a83b63a9bd16.png":
      "image/png",
    "https://welcome-my-okou-20261125.okou.app/assets/my-okou-instructions-8ec43cd079ea.png":
      "image/png",
    "https://welcome-my-okou-20261125.okou.app/assets/my-okou-workflow-instructions-5f1222f7d3ea.png":
      "image/png",
    "https://welcome-my-okou-20261125.okou.app/assets/my-okou-workflow-settings-5c32a5d6a9c6.png":
      "image/png",
    // Persisted welcome messages still reference these exact publications.
    "https://static.vm0.io/vm0/welcome-thread/2026-09-17-1e76170cef99/campaign-visual.jpg":
      "image/jpeg",
    "https://static.vm0.io/vm0/welcome-thread/2026-09-17-1e76170cef99/slack-scene.png":
      "image/png",
    "https://static.vm0.io/vm0/welcome-thread/2026-09-17-1e76170cef99/telegram-scene.png":
      "image/png",
    "https://sproutpop-launch-deck-p9jk.okou.app": "text/html",
    "https://coastal-hotel-example.okou.app": "text/html",
    "https://my-okou-quickstart-20261112-review.okou.app": "text/html",
    "https://my-okou-quickstart-20261112-review.okou.app/assets/my-okou-instructions-8ec43cd079ea.png":
      "image/png",
    "https://my-okou-quickstart-20261112-review.okou.app/assets/my-okou-workflow-instructions-5f1222f7d3ea.png":
      "image/png",
    "https://my-okou-quickstart-20261112-review.okou.app/assets/my-okou-workflow-settings-5c32a5d6a9c6.png":
      "image/png",
  });

export function officialTemplatePreviewContentType(
  url: string,
): string | undefined {
  return welcomePreviewContentTypes[url];
}

// The official catalog and welcome assets own these resources. Match complete
// URLs, never a static-host prefix that could admit unrelated executable HTML.
const officialPreviewUrls = Object.freeze([
  ...ILLUSTRATION_TEMPLATE_ITEMS.flatMap((item) => {
    return item.previewImages;
  }),
  ...PRESENTATION_TEMPLATE_PICKER_ITEMS.map((item) => {
    return item.embedUrl;
  }),
  ...HISTORICAL_VIDEO_TEMPLATE_PREVIEW_URLS,
  WELCOME_THREAD_ASSETS.campaignVisualUrl,
  WELCOME_THREAD_ASSETS.slackSceneUrl,
  WELCOME_THREAD_ASSETS.telegramSceneUrl,
  WELCOME_THREAD_ASSETS.modelTiersUrl,
  WELCOME_THREAD_ASSETS.workflowTemplatePickerUrl,
  WELCOME_THREAD_ASSETS.newAgentDialogUrl,
  WELCOME_THREAD_ASSETS.presentationArtifactUrl,
  WELCOME_THREAD_ASSETS.websiteArtifactUrl,
  WELCOME_THREAD_ASSETS.quickStartUrl,
  ...Object.keys(welcomePreviewContentTypes),
]);

export function isOfficialTemplatePreviewUrl(url: string): boolean {
  return officialPreviewUrls.includes(url);
}

/** Public, static template publications have no author-owned database row. */
export function officialStaticTemplatePreview(url: URL) {
  if (
    url.origin !== "https://static.vm0.io" ||
    !isOfficialTemplatePreviewUrl(url.href)
  )
    return null;
  const deck = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
    return item.embedUrl === url.href;
  });
  return {
    filename: url.pathname.split("/").at(-1) ?? url.hostname,
    contentType: officialTemplatePreviewContentType(url.href),
    artifactKind: deck ? "presentation-html" : undefined,
    previewImageUrl: deck?.previewImage,
  };
}
