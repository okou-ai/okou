import { createAppWithRoutes } from "../app-factory-runtime";
import { createWorkerHandler } from "../worker-runtime";
import type { RouteEntry } from "../signals/route-entry";
import { healthRoutes } from "../signals/routes/health";
import { buildInfoRoutes } from "../signals/routes/build-info";
import { authMeRoutes } from "../signals/routes/auth-me";
import { cliAuthRoutes } from "../signals/routes/cli-auth";
import { desktopUpdateRoutes } from "../signals/routes/desktop-updates";
import { webhooksAgentDataRequestRoutes } from "../signals/routes/webhooks-agent-data-request";
import { dataRouterHistoryRoutes } from "../signals/routes/data-router-history";
import { cronRetainChatEventsRoutes } from "../signals/routes/cron-retain-chat-events";
import { cronCompactUsageEventsRoutes } from "../signals/routes/cron-compact-usage-events";
import { cronCleanupXResourceReadsRoutes } from "../signals/routes/cron-cleanup-x-resource-reads";
import { cronConnectorOauthStateCleanupRoutes } from "../signals/routes/cron-connector-oauth-state-cleanup";
import { cronCleanupSuggestionsRoutes } from "../signals/routes/cron-cleanup-suggestions";
import { cronMonitorChatEventQueueRoutes } from "../signals/routes/cron-monitor-chat-event-queue";
import { cronTelegramCleanupRoutes } from "../signals/routes/cron-telegram-cleanup";
import { emailUnsubscribeRoutes } from "../signals/routes/email-unsubscribe";
import { billingRedeemCodeRoutes } from "../signals/routes/billing-redeem-code";
import { billingUsagePackCreditsRoutes } from "../signals/routes/billing-usage-pack-credits";
import { featureSwitchesRoutes } from "../signals/routes/feature-switches";
import { featureGuidesRoutes } from "../signals/routes/feature-guides";
import { logsRoutes } from "../signals/routes/logs";
import { mcpOAuthClientMetadataRoutes } from "../signals/routes/mcp-oauth-client-metadata";
import { sshAccessRoutes } from "../signals/routes/ssh-access";
import { modelCatalogRoutes } from "../signals/routes/model-catalog";
import { runModelsRoutes } from "../signals/routes/run-models";
import { voiceIoQuotaRoutes } from "../signals/routes/voice-io-quota";
import { voiceIoPolishRoutes } from "../signals/routes/voice-io-polish";
import { agentSetupPromptRoutes } from "../signals/routes/agent-setup-prompts";
import { voiceIoTranscribeRoutes } from "../signals/routes/voice-io-transcribe";
import { orgLogoRoutes } from "../signals/routes/org-logo";
import { orgMembershipRequestsRoutes } from "../signals/routes/org-membership-requests";
import { orgOpenrouterPresetRoutes } from "../signals/routes/org-openrouter-preset";
import { pushSubscriptionsRoutes } from "../signals/routes/push-subscriptions";
import { iosPushRegistrationsRoutes } from "../signals/routes/ios-push-registrations";
import { iosNotificationsRoutes } from "../signals/routes/ios-notifications";
import { paidToolsRoutes } from "../signals/routes/paid-tools";
import { halloweenOperationsRoutes } from "../signals/routes/halloween-operations";
import { integrationsWechatRoutes } from "../signals/routes/integrations-wechat";
import { integrationsWechatMessagesRoutes } from "../signals/routes/integrations-wechat-messages";
import { integrationsGithubDownloadFileRoutes } from "../signals/routes/integrations-github-download-file";
import { integrationsSlackMessageRoutes } from "../signals/routes/integrations-slack-message";
import { integrationsSlackReadRoutes } from "../signals/routes/integrations-slack-read";
import { integrationsFeishuMessageRoutes } from "../signals/routes/integrations-feishu-message";
import { integrationsTeamsDownloadFileRoutes } from "../signals/routes/integrations-teams-download-file";
import { integrationsTeamsMessageRoutes } from "../signals/routes/integrations-teams-message";
import { slackChannelsRoutes } from "../signals/routes/slack-channels";
import { initializeNoServices$ } from "./initialize-no-services";

const roleRoutes: readonly RouteEntry[] = [
  ...healthRoutes,
  ...buildInfoRoutes,
  ...authMeRoutes,
  ...cliAuthRoutes,
  ...desktopUpdateRoutes,
  ...webhooksAgentDataRequestRoutes,
  ...dataRouterHistoryRoutes,
  ...cronRetainChatEventsRoutes,
  ...cronCompactUsageEventsRoutes,
  ...cronCleanupXResourceReadsRoutes,
  ...cronConnectorOauthStateCleanupRoutes,
  ...cronCleanupSuggestionsRoutes,
  ...cronMonitorChatEventQueueRoutes,
  ...cronTelegramCleanupRoutes,
  ...emailUnsubscribeRoutes,
  ...billingRedeemCodeRoutes,
  ...billingUsagePackCreditsRoutes,
  ...featureSwitchesRoutes,
  ...featureGuidesRoutes,
  ...logsRoutes,
  ...mcpOAuthClientMetadataRoutes,
  ...sshAccessRoutes,
  ...modelCatalogRoutes,
  ...runModelsRoutes,
  ...voiceIoQuotaRoutes,
  ...voiceIoPolishRoutes,
  ...agentSetupPromptRoutes,
  ...voiceIoTranscribeRoutes,
  ...orgLogoRoutes,
  ...orgMembershipRequestsRoutes,
  ...orgOpenrouterPresetRoutes,
  ...pushSubscriptionsRoutes,
  ...iosPushRegistrationsRoutes,
  ...iosNotificationsRoutes,
  ...paidToolsRoutes,
  ...halloweenOperationsRoutes,
  ...integrationsWechatRoutes,
  ...integrationsWechatMessagesRoutes,
  ...integrationsGithubDownloadFileRoutes,
  ...integrationsSlackMessageRoutes,
  ...integrationsSlackReadRoutes,
  ...integrationsFeishuMessageRoutes,
  ...integrationsTeamsDownloadFileRoutes,
  ...integrationsTeamsMessageRoutes,
  ...slackChannelsRoutes,
];

export default createWorkerHandler((signal) => {
  return createAppWithRoutes({
    signal,
    routes: roleRoutes,
    initializeServices$: initializeNoServices$,
  });
});
