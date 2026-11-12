import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { HISTORICAL_VIDEO_TEMPLATE_PREVIEW_URLS } from "@okouai/core/historical-video-template-preview-urls";
import {
  WELCOME_THREAD_ASSETS,
  MY_OKOU_WELCOME_THREAD_ASSETS,
} from "@okouai/core/welcome-thread-assets";

// These exact, public publications also need media identity when the App's
// preview deployment does not resolve production okou.app hostnames.
const myOkouPreviewContentTypes: Readonly<Record<string, string | undefined>> =
  Object.freeze({
    [MY_OKOU_WELCOME_THREAD_ASSETS.myOkouQuickStartUrl]: "text/html",
    [MY_OKOU_WELCOME_THREAD_ASSETS.personalInstructionsUrl]: "image/png",
    [MY_OKOU_WELCOME_THREAD_ASSETS.workflowInstructionsUrl]: "image/png",
    [MY_OKOU_WELCOME_THREAD_ASSETS.workflowSharingUrl]: "image/png",
  });

export function officialTemplatePreviewContentType(
  url: string,
): string | undefined {
  return myOkouPreviewContentTypes[url];
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
  ...Object.keys(myOkouPreviewContentTypes),
]);

export function isOfficialTemplatePreviewUrl(url: string): boolean {
  return officialPreviewUrls.includes(url);
}
