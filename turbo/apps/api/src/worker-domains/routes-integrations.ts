// Keep each domain statically scoped; never import the complete ROUTES registry.
import type { RouteEntry } from "../signals/route-entry";
import { githubOauthRoutes } from "../signals/routes/github-oauth";
import { webhooksGithubRoutes } from "../signals/routes/webhooks-github";
import { webhooksGmailRoutes } from "../signals/routes/webhooks-gmail";
import { webhooksGoogleFormsRoutes } from "../signals/routes/webhooks-google-forms";
import { webhooksGoogleCalendarRoutes } from "../signals/routes/webhooks-google-calendar";
import { webhooksGoogleWorkspaceEventsRoutes } from "../signals/routes/webhooks-google-workspace-events";
import { webhooksNotionRoutes } from "../signals/routes/webhooks-notion";
import { builtinConnectorsAutomaticRoutes } from "../signals/routes/connectors-automatic";
import { builtinConnectorsSlugCallbackRoutes } from "../signals/routes/connectors-slug-callback";
import { cronConnectorCatalogRoutes } from "../signals/routes/cron-connector-catalog";
import { cronConnectorOauthStateCleanupRoutes } from "../signals/routes/cron-connector-oauth-state-cleanup";
import { cronRenewGmailWatchesRoutes } from "../signals/routes/cron-renew-gmail-watches";
import { cronRenewGoogleFormsWatchesRoutes } from "../signals/routes/cron-renew-google-forms-watches";
import { cronRenewGoogleCalendarWatchesRoutes } from "../signals/routes/cron-renew-google-calendar-watches";
import { cronRenewGoogleWorkspaceEventSubscriptionsRoutes } from "../signals/routes/cron-renew-google-workspace-event-subscriptions";
import { cronTelegramCleanupRoutes } from "../signals/routes/cron-telegram-cleanup";
import { connectorAgentAccessRoutes } from "../signals/routes/connector-agent-access";
import { claudeCodeDeviceAuthRoutes } from "../signals/routes/claude-code-device-auth";
import { codexDeviceAuthRoutes } from "../signals/routes/codex-device-auth";
import { atomSubscriptionGrantRoutes } from "../signals/routes/atom-subscription-grants";
import { connectorCatalogRoutes } from "../signals/routes/connector-catalog";
import { agentConnectorAccessRoutes } from "../signals/routes/agent-connector-access";
import { connectedConnectorsRoutes } from "../signals/routes/connected-connectors";
import { connectorCheckRoutes } from "../signals/routes/connector-check";
import { builtinConnectorsExternalCodeRoutes } from "../signals/routes/connectors-external-code";
import { builtinConnectorsOauthDeviceAuthRoutes } from "../signals/routes/connectors-oauth-device-auth";
import { builtinConnectorsRoutes } from "../signals/routes/connectors";
import { connectorAccountRoutes } from "../signals/routes/connector-accounts";
import { customConnectorsRoutes } from "../signals/routes/custom-connectors";
import { emailInboundRoutes } from "../signals/routes/email-inbound";
import { mailRoutes } from "../signals/routes/mail";
import { mcpConnectorsRoutes } from "../signals/routes/mcp-connectors";
import { mcpOAuthClientMetadataRoutes } from "../signals/routes/mcp-oauth-client-metadata";
import { meModelProvidersDeleteRoutes } from "../signals/routes/me-model-providers-delete";
import { meModelProviderAccountRoutes } from "../signals/routes/me-model-provider-accounts";
import {
  meModelProvidersListRoutes,
  meThirdPartySubscriptionsListRoutes,
} from "../signals/routes/me-model-providers-list";
import { meModelProvidersResetSubscriptionRoutes } from "../signals/routes/me-model-providers-reset-subscription";
import { meModelProvidersUpsertRoutes } from "../signals/routes/me-model-providers-upsert";
import { integrationsGithubRoutes } from "../signals/routes/integrations-github";
import { slackConnectRoutes } from "../signals/routes/slack-connect";
import { slackOauthRoutes } from "../signals/routes/slack-oauth";
import { discordOauthRoutes } from "../signals/routes/discord-oauth";
import { discordInteractionsRoutes } from "../signals/routes/discord-interactions";
import { slackCommandsRoutes } from "../signals/routes/slack-commands";
import { slackEventsRoutes } from "../signals/routes/slack-events";
import { integrationsWechatRoutes } from "../signals/routes/integrations-wechat";
import { integrationsWechatMessagesRoutes } from "../signals/routes/integrations-wechat-messages";
import { integrationsWechatFileRoutes } from "../signals/routes/integrations-wechat-files";
import { wechatReceiverRoutes } from "../signals/routes/wechat-receiver";
import { discordGatewayRoutes } from "../signals/routes/discord-gateway";
import { slackInteractiveRoutes } from "../signals/routes/slack-interactive";
import { feishuBrowserConnectRoutes } from "../signals/routes/feishu-browser-connect";
import { feishuConnectRoutes } from "../signals/routes/feishu-connect";
import { feishuEventsRoutes } from "../signals/routes/feishu-events";
import { feishuOauthRoutes } from "../signals/routes/feishu-oauth";
import { teamsBrowserConnectRoutes } from "../signals/routes/teams-browser-connect";
import { teamsBotRoutes } from "../signals/routes/teams-bot";
import { teamsConnectRoutes } from "../signals/routes/teams-connect";
import { teamsOauthRoutes } from "../signals/routes/teams-oauth";
import { integrationsAgentPhoneRoutes } from "../signals/routes/integrations-agentphone";
import { integrationsPhoneDownloadFileRoutes } from "../signals/routes/integrations-phone-download-file";
import { integrationsPhoneMessageRoutes } from "../signals/routes/integrations-phone-message";
import { integrationsPhoneUploadCompleteRoutes } from "../signals/routes/integrations-phone-upload-complete";
import { integrationsPhoneUploadInitRoutes } from "../signals/routes/integrations-phone-upload-init";
import { integrationsGithubDownloadFileRoutes } from "../signals/routes/integrations-github-download-file";
import { integrationsGithubUploadCompleteRoutes } from "../signals/routes/integrations-github-upload-complete";
import { integrationsGithubUploadInitRoutes } from "../signals/routes/integrations-github-upload-init";
import { integrationsFeishuFileRoutes } from "../signals/routes/integrations-feishu-files";
import { integrationsDiscordFileRoutes } from "../signals/routes/integrations-discord-files";
import { integrationsSlackRoutes } from "../signals/routes/integrations-slack";
import { integrationsDiscordRoutes } from "../signals/routes/integrations-discord";
import { integrationsSlackMessageRoutes } from "../signals/routes/integrations-slack-message";
import { integrationsSlackReadRoutes } from "../signals/routes/integrations-slack-read";
import { integrationsDiscordReadRoutes } from "../signals/routes/integrations-discord-read";
import { integrationsDiscordMessageRoutes } from "../signals/routes/integrations-discord-message";
import { integrationsFeishuMessageRoutes } from "../signals/routes/integrations-feishu-message";
import { integrationsSlackUploadCompleteRoutes } from "../signals/routes/integrations-slack-upload-complete";
import { integrationsSlackUploadInitRoutes } from "../signals/routes/integrations-slack-upload-init";
import { integrationsSlackUploadMaterializeRoutes } from "../signals/routes/integrations-slack-upload-materialize";
import { integrationsTeamsDownloadFileRoutes } from "../signals/routes/integrations-teams-download-file";
import { integrationsTeamsMessageRoutes } from "../signals/routes/integrations-teams-message";
import { integrationsTeamsUploadCompleteRoutes } from "../signals/routes/integrations-teams-upload-complete";
import { integrationsTeamsUploadInitRoutes } from "../signals/routes/integrations-teams-upload-init";
import { slackChannelsRoutes } from "../signals/routes/slack-channels";
import { integrationsTelegramRoutes } from "../signals/routes/integrations-telegram";
import { integrationsTelegramMessageRoutes } from "../signals/routes/integrations-telegram-message";
import { integrationsTelegramUploadCompleteRoutes } from "../signals/routes/integrations-telegram-upload-complete";
import { integrationsTelegramUploadInitRoutes } from "../signals/routes/integrations-telegram-upload-init";

