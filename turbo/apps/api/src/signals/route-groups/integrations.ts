// Keep each domain statically scoped; never import the complete ROUTES registry.
import type { RouteEntry } from "../route-entry";
import { githubOauthRoutes } from "../routes/github-oauth";
import { webhooksGithubRoutes } from "../routes/webhooks-github";
import { webhooksGmailRoutes } from "../routes/webhooks-gmail";
import { webhooksGoogleFormsRoutes } from "../routes/webhooks-google-forms";
import { webhooksGoogleCalendarRoutes } from "../routes/webhooks-google-calendar";
import { webhooksGoogleWorkspaceEventsRoutes } from "../routes/webhooks-google-workspace-events";
import { webhooksNotionRoutes } from "../routes/webhooks-notion";
import { builtinConnectorsAutomaticRoutes } from "../routes/connectors-automatic";
import { builtinConnectorsSlugCallbackRoutes } from "../routes/connectors-slug-callback";
import { cronConnectorCatalogRoutes } from "../routes/cron-connector-catalog";
import { cronConnectorOauthStateCleanupRoutes } from "../routes/cron-connector-oauth-state-cleanup";
import { cronRenewGmailWatchesRoutes } from "../routes/cron-renew-gmail-watches";
import { cronRenewGoogleFormsWatchesRoutes } from "../routes/cron-renew-google-forms-watches";
import { cronRenewGoogleCalendarWatchesRoutes } from "../routes/cron-renew-google-calendar-watches";
import { cronRenewGoogleWorkspaceEventSubscriptionsRoutes } from "../routes/cron-renew-google-workspace-event-subscriptions";
import { cronTelegramCleanupRoutes } from "../routes/cron-telegram-cleanup";
import { connectorAgentAccessRoutes } from "../routes/connector-agent-access";
import { claudeCodeDeviceAuthRoutes } from "../routes/claude-code-device-auth";
import { codexDeviceAuthRoutes } from "../routes/codex-device-auth";
import { atomSubscriptionGrantRoutes } from "../routes/atom-subscription-grants";
import { connectorCatalogRoutes } from "../routes/connector-catalog";
import { agentConnectorAccessRoutes } from "../routes/agent-connector-access";
import { connectedConnectorsRoutes } from "../routes/connected-connectors";
import { connectorCheckRoutes } from "../routes/connector-check";
import { builtinConnectorsExternalCodeRoutes } from "../routes/connectors-external-code";
import { builtinConnectorsOauthDeviceAuthRoutes } from "../routes/connectors-oauth-device-auth";
import { builtinConnectorsRoutes } from "../routes/connectors";
import { connectorAccountRoutes } from "../routes/connector-accounts";
import { customConnectorsRoutes } from "../routes/custom-connectors";
import { emailInboundRoutes } from "../routes/email-inbound";
import { mailRoutes } from "../routes/mail";
import { mcpConnectorsRoutes } from "../routes/mcp-connectors";
import { mcpOAuthClientMetadataRoutes } from "../routes/mcp-oauth-client-metadata";
import { meModelProvidersDeleteRoutes } from "../routes/me-model-providers-delete";
import { meModelProviderAccountRoutes } from "../routes/me-model-provider-accounts";
import {
  meModelProvidersListRoutes,
  meThirdPartySubscriptionsListRoutes,
} from "../routes/me-model-providers-list";

import { meModelProvidersResetSubscriptionRoutes } from "../routes/me-model-providers-reset-subscription";
import { meModelProvidersUpsertRoutes } from "../routes/me-model-providers-upsert";
import { integrationsGithubRoutes } from "../routes/integrations-github";
import { slackConnectRoutes } from "../routes/slack-connect";
import { slackOauthRoutes } from "../routes/slack-oauth";
import { discordOauthRoutes } from "../routes/discord-oauth";
import { discordInteractionsRoutes } from "../routes/discord-interactions";
import { slackCommandsRoutes } from "../routes/slack-commands";
import { slackEventsRoutes } from "../routes/slack-events";
import { integrationsWechatRoutes } from "../routes/integrations-wechat";
import { integrationsWechatMessagesRoutes } from "../routes/integrations-wechat-messages";
import { integrationsWechatFileRoutes } from "../routes/integrations-wechat-files";
import { wechatReceiverRoutes } from "../routes/wechat-receiver";
import { discordGatewayRoutes } from "../routes/discord-gateway";
import { slackInteractiveRoutes } from "../routes/slack-interactive";
import { feishuBrowserConnectRoutes } from "../routes/feishu-browser-connect";
import { feishuConnectRoutes } from "../routes/feishu-connect";
import { feishuEventsRoutes } from "../routes/feishu-events";
import { feishuOauthRoutes } from "../routes/feishu-oauth";
import { teamsBrowserConnectRoutes } from "../routes/teams-browser-connect";
import { teamsBotRoutes } from "../routes/teams-bot";
import { teamsConnectRoutes } from "../routes/teams-connect";
import { teamsOauthRoutes } from "../routes/teams-oauth";
import { integrationsAgentPhoneRoutes } from "../routes/integrations-agentphone";
import { integrationsPhoneDownloadFileRoutes } from "../routes/integrations-phone-download-file";
import { integrationsPhoneMessageRoutes } from "../routes/integrations-phone-message";
import { integrationsPhoneUploadCompleteRoutes } from "../routes/integrations-phone-upload-complete";
import { integrationsPhoneUploadInitRoutes } from "../routes/integrations-phone-upload-init";
import { integrationsGithubDownloadFileRoutes } from "../routes/integrations-github-download-file";
import { integrationsGithubUploadCompleteRoutes } from "../routes/integrations-github-upload-complete";
import { integrationsGithubUploadInitRoutes } from "../routes/integrations-github-upload-init";
import { integrationsFeishuFileRoutes } from "../routes/integrations-feishu-files";
import { integrationsDiscordFileRoutes } from "../routes/integrations-discord-files";
import { integrationsSlackRoutes } from "../routes/integrations-slack";
import { integrationsDiscordRoutes } from "../routes/integrations-discord";
import { integrationsSlackMessageRoutes } from "../routes/integrations-slack-message";
import { integrationsSlackReadRoutes } from "../routes/integrations-slack-read";
import { integrationsDiscordReadRoutes } from "../routes/integrations-discord-read";
import { integrationsDiscordMessageRoutes } from "../routes/integrations-discord-message";
import { integrationsFeishuMessageRoutes } from "../routes/integrations-feishu-message";
import { integrationsSlackUploadCompleteRoutes } from "../routes/integrations-slack-upload-complete";
import { integrationsSlackUploadInitRoutes } from "../routes/integrations-slack-upload-init";
import { integrationsSlackUploadMaterializeRoutes } from "../routes/integrations-slack-upload-materialize";
import { integrationsTeamsDownloadFileRoutes } from "../routes/integrations-teams-download-file";
import { integrationsTeamsMessageRoutes } from "../routes/integrations-teams-message";
import { integrationsTeamsUploadCompleteRoutes } from "../routes/integrations-teams-upload-complete";
import { integrationsTeamsUploadInitRoutes } from "../routes/integrations-teams-upload-init";
import { slackChannelsRoutes } from "../routes/slack-channels";
import { integrationsTelegramRoutes } from "../routes/integrations-telegram";
import { integrationsTelegramMessageRoutes } from "../routes/integrations-telegram-message";
import { integrationsTelegramUploadCompleteRoutes } from "../routes/integrations-telegram-upload-complete";
import { integrationsTelegramUploadInitRoutes } from "../routes/integrations-telegram-upload-init";

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
