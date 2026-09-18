const STEP_BASE =
  "https://static.vm0.io/vm0/welcome-thread/2026-09-17-3f913309fe14";

const SCENE_BASE =
  "https://static.vm0.io/vm0/welcome-thread/2026-09-17-1e76170cef99";

// Hosted artifacts the welcome thread previews in place. The presentation and
// the quick start are published with artifactKind presentation-html so the app
// frames them as decks rather than as ordinary hosted sites.
export const WELCOME_THREAD_ASSETS = Object.freeze({
  campaignVisualUrl: `${SCENE_BASE}/campaign-visual.jpg`,
  slackSceneUrl: `${SCENE_BASE}/slack-scene.png`,
  telegramSceneUrl: `${SCENE_BASE}/telegram-scene.png`,
  modelTiersUrl: `${SCENE_BASE}/model-tiers.png`,
  workflowTemplatePickerUrl: `${STEP_BASE}/workflow-template-picker.png`,
  newAgentDialogUrl: `${STEP_BASE}/new-agent.png`,
  presentationArtifactUrl: "https://sproutpop-launch-deck-p9jk.okou.app",
  websiteArtifactUrl: "https://coastal-hotel-example.okou.app",
  quickStartUrl: "https://okou-quick-start-deck.okou.app",
});
