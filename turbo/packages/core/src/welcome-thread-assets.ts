const ASSET_BASE =
  "https://static.vm0.io/vm0/welcome-thread/2026-09-14-4128f97d2754";

const STEP_BASE =
  "https://static.vm0.io/vm0/welcome-thread/2026-09-17-3f913309fe14";

const QUICK_START_BASE = `${STEP_BASE}/quick-start`;

export const WELCOME_THREAD_ASSETS = Object.freeze({
  slackConversationsDiagramUrl: `${ASSET_BASE}/slack-conversations.png`,
  workflowTemplatePickerUrl: `${STEP_BASE}/workflow-template-picker.png`,
  newAgentDialogUrl: `${STEP_BASE}/new-agent.png`,
  quickStartCoverUrl: `${QUICK_START_BASE}/cover.png`,
  quickStartUrl: `${QUICK_START_BASE}/okou-quick-start.html`,
  quickStartDownloadUrl: `${QUICK_START_BASE}/assets/okou-quick-start.pptx`,
});
