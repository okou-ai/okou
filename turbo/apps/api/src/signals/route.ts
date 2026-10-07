import type { RouteEntry } from "./route-entry";
import { agentDraftRoutes } from "./routes/agent-draft";
import { agentInstructionsRoutes } from "./routes/agent-instructions";
import { agentSetupPromptRoutes } from "./routes/agent-setup-prompts";
import { agentsRoutes } from "./routes/agents";
import { artifactCatalogRoutes } from "./routes/artifact-catalog";
import { artifactDownloadRoutes } from "./routes/artifact-downloads";
import { artifactReferenceRoutes } from "./routes/artifact-references";
import { artifactShareRoutes } from "./routes/artifact-shares";
import { authMeRoutes } from "./routes/auth-me";
import { bankingRoutes } from "./routes/banking";
import { billingAutoRechargeRoutes } from "./routes/billing-auto-recharge";
import { billingCheckoutRoutes } from "./routes/billing-checkout";
import { billingConcurrencyCheckoutRoutes } from "./routes/billing-concurrency-checkout";
import { billingConcurrencySubscriptionRoutes } from "./routes/billing-concurrency-subscriptions";
import { billingCreditCheckoutRoutes } from "./routes/billing-credit-checkout";
import { billingDowngradeRoutes } from "./routes/billing-downgrade";
import { billingInvoicesRoutes } from "./routes/billing-invoices";
import { billingPortalRoutes } from "./routes/billing-portal";
import { billingRedeemRoutes } from "./routes/billing-redeem";
import { billingRedeemCodeRoutes } from "./routes/billing-redeem-code";
import { billingRestoreRoutes } from "./routes/billing-restore";
import { billingStatusRoutes } from "./routes/billing-status";
import { billingUsagePackCreditsRoutes } from "./routes/billing-usage-pack-credits";
import { browserRoutes } from "./routes/browser";
import { browserAuthorizationRoutes } from "./routes/browser-authorization";
import { browserUserActionRoutes } from "./routes/browser-user-actions";
import { buildInfoRoutes } from "./routes/build-info";
import { builtInGenerationRoutes } from "./routes/built-in-generation";
import { chatEventsRoutes } from "./routes/chat-events";
import { chatRemoteAccessRoutes } from "./routes/chat-remote-access";
import { chatThreadRoutes } from "./routes/chat-threads";
import { claudeCodeDeviceAuthRoutes } from "./routes/claude-code-device-auth";
import { cliAuthRoutes } from "./routes/cli-auth";
import { cloudflareAccessRoutes } from "./routes/cloudflare-access";
import { codexDeviceAuthRoutes } from "./routes/codex-device-auth";
import { computerUseRoutes } from "./routes/computer-use";
import { computerUseAuthorizationRoutes } from "./routes/computer-use-authorization";
import { connectorAccountRoutes } from "./routes/connector-accounts";
import { connectorAgentAccessRoutes } from "./routes/connector-agent-access";
import { connectorCatalogRoutes } from "./routes/connector-catalog";
import { connectorCheckRoutes } from "./routes/connector-check";
import { connectorOverviewRoutes } from "./routes/connector-overview";
import { builtinConnectorsRoutes } from "./routes/connectors";
import { builtinConnectorsAutomaticRoutes } from "./routes/connectors-automatic";
import { builtinConnectorsExternalCodeRoutes } from "./routes/connectors-external-code";
import { builtinConnectorsOauthDeviceAuthRoutes } from "./routes/connectors-oauth-device-auth";
import { builtinConnectorsSlugCallbackRoutes } from "./routes/connectors-slug-callback";
import { cronBrowserReconcileRoutes } from "./routes/cron-browser-reconcile";
import { cronCleanupSandboxesRoutes } from "./routes/cron-cleanup-sandboxes";
import { cronCleanupXResourceReadsRoutes } from "./routes/cron-cleanup-x-resource-reads";
import { cronCompactChatThreadSnapshotsRoutes } from "./routes/cron-compact-chat-thread-snapshots";
import { cronCompactUsageEventsRoutes } from "./routes/cron-compact-usage-events";
import { cronComputerUseScreenshotCleanupRoutes } from "./routes/cron-computer-use-screenshot-cleanup";
import { cronConnectorCatalogRoutes } from "./routes/cron-connector-catalog";
import { cronConnectorOauthStateCleanupRoutes } from "./routes/cron-connector-oauth-state-cleanup";
import { cronConsolidatePiMemoryPhase2Routes } from "./routes/cron-consolidate-pi-memory-phase2";
import { cronDrainEmailOutboxRoutes } from "./routes/cron-drain-email-outbox";
import { cronExecuteWorkflowAutomationsRoutes } from "./routes/cron-execute-workflow-automations";
import { cronExtractPiMemoryStage1Routes } from "./routes/cron-extract-pi-memory-stage1";
import { cronMaterializeMemorySummariesRoutes } from "./routes/cron-materialize-memory-summaries";
import { cronMaterializePiResourceIndexesRoutes } from "./routes/cron-materialize-pi-resource-indexes";
import { cronMonitorChatEventQueueRoutes } from "./routes/cron-monitor-chat-event-queue";
import { cronOfficialWorkflowCatalogRoutes } from "./routes/cron-official-workflow-catalog";
import { cronProcessBackgroundJobsRoutes } from "./routes/cron-process-background-jobs";
import { cronProcessUsageEventsRoutes } from "./routes/cron-process-usage-events";
import { cronProjectChatEventSearchRoutes } from "./routes/cron-project-chat-event-search";
import { cronPruneStoragePresignedUrlsRoutes } from "./routes/cron-prune-storage-presigned-urls";
import { cronReconcileArtifactCatalogRoutes } from "./routes/cron-reconcile-artifact-catalog";
import { cronReconcileBillingEntitlementsRoutes } from "./routes/cron-reconcile-billing-entitlements";
import { cronReconcileSocialKitDownloadRoutes } from "./routes/cron-reconcile-socialkit-downloads";
import { cronRefreshHomeTaskRecommendationsRoutes } from "./routes/cron-refresh-home-task-recommendations";
import { cronRenewGmailWatchesRoutes } from "./routes/cron-renew-gmail-watches";
import { cronRenewGoogleCalendarWatchesRoutes } from "./routes/cron-renew-google-calendar-watches";
import { cronRenewGoogleFormsWatchesRoutes } from "./routes/cron-renew-google-forms-watches";
import { cronRenewGoogleWorkspaceEventSubscriptionsRoutes } from "./routes/cron-renew-google-workspace-event-subscriptions";
import { cronRetainChatEventsRoutes } from "./routes/cron-retain-chat-events";
import { cronSnapshotChatEventsRoutes } from "./routes/cron-snapshot-chat-events";
import { cronSteerRunTimeBudgetRoutes } from "./routes/cron-steer-run-time-budget";
import { cronSyncSkillsRoutes } from "./routes/cron-sync-skills";
import { cronTelegramCleanupRoutes } from "./routes/cron-telegram-cleanup";
import { customConnectorsRoutes } from "./routes/custom-connectors";
import { desktopAuthRoutes } from "./routes/desktop-auth";
import { desktopUpdateRoutes } from "./routes/desktop-updates";
import { discordGatewayRoutes } from "./routes/discord-gateway";
import { discordInteractionsRoutes } from "./routes/discord-interactions";
import { discordStatePreviewRoutes } from "./routes/discord-state-preview";
import { emailInboundRoutes } from "./routes/email-inbound";
import { emailSubscriptionRoutes } from "./routes/email-subscription";
import { emailUnsubscribeRoutes } from "./routes/email-unsubscribe";
import { featureSwitchesRoutes } from "./routes/feature-switches";
import { feishuBrowserConnectRoutes } from "./routes/feishu-browser-connect";
import { feishuConnectRoutes } from "./routes/feishu-connect";
import { feishuEventsRoutes } from "./routes/feishu-events";
import { feishuOauthRoutes } from "./routes/feishu-oauth";
import { financeRoutes } from "./routes/finance";
import { getStartedRoutes } from "./routes/get-started";
import { githubOauthRoutes } from "./routes/github-oauth";
import { healthRoutes } from "./routes/health";
import { homeTaskRecommendationRoutes } from "./routes/home-task-recommendations";
import { hostRoutes } from "./routes/host";
import { imageIoGenerateRoutes } from "./routes/image-io-generate";
import { integrationsAgentPhoneRoutes } from "./routes/integrations-agentphone";
import { integrationsDiscordRoutes } from "./routes/integrations-discord";
import { integrationsDiscordFileRoutes } from "./routes/integrations-discord-files";
import { integrationsDiscordMessageRoutes } from "./routes/integrations-discord-message";
import { integrationsDiscordReadRoutes } from "./routes/integrations-discord-read";
import { integrationsFeishuFileRoutes } from "./routes/integrations-feishu-files";
import { integrationsFeishuMessageRoutes } from "./routes/integrations-feishu-message";
import { integrationsGithubRoutes } from "./routes/integrations-github";
import { integrationsGithubDownloadFileRoutes } from "./routes/integrations-github-download-file";
import { integrationsGithubUploadCompleteRoutes } from "./routes/integrations-github-upload-complete";
import { integrationsGithubUploadInitRoutes } from "./routes/integrations-github-upload-init";
import { integrationsPhoneDownloadFileRoutes } from "./routes/integrations-phone-download-file";
import { integrationsPhoneMessageRoutes } from "./routes/integrations-phone-message";
import { integrationsPhoneUploadCompleteRoutes } from "./routes/integrations-phone-upload-complete";
import { integrationsPhoneUploadInitRoutes } from "./routes/integrations-phone-upload-init";
import { integrationsSlackRoutes } from "./routes/integrations-slack";
import { integrationsSlackMessageRoutes } from "./routes/integrations-slack-message";
import { integrationsSlackReadRoutes } from "./routes/integrations-slack-read";
import { integrationsSlackUploadCompleteRoutes } from "./routes/integrations-slack-upload-complete";
import { integrationsSlackUploadInitRoutes } from "./routes/integrations-slack-upload-init";
import { integrationsSlackUploadMaterializeRoutes } from "./routes/integrations-slack-upload-materialize";
import { integrationsTeamsDownloadFileRoutes } from "./routes/integrations-teams-download-file";
import { integrationsTeamsMessageRoutes } from "./routes/integrations-teams-message";
import { integrationsTeamsUploadCompleteRoutes } from "./routes/integrations-teams-upload-complete";
import { integrationsTeamsUploadInitRoutes } from "./routes/integrations-teams-upload-init";
import { integrationsTelegramRoutes } from "./routes/integrations-telegram";
import { integrationsTelegramMessageRoutes } from "./routes/integrations-telegram-message";
import { integrationsTelegramUploadCompleteRoutes } from "./routes/integrations-telegram-upload-complete";
import { integrationsTelegramUploadInitRoutes } from "./routes/integrations-telegram-upload-init";
import { logsRoutes } from "./routes/logs";
import { mailRoutes } from "./routes/mail";
import { mapsRoutes } from "./routes/maps";
import { mcpConnectorsRoutes } from "./routes/mcp-connectors";
import { mcpOAuthClientMetadataRoutes } from "./routes/mcp-oauth-client-metadata";
import { mcpServerRoutes } from "./routes/mcp-server";
import { meModelProviderAccountRoutes } from "./routes/me-model-provider-accounts";
import { meModelProvidersDeleteRoutes } from "./routes/me-model-providers-delete";
import { meModelProvidersListRoutes } from "./routes/me-model-providers-list";
import { meModelProvidersResetSubscriptionRoutes } from "./routes/me-model-providers-reset-subscription";
import { meModelProvidersUpsertRoutes } from "./routes/me-model-providers-upsert";
import { modelCatalogRoutes } from "./routes/model-catalog";
import { morningBriefPreferenceRoutes } from "./routes/morning-brief-preference";
import { officialWorkflowRoutes } from "./routes/official-workflows";
import { onboardingCompleteRoutes } from "./routes/onboarding-complete";
import { onboardingRecommendationRoutes } from "./routes/onboarding-recommendations";
import { onboardingSourcesRoutes } from "./routes/onboarding-sources";
import { onboardingStatusRoutes } from "./routes/onboarding-status";
import { onboardingWorkflowConnectorsRoutes } from "./routes/onboarding-workflow-connectors";
import { orgDeleteRoutes } from "./routes/org-delete";
import { orgInviteRoutes } from "./routes/org-invite";
import { orgLogoRoutes } from "./routes/org-logo";
import { orgMembersRoutes } from "./routes/org-members";
import { orgMembershipRequestsRoutes } from "./routes/org-membership-requests";
import { orgReadRoutes } from "./routes/org-read";
import { paidToolsRoutes } from "./routes/paid-tools";
import { peopleSearchRoutes } from "./routes/people-search";
import { presentationTemplatesRoutes } from "./routes/presentation-templates";
import { pushSubscriptionsRoutes } from "./routes/push-subscriptions";
import { realtimeTokenRoutes } from "./routes/realtime-token";
import { registryResourceDownloadRoutes } from "./routes/registry-resources-download";
import { runDetailRoutes } from "./routes/run-detail";
import { runModelsRoutes } from "./routes/run-models";
import { runnerCancellationRoutes } from "./routes/runner-cancellation";
import { runnerSshRoutes } from "./routes/runner-ssh";
import { runnerVncRoutes } from "./routes/runner-vnc";
import { runnerWssTicketRoutes } from "./routes/runner-wss-tickets";
import { runnersRoutes } from "./routes/runners";
import { runsRoutes } from "./routes/runs";
import { runsCancelRoutes } from "./routes/runs-cancel";
import { scrapeRoutes } from "./routes/scrape";
import { seoRoutes } from "./routes/seo";
import { sharedThreadRoutes } from "./routes/shared-threads";
import { skillImportRoutes } from "./routes/skill-import";
import { slackChannelsRoutes } from "./routes/slack-channels";
import { slackCommandsRoutes } from "./routes/slack-commands";
import { slackConnectRoutes } from "./routes/slack-connect";
import { slackEventsRoutes } from "./routes/slack-events";
import { slackInteractiveRoutes } from "./routes/slack-interactive";
import { slackOauthRoutes } from "./routes/slack-oauth";
import { slackStatePreviewRoutes } from "./routes/slack-state-preview";
import { socialRoutes } from "./routes/social";
import { socialDataRoutes } from "./routes/social-data";
import { sshAccessRoutes } from "./routes/ssh-access";
import { sshConnectionsRoutes } from "./routes/ssh-connections";
import { teamsBotRoutes } from "./routes/teams-bot";
import { teamsBrowserConnectRoutes } from "./routes/teams-browser-connect";
import { teamsConnectRoutes } from "./routes/teams-connect";
import { teamsOauthRoutes } from "./routes/teams-oauth";
import { uploadsCompleteRoutes } from "./routes/uploads-complete";
import { uploadsMultipartRoutes } from "./routes/uploads-multipart";
import { uploadsPrepareRoutes } from "./routes/uploads-prepare";
import { usageMembersRoutes } from "./routes/usage-members";
import { usageRecordRoutes } from "./routes/usage-record";
import { userExportRoutes } from "./routes/user-export";
import { userModelPreferenceRoutes } from "./routes/user-model-preference";
import { userPermissionGrantsRoutes } from "./routes/user-permission-grants";
import { userPreferencesRoutes } from "./routes/user-preferences";
import { userTemplatesRoutes } from "./routes/user-templates";
import { vncAccessRoutes } from "./routes/vnc-access";
import { vncConnectionsRoutes } from "./routes/vnc-connections";
import { voiceIoPolishRoutes } from "./routes/voice-io-polish";
import { voiceIoQuotaRoutes } from "./routes/voice-io-quota";
import { voiceIoTranscribeRoutes } from "./routes/voice-io-transcribe";
import { weatherRoutes } from "./routes/weather";
import { webDownloadRoutes } from "./routes/web-download";
import { webFileUrlRoutes } from "./routes/web-file-url";
import { webSearchRoutes } from "./routes/web-search";
import { webhooksAgentCheckpointsRoutes } from "./routes/webhooks-agent-checkpoints";
import { webhooksAgentCompleteRoutes } from "./routes/webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "./routes/webhooks-agent-events";
import { webhooksAgentFirewallAuthRoutes } from "./routes/webhooks-agent-firewall-auth";
import { webhooksAgentHealthUsageTelemetryRoutes } from "./routes/webhooks-agent-health-usage-telemetry";
import { webhooksAgentLangfuseRoutes } from "./routes/webhooks-agent-langfuse";
import { webhooksAgentSessionOutputRoutes } from "./routes/webhooks-agent-session-output";
import { webhooksAgentStorageRoutes } from "./routes/webhooks-agent-storage";
import { webhooksBuiltInGenerationRoutes } from "./routes/webhooks-built-in-generations";
import { webhooksClerkRoutes } from "./routes/webhooks-clerk";
import { webhooksGithubRoutes } from "./routes/webhooks-github";
import { webhooksGmailRoutes } from "./routes/webhooks-gmail";
import { webhooksGoogleCalendarRoutes } from "./routes/webhooks-google-calendar";
import { webhooksGoogleFormsRoutes } from "./routes/webhooks-google-forms";
import { webhooksGoogleWorkspaceEventsRoutes } from "./routes/webhooks-google-workspace-events";
import { webhooksNotionRoutes } from "./routes/webhooks-notion";
import { webhooksStripeRoutes } from "./routes/webhooks-stripe";
import { webhooksStripeAutomationEventsRoutes } from "./routes/webhooks-stripe-automation-events";
import { webhooksWorkflowAutomationsRoutes } from "./routes/webhooks-workflow-automations";
import { welcomeChatThreadRoutes } from "./routes/welcome-chat-threads";
import { workflowAutomationsRoutes } from "./routes/workflow-automations";
import { workflowsRoutes } from "./routes/workflows";