export const INTEGRATIONS_ROUTES: readonly RouteEntry[] = [
  ...githubOauthRoutes,
  ...webhooksGithubRoutes,
  ...webhooksGmailRoutes,
  ...webhooksGoogleFormsRoutes,
  ...webhooksGoogleCalendarRoutes,
  ...webhooksGoogleWorkspaceEventsRoutes,
  ...webhooksNotionRoutes,
  ...builtinConnectorsAutomaticRoutes,
  ...builtinConnectorsSlugCallbackRoutes,
  ...cronConnectorCatalogRoutes,
  ...cronConnectorOauthStateCleanupRoutes,
  ...cronRenewGmailWatchesRoutes,
  ...cronRenewGoogleFormsWatchesRoutes,
  ...cronRenewGoogleCalendarWatchesRoutes,
  ...cronRenewGoogleWorkspaceEventSubscriptionsRoutes,
  ...cronTelegramCleanupRoutes,
  ...connectorAgentAccessRoutes,
  ...claudeCodeDeviceAuthRoutes,
  ...codexDeviceAuthRoutes,
  ...atomSubscriptionGrantRoutes,
  ...connectorCatalogRoutes,
  ...agentConnectorAccessRoutes,
  ...connectedConnectorsRoutes,
  ...connectorCheckRoutes,
  ...builtinConnectorsExternalCodeRoutes,
  ...builtinConnectorsOauthDeviceAuthRoutes,
  ...builtinConnectorsRoutes,
  ...connectorAccountRoutes,
  ...customConnectorsRoutes,
  ...emailInboundRoutes,
  ...mailRoutes,
  ...mcpConnectorsRoutes,
  ...mcpOAuthClientMetadataRoutes,
  ...meModelProvidersDeleteRoutes,
  ...meModelProviderAccountRoutes,
  ...meModelProvidersListRoutes,
  ...meThirdPartySubscriptionsListRoutes,
  ...meModelProvidersResetSubscriptionRoutes,
  ...meModelProvidersUpsertRoutes,
  ...integrationsGithubRoutes,
  ...slackConnectRoutes,
  ...slackOauthRoutes,
  ...discordOauthRoutes,
  ...discordInteractionsRoutes,
  ...slackCommandsRoutes,
  ...slackEventsRoutes,
  ...integrationsWechatRoutes,
  ...integrationsWechatMessagesRoutes,
  ...integrationsWechatFileRoutes,
  ...wechatReceiverRoutes,
  ...discordGatewayRoutes,
  ...slackInteractiveRoutes,
  ...feishuBrowserConnectRoutes,
  ...feishuConnectRoutes,
  ...feishuEventsRoutes,
  ...feishuOauthRoutes,
  ...teamsBrowserConnectRoutes,
  ...teamsBotRoutes,
  ...teamsConnectRoutes,
  ...teamsOauthRoutes,
  ...integrationsAgentPhoneRoutes,
  ...integrationsPhoneDownloadFileRoutes,
  ...integrationsPhoneMessageRoutes,
  ...integrationsPhoneUploadCompleteRoutes,
  ...integrationsPhoneUploadInitRoutes,
  ...integrationsGithubDownloadFileRoutes,
  ...integrationsGithubUploadCompleteRoutes,
  ...integrationsGithubUploadInitRoutes,
  ...integrationsFeishuFileRoutes,
  ...integrationsDiscordFileRoutes,
  ...integrationsSlackRoutes,
  ...integrationsDiscordRoutes,
  ...integrationsSlackMessageRoutes,
  ...integrationsSlackReadRoutes,
  ...integrationsDiscordReadRoutes,
  ...integrationsDiscordMessageRoutes,
  ...integrationsFeishuMessageRoutes,
  ...integrationsSlackUploadCompleteRoutes,
  ...integrationsSlackUploadInitRoutes,
  ...integrationsSlackUploadMaterializeRoutes,
  ...integrationsTeamsDownloadFileRoutes,
  ...integrationsTeamsMessageRoutes,
  ...integrationsTeamsUploadCompleteRoutes,
  ...integrationsTeamsUploadInitRoutes,
  ...slackChannelsRoutes,
  ...integrationsTelegramRoutes,
  ...integrationsTelegramMessageRoutes,
  ...integrationsTelegramUploadCompleteRoutes,
  ...integrationsTelegramUploadInitRoutes,
];
