import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { VIDEO_TEMPLATE_ITEMS } from "@okouai/core/video-template-items";
import { WELCOME_THREAD_ASSETS } from "@okouai/core/welcome-thread-assets";

// The official catalog and welcome assets own these resources. Match complete
// URLs, never a static-host prefix that could admit unrelated executable HTML.
const officialPreviewUrls = Object.freeze([
  ...ILLUSTRATION_TEMPLATE_ITEMS.flatMap((item) => {
    return item.previewImages;
  }),
  ...PRESENTATION_TEMPLATE_PICKER_ITEMS.map((item) => {
    return item.embedUrl;
  }),
  ...VIDEO_TEMPLATE_ITEMS.map((item) => {
    return item.previewVideo;
  }),
  WELCOME_THREAD_ASSETS.teamLearningDiagramUrl,
  WELCOME_THREAD_ASSETS.sharedWorkflowDiagramUrl,
  WELCOME_THREAD_ASSETS.slackConversationsDiagramUrl,
  WELCOME_THREAD_ASSETS.workflowGuideCoverUrl,
  WELCOME_THREAD_ASSETS.workflowGuideUrl,
]);

export function isOfficialTemplatePreviewUrl(url: string): boolean {
  return officialPreviewUrls.includes(url);
}
