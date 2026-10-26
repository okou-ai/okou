const STEP_BASE =
  "https://static.vm0.io/vm0/welcome-thread/2026-09-17-3f913309fe14";

const SCENE_BASE =
  "https://static.vm0.io/vm0/welcome-thread/2026-09-17-1e76170cef99";

// Hosted artifacts the welcome thread previews in place. A deck frames as a
// presentation when its own publication recorded artifactKind
// presentation-html, and as an ordinary hosted site otherwise; either way the
// okou.app framing resolves only on production hostnames, because
// resolveHostedSiteDomains excludes okou.app elsewhere.
export const WELCOME_THREAD_ASSETS = Object.freeze({
  campaignVisualUrl: `${SCENE_BASE}/campaign-visual.jpg`,
  slackSceneUrl: `${SCENE_BASE}/slack-scene.png`,
  telegramSceneUrl: `${SCENE_BASE}/telegram-scene.png`,
  modelTiersUrl: `${SCENE_BASE}/model-tiers.png`,
  workflowTemplatePickerUrl: `${STEP_BASE}/workflow-template-picker.png`,
  newAgentDialogUrl: `${STEP_BASE}/new-agent.png`,
  presentationArtifactUrl: "https://sproutpop-launch-deck-p9jk.okou.app",
  websiteArtifactUrl: "https://coastal-hotel-example.okou.app",
  quickStartUrl: "https://4nnp6iwpss.okou.app",
});

const PREVIEW_BASE =
  "https://static.vm0.io/vm0/welcome-thread/2026-10-26-previews";

// These official publications predate uploaded covers. Keep their original
// URLs so persisted welcome messages receive the same static preview.
const welcomePreviews = [
  {
    url: `${WELCOME_THREAD_ASSETS.presentationArtifactUrl}/`,
    image: `${PREVIEW_BASE}/sproutpop-a826bd3d2831.png`,
  },
  {
    url: `${WELCOME_THREAD_ASSETS.websiteArtifactUrl}/`,
    image: `${PREVIEW_BASE}/coastal-hotel-d2b4e1caa3c1.png`,
  },
  {
    url: `${WELCOME_THREAD_ASSETS.quickStartUrl}/`,
    image: `${PREVIEW_BASE}/quick-start-eb0e18d9a32b.png`,
  },
] as const;

/** Apply only after the publication's current access policy has been checked. */
export function welcomeThreadPreviewImageUrl(url: string): string | undefined {
  return welcomePreviews.find((preview) => {
    return preview.url === url;
  })?.image;
}