export const ROUTES: readonly RouteEntry[] = [
  ...getStartedRoutes,
  ...healthRoutes,
  ...buildInfoRoutes,
  ...authMeRoutes,
  ...cliAuthRoutes,
  ...desktopAuthRoutes,
  ...desktopUpdateRoutes,
  ...githubOauthRoutes,
  ...userExportRoutes,
  ...cronProcessBackgroundJobsRoutes,
  ...webhooksClerkRoutes,
  ...webhooksBuiltInGenerationRoutes,
  ...webhooksGithubRoutes,
  ...webhooksGmailRoutes,
  ...webhooksGoogleFormsRoutes,
  ...webhooksGoogleCalendarRoutes,
  ...webhooksGoogleWorkspaceEventsRoutes,
  ...webhooksNotionRoutes,
  ...webhooksWorkflowAutomationsRoutes,
  ...webhooksStripeRoutes,
  ...webhooksStripeAutomationEventsRoutes,
  ...webhooksAgentHealthUsageTelemetryRoutes,
  ...webhooksAgentLangfuseRoutes,
  ...webhooksAgentCheckpointsRoutes,
  ...webhooksAgentCompleteRoutes,
  ...webhooksAgentEventsRoutes,
  ...webhooksAgentSessionOutputRoutes,
  ...webhooksAgentFirewallAuthRoutes,
  ...webhooksAgentStorageRoutes,
  ...builtinConnectorsAutomaticRoutes,
  ...builtinConnectorsSlugCallbackRoutes,
  ...cronCompactChatThreadSnapshotsRoutes,
  ...cronReconcileArtifactCatalogRoutes,
  ...cronProjectChatEventSearchRoutes,
  ...cronSnapshotChatEventsRoutes,
  ...cronRetainChatEventsRoutes,
  ...cronCompactUsageEventsRoutes,
  ...cronCleanupSandboxesRoutes,
  ...cronCleanupXResourceReadsRoutes,
  ...cronConnectorCatalogRoutes,
  ...cronOfficialWorkflowCatalogRoutes,
  ...cronConnectorOauthStateCleanupRoutes,
  ...cronDrainEmailOutboxRoutes,
  ...cronRefreshHomeTaskRecommendationsRoutes,
  ...cronExecuteWorkflowAutomationsRoutes,
  ...cronMonitorChatEventQueueRoutes,
  ...cronRenewGmailWatchesRoutes,
  ...cronRenewGoogleFormsWatchesRoutes,
  ...cronRenewGoogleCalendarWatchesRoutes,
  ...cronRenewGoogleWorkspaceEventSubscriptionsRoutes,
  ...cronProcessUsageEventsRoutes,
  ...cronReconcileSocialKitDownloadRoutes,
  ...cronReconcileBillingEntitlementsRoutes,
  ...cronPruneStoragePresignedUrlsRoutes,
  ...cronMaterializeMemorySummariesRoutes,
  ...cronMaterializePiResourceIndexesRoutes,
  ...cronExtractPiMemoryStage1Routes,
  ...cronConsolidatePiMemoryPhase2Routes,
  ...cronComputerUseScreenshotCleanupRoutes,
  ...cronBrowserReconcileRoutes,
  ...cronSteerRunTimeBudgetRoutes,
  ...cronSyncSkillsRoutes,
  ...cronTelegramCleanupRoutes,
  ...emailUnsubscribeRoutes,
  ...agentDraftRoutes,
  ...agentInstructionsRoutes,
  ...agentsRoutes,
  ...connectorAgentAccessRoutes,
  ...artifactCatalogRoutes,
  ...billingAutoRechargeRoutes,
  ...billingCheckoutRoutes,
  ...billingConcurrencyCheckoutRoutes,
  ...billingConcurrencySubscriptionRoutes,
  ...billingCreditCheckoutRoutes,
  ...billingDowngradeRoutes,
  ...billingInvoicesRoutes,
  ...billingPortalRoutes,
  ...billingRedeemCodeRoutes,
  ...billingRedeemRoutes,
  ...billingRestoreRoutes,
  ...billingStatusRoutes,
  ...billingUsagePackCreditsRoutes,
  ...bankingRoutes,
  ...chatThreadRoutes,
  ...homeTaskRecommendationRoutes,
  ...welcomeChatThreadRoutes,
  ...chatEventsRoutes,
  ...sharedThreadRoutes,
  ...claudeCodeDeviceAuthRoutes,
  ...computerUseAuthorizationRoutes,
  ...computerUseRoutes,
  ...codexDeviceAuthRoutes,
  ...connectorCatalogRoutes,
  ...connectorOverviewRoutes,
  ...connectorCheckRoutes,
  ...builtinConnectorsExternalCodeRoutes,
  ...builtinConnectorsOauthDeviceAuthRoutes,
  ...builtinConnectorsRoutes,
  ...connectorAccountRoutes,
  ...customConnectorsRoutes,
  ...emailInboundRoutes,
  ...featureSwitchesRoutes,
  ...financeRoutes,
  ...seoRoutes,
  ...hostRoutes,
  ...artifactShareRoutes,
  ...artifactReferenceRoutes,
  ...artifactDownloadRoutes,
  ...builtInGenerationRoutes,
  ...imageIoGenerateRoutes,
  ...logsRoutes,
  ...mailRoutes,
  ...mapsRoutes,
  ...mcpConnectorsRoutes,
  ...mcpOAuthClientMetadataRoutes,
  ...mcpServerRoutes,
  ...weatherRoutes,
  ...scrapeRoutes,
  ...peopleSearchRoutes,
  ...webSearchRoutes,
  ...socialRoutes,
  ...socialDataRoutes,
  ...sshConnectionsRoutes,
  ...vncConnectionsRoutes,
  ...chatRemoteAccessRoutes,
  ...vncAccessRoutes,
  ...runnerVncRoutes,
  ...runnerWssTicketRoutes,
  ...cloudflareAccessRoutes,
  ...sshAccessRoutes,
  ...runnerSshRoutes,
  ...browserRoutes,
  ...browserAuthorizationRoutes,
  ...browserUserActionRoutes,
  ...modelCatalogRoutes,
  ...runModelsRoutes,
  ...meModelProvidersDeleteRoutes,
  ...meModelProviderAccountRoutes,
  ...meModelProvidersListRoutes,
  ...meModelProvidersResetSubscriptionRoutes,
  ...meModelProvidersUpsertRoutes,
  ...voiceIoQuotaRoutes,
  ...voiceIoPolishRoutes,
  ...agentSetupPromptRoutes,
  ...voiceIoTranscribeRoutes,
  ...webDownloadRoutes,
  ...webFileUrlRoutes,
  ...realtimeTokenRoutes,
  ...runDetailRoutes,
  ...runsRoutes,
  ...runsCancelRoutes,
  ...onboardingCompleteRoutes,
  ...onboardingRecommendationRoutes,
  ...onboardingStatusRoutes,
  ...onboardingSourcesRoutes,
  ...onboardingWorkflowConnectorsRoutes,
  ...orgInviteRoutes,
  ...orgDeleteRoutes,
  ...orgLogoRoutes,
  ...orgMembersRoutes,
  ...orgMembershipRequestsRoutes,
  ...orgReadRoutes,
  ...pushSubscriptionsRoutes,
  ...userPermissionGrantsRoutes,
  ...userPreferencesRoutes,
  ...paidToolsRoutes,
  ...userModelPreferenceRoutes,
  ...morningBriefPreferenceRoutes,
  ...emailSubscriptionRoutes,
  ...workflowsRoutes,
  ...officialWorkflowRoutes,
  ...workflowAutomationsRoutes,
  ...skillImportRoutes,
  ...integrationsGithubRoutes,
  ...slackConnectRoutes,
  // Registered for protected preview QA; the route's environment gate keeps
  // production indistinguishable from an unregistered endpoint.
  ...slackStatePreviewRoutes,
  ...slackOauthRoutes,
  ...discordInteractionsRoutes,
  ...slackCommandsRoutes,
  ...slackEventsRoutes,
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
  ...discordStatePreviewRoutes,
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
  ...uploadsCompleteRoutes,
  ...uploadsMultipartRoutes,
  ...uploadsPrepareRoutes,
  ...presentationTemplatesRoutes,
  ...userTemplatesRoutes,
  ...registryResourceDownloadRoutes,
  ...usageMembersRoutes,
  ...usageRecordRoutes,
  ...runnersRoutes,
  ...runnerCancellationRoutes,
];
