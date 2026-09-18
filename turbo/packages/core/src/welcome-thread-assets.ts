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
