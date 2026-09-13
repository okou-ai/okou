import { introVideoRenderRoutes } from "./routes/intro-video-render";
import { cronMaterializePiResourceIndexesRoutes } from "./routes/cron-materialize-pi-resource-indexes";
import { authMeRoutes } from "./routes/auth-me";
import { cliAuthRoutes } from "./routes/cli-auth";
import type { RouteEntry } from "./route-entry";
import { connectorsSlugCallbackRoutes } from "./routes/connectors-slug-callback";
import { cronCompactChatThreadSnapshotsRoutes } from "./routes/cron-compact-chat-thread-snapshots";
import { cronProjectChatEventSearchRoutes } from "./routes/cron-project-chat-event-search";
import { cronSnapshotChatEventsRoutes } from "./routes/cron-snapshot-chat-events";
import { cronRetainChatEventsRoutes } from "./routes/cron-retain-chat-events";
import { cronCompactUsageEventsRoutes } from "./routes/cron-compact-usage-events";
import { cronCleanupSandboxesRoutes } from "./routes/cron-cleanup-sandboxes";
import { cronConnectorCatalogRoutes } from "./routes/cron-connector-catalog";
import { cronOfficialWorkflowCatalogRoutes } from "./routes/cron-official-workflow-catalog";
import { cronConnectorOauthStateCleanupRoutes } from "./routes/cron-connector-oauth-state-cleanup";
import { cronDrainEmailOutboxRoutes } from "./routes/cron-drain-email-outbox";
import { cronExecuteWorkflowAutomationsRoutes } from "./routes/cron-execute-workflow-automations";
import { cronMonitorChatEventQueueRoutes } from "./routes/cron-monitor-chat-event-queue";
import { cronRenewGmailWatchesRoutes } from "./routes/cron-renew-gmail-watches";
import { cronRenewGoogleFormsWatchesRoutes } from "./routes/cron-renew-google-forms-watches";
import { cronRenewGoogleCalendarWatchesRoutes } from "./routes/cron-renew-google-calendar-watches";
import { cronRenewGoogleWorkspaceEventSubscriptionsRoutes } from "./routes/cron-renew-google-workspace-event-subscriptions";
import { cronProcessUsageEventsRoutes } from "./routes/cron-process-usage-events";
import { cronReconcileSocialKitDownloadRoutes } from "./routes/cron-reconcile-socialkit-downloads";
import { cronReconcileBillingEntitlementsRoutes } from "./routes/cron-reconcile-billing-entitlements";
import { cronRefreshStoragePresignedUrlsRoutes } from "./routes/cron-refresh-storage-presigned-urls";
import { cronMaterializeMemorySummariesRoutes } from "./routes/cron-materialize-memory-summaries";
import { cronExtractPiMemoryStage1Routes } from "./routes/cron-extract-pi-memory-stage1";
import { cronConsolidatePiMemoryPhase2Routes } from "./routes/cron-consolidate-pi-memory-phase2";
import { cronComputerUseScreenshotCleanupRoutes } from "./routes/cron-computer-use-screenshot-cleanup";
import { cronBrowserReconcileRoutes } from "./routes/cron-browser-reconcile";
import { cronSteerRunTimeBudgetRoutes } from "./routes/cron-steer-run-time-budget";
import { cronSyncSkillsRoutes } from "./routes/cron-sync-skills";
import { cronTelegramCleanupRoutes } from "./routes/cron-telegram-cleanup";
import { desktopAuthRoutes } from "./routes/desktop-auth";
import { desktopUpdateRoutes } from "./routes/desktop-updates";
import { emailUnsubscribeRoutes } from "./routes/email-unsubscribe";
import { healthRoutes } from "./routes/health";
import { buildInfoRoutes } from "./routes/build-info";
import { githubOauthRoutes } from "./routes/github-oauth";
import { registryResourceDownloadRoutes } from "./routes/registry-resources-download";
import { runnersRoutes } from "./routes/runners";
import { userExportRoutes } from "./routes/user-export";
import { webhooksAgentCheckpointsRoutes } from "./routes/webhooks-agent-checkpoints";
import { webhooksAgentCompleteRoutes } from "./routes/webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "./routes/webhooks-agent-events";
import { webhooksAgentFirewallAuthRoutes } from "./routes/webhooks-agent-firewall-auth";
import { webhooksAgentHealthUsageTelemetryRoutes } from "./routes/webhooks-agent-health-usage-telemetry";
import { webhooksAgentStorageRoutes } from "./routes/webhooks-agent-storage";
import { webhooksBuiltInGenerationRoutes } from "./routes/webhooks-built-in-generations";
import { webhooksClerkRoutes } from "./routes/webhooks-clerk";
import { webhooksGithubRoutes } from "./routes/webhooks-github";
import { webhooksGmailRoutes } from "./routes/webhooks-gmail";
import { webhooksGoogleFormsRoutes } from "./routes/webhooks-google-forms";
import { webhooksGoogleCalendarRoutes } from "./routes/webhooks-google-calendar";
import { webhooksGoogleWorkspaceEventsRoutes } from "./routes/webhooks-google-workspace-events";
import { webhooksNotionRoutes } from "./routes/webhooks-notion";
import { webhooksWorkflowAutomationsRoutes } from "./routes/webhooks-workflow-automations";
import { webhooksStripeRoutes } from "./routes/webhooks-stripe";
import { webhooksStripeAutomationEventsRoutes } from "./routes/webhooks-stripe-automation-events";
import { agentDraftRoutes } from "./routes/agent-draft";
import { agentInstructionsRoutes } from "./routes/agent-instructions";
import { agentsRoutes } from "./routes/agents";
import { artifactCatalogRoutes } from "./routes/artifact-catalog";
import { acquisitionAttributionRoutes } from "./routes/acquisition-attribution";
import { billingAutoRechargeRoutes } from "./routes/billing-auto-recharge";
import { billingCheckoutRoutes } from "./routes/billing-checkout";
import { billingConcurrencyCheckoutRoutes } from "./routes/billing-concurrency-checkout";
import { billingConcurrencySubscriptionRoutes } from "./routes/billing-concurrency-subscriptions";
import { billingCreditCheckoutRoutes } from "./routes/billing-credit-checkout";
import { billingDowngradeRoutes } from "./routes/billing-downgrade";
import { billingInvoicesRoutes } from "./routes/billing-invoices";
import { billingPortalRoutes } from "./routes/billing-portal";
import { billingRedeemCodeRoutes } from "./routes/billing-redeem-code";
import { billingRedeemRoutes } from "./routes/billing-redeem";
import { billingRestoreRoutes } from "./routes/billing-restore";
import { billingStatusRoutes } from "./routes/billing-status";
import { billingUsagePackCreditsRoutes } from "./routes/billing-usage-pack-credits";
import { bankingRoutes } from "./routes/banking";
import { chatThreadRoutes } from "./routes/chat-threads";
import { welcomeChatThreadRoutes } from "./routes/welcome-chat-threads";
import { chatEventsRoutes } from "./routes/chat-events";
import { chatTranslationRoutes } from "./routes/chat-translation";
import { sharedThreadRoutes } from "./routes/shared-threads";
import { claudeCodeDeviceAuthRoutes } from "./routes/claude-code-device-auth";
import { computerUseAuthorizationRoutes } from "./routes/computer-use-authorization";
import { computerUseRoutes } from "./routes/computer-use";
import { codexDeviceAuthRoutes } from "./routes/codex-device-auth";
import { connectorCatalogRoutes } from "./routes/connector-catalog";
import { connectorCheckRoutes } from "./routes/connector-check";
import { connectorsExternalCodeRoutes } from "./routes/connectors-external-code";
import { connectorsOauthDeviceAuthRoutes } from "./routes/connectors-oauth-device-auth";
import { connectorsRoutes } from "./routes/connectors";
import { connectorAccountRoutes } from "./routes/connector-accounts";
import { customConnectorsRoutes } from "./routes/custom-connectors";
import { emailInboundRoutes } from "./routes/email-inbound";
import { featureSwitchesRoutes } from "./routes/feature-switches";
import { financeRoutes } from "./routes/finance";
import { seoRoutes } from "./routes/seo";
import { artifactShareRoutes } from "./routes/artifact-shares";
import { artifactReferenceRoutes } from "./routes/artifact-references";
import { hostRoutes } from "./routes/host";
import { builtInGenerationRoutes } from "./routes/built-in-generation";
import { imageIoGenerateRoutes } from "./routes/image-io-generate";
import { logsRoutes } from "./routes/logs";
import { mailRoutes } from "./routes/mail";
import { mapsRoutes } from "./routes/maps";
import { mcpConnectorsRoutes } from "./routes/mcp-connectors";
import { mcpOAuthClientMetadataRoutes } from "./routes/mcp-oauth-client-metadata";
import { weatherRoutes } from "./routes/weather";
import { modelPoliciesRoutes } from "./routes/model-policies";
import { modelProviderGatewayRoutes } from "./routes/model-provider-gateways";
import { modelProvidersRoutes } from "./routes/model-providers";
import { onboardingCompleteRoutes } from "./routes/onboarding-complete";
import { onboardingStatusRoutes } from "./routes/onboarding-status";
import { orgInviteRoutes } from "./routes/org-invite";
import { orgDeleteRoutes } from "./routes/org-delete";
import { orgLogoRoutes } from "./routes/org-logo";
import { orgMembersRoutes } from "./routes/org-members";
import { orgMembershipRequestsRoutes } from "./routes/org-membership-requests";
import { orgReadRoutes } from "./routes/org-read";
import { pushSubscriptionsRoutes } from "./routes/push-subscriptions";
import { queuePositionRoutes } from "./routes/queue-position";
import { realtimeTokenRoutes } from "./routes/realtime-token";
import { imageRecognitionRoutes } from "./routes/image-recognition";
import { runDetailRoutes } from "./routes/run-detail";
import { runsRoutes } from "./routes/runs";
import { runsCancelRoutes } from "./routes/runs-cancel";
import { meModelProvidersDeleteRoutes } from "./routes/me-model-providers-delete";
import { meModelProviderAccountRoutes } from "./routes/me-model-provider-accounts";
import { meModelProvidersListRoutes } from "./routes/me-model-providers-list";
import { meModelProvidersResetSubscriptionRoutes } from "./routes/me-model-providers-reset-subscription";
import { meModelProvidersUpsertRoutes } from "./routes/me-model-providers-upsert";
import { scrapeRoutes } from "./routes/scrape";
import { peopleSearchRoutes } from "./routes/people-search";
import { webSearchRoutes } from "./routes/web-search";
import { socialRoutes } from "./routes/social";
import { sshConnectionsRoutes } from "./routes/ssh-connections";
import { sshAccessRoutes } from "./routes/ssh-access";
import { runnerSshRoutes } from "./routes/runner-ssh";
import { browserRoutes } from "./routes/browser";
import { browserAuthorizationRoutes } from "./routes/browser-authorization";
import { workflowsRoutes } from "./routes/workflows";
import { officialWorkflowRoutes } from "./routes/official-workflows";
import { emailSubscriptionRoutes } from "./routes/email-subscription";
import { morningBriefPreferenceRoutes } from "./routes/morning-brief-preference";
import { workflowAutomationsRoutes } from "./routes/workflow-automations";
import { integrationsGithubRoutes } from "./routes/integrations-github";
import { integrationsAgentPhoneRoutes } from "./routes/integrations-agentphone";
import { integrationsPhoneDownloadFileRoutes } from "./routes/integrations-phone-download-file";
import { integrationsPhoneMessageRoutes } from "./routes/integrations-phone-message";
import { integrationsPhoneUploadCompleteRoutes } from "./routes/integrations-phone-upload-complete";
import { integrationsPhoneUploadInitRoutes } from "./routes/integrations-phone-upload-init";
import { integrationsGithubDownloadFileRoutes } from "./routes/integrations-github-download-file";
import { integrationsGithubUploadCompleteRoutes } from "./routes/integrations-github-upload-complete";
import { integrationsGithubUploadInitRoutes } from "./routes/integrations-github-upload-init";
import { integrationsFeishuFileRoutes } from "./routes/integrations-feishu-files";
import { integrationsSlackRoutes } from "./routes/integrations-slack";
import { integrationsSlackMessageRoutes } from "./routes/integrations-slack-message";
import { integrationsSlackReadRoutes } from "./routes/integrations-slack-read";
import { integrationsFeishuMessageRoutes } from "./routes/integrations-feishu-message";
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
import { slackChannelsRoutes } from "./routes/slack-channels";
import { slackCommandsRoutes } from "./routes/slack-commands";
import { slackConnectRoutes } from "./routes/slack-connect";
import { slackEventsRoutes } from "./routes/slack-events";
import { slackInteractiveRoutes } from "./routes/slack-interactive";
import { slackOauthRoutes } from "./routes/slack-oauth";
import { feishuBrowserConnectRoutes } from "./routes/feishu-browser-connect";
import { feishuConnectRoutes } from "./routes/feishu-connect";
import { feishuEventsRoutes } from "./routes/feishu-events";
import { feishuOauthRoutes } from "./routes/feishu-oauth";
import { teamsBrowserConnectRoutes } from "./routes/teams-browser-connect";
import { teamsBotRoutes } from "./routes/teams-bot";
import { teamsConnectRoutes } from "./routes/teams-connect";
import { teamsOauthRoutes } from "./routes/teams-oauth";
import { uploadsCompleteRoutes } from "./routes/uploads-complete";
import { uploadsMultipartRoutes } from "./routes/uploads-multipart";
import { uploadsPrepareRoutes } from "./routes/uploads-prepare";
import { presentationTemplatesRoutes } from "./routes/presentation-templates";
import { imageReferencesRoutes } from "./routes/image-references";
import { usageMembersRoutes } from "./routes/usage-members";
import { usageRecordRoutes } from "./routes/usage-record";
import { userPreferencesRoutes } from "./routes/user-preferences";
import { userPermissionGrantsRoutes } from "./routes/user-permission-grants";
import { userModelPreferenceRoutes } from "./routes/user-model-preference";
import { avatarVideoRoutes } from "./routes/avatar-video";
import { introVideoAgentRoutes } from "./routes/intro-video-agent";
import { introVideoPresenterRoutes } from "./routes/intro-video-presenter";
import { voiceIoQuotaRoutes } from "./routes/voice-io-quota";
import { voiceIoPolishRoutes } from "./routes/voice-io-polish";
import { voiceIoSpeechRoutes } from "./routes/voice-io-speech";
import { voiceIoSttRoutes } from "./routes/voice-io-stt";
import { voiceIoTranscribeRoutes } from "./routes/voice-io-transcribe";
import { videoIoGenerateRoutes } from "./routes/video-io-generate";
import { webDownloadRoutes } from "./routes/web-download";
import { webFileUrlRoutes } from "./routes/web-file-url";

export const ROUTES: readonly RouteEntry[] = [
  ...healthRoutes,
  ...buildInfoRoutes,
  ...authMeRoutes,
  ...cliAuthRoutes,
  ...desktopAuthRoutes,
  ...desktopUpdateRoutes,
  ...githubOauthRoutes,
  ...userExportRoutes,
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
  ...webhooksAgentCheckpointsRoutes,
  ...webhooksAgentCompleteRoutes,
  ...webhooksAgentEventsRoutes,
  ...webhooksAgentFirewallAuthRoutes,
  ...webhooksAgentStorageRoutes,
  ...connectorsSlugCallbackRoutes,
  ...cronCompactChatThreadSnapshotsRoutes,
  ...cronProjectChatEventSearchRoutes,
  ...cronSnapshotChatEventsRoutes,
  ...cronRetainChatEventsRoutes,
  ...cronCompactUsageEventsRoutes,
  ...cronCleanupSandboxesRoutes,
  ...cronConnectorCatalogRoutes,
  ...cronOfficialWorkflowCatalogRoutes,
  ...cronConnectorOauthStateCleanupRoutes,
  ...cronDrainEmailOutboxRoutes,
  ...cronExecuteWorkflowAutomationsRoutes,
  ...cronMonitorChatEventQueueRoutes,
  ...cronRenewGmailWatchesRoutes,
  ...cronRenewGoogleFormsWatchesRoutes,
  ...cronRenewGoogleCalendarWatchesRoutes,
  ...cronRenewGoogleWorkspaceEventSubscriptionsRoutes,
  ...cronProcessUsageEventsRoutes,
  ...cronReconcileSocialKitDownloadRoutes,
  ...cronReconcileBillingEntitlementsRoutes,
  ...cronRefreshStoragePresignedUrlsRoutes,
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
  ...artifactCatalogRoutes,
  ...acquisitionAttributionRoutes,
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
  ...welcomeChatThreadRoutes,
  ...chatEventsRoutes,
  ...chatTranslationRoutes,
  ...sharedThreadRoutes,
  ...claudeCodeDeviceAuthRoutes,
  ...computerUseAuthorizationRoutes,
  ...computerUseRoutes,
  ...codexDeviceAuthRoutes,
  ...connectorCatalogRoutes,
  ...connectorCheckRoutes,
  ...connectorsExternalCodeRoutes,
  ...connectorsOauthDeviceAuthRoutes,
  ...connectorsRoutes,
  ...connectorAccountRoutes,
  ...customConnectorsRoutes,
  ...emailInboundRoutes,
  ...featureSwitchesRoutes,
  ...financeRoutes,
  ...seoRoutes,
  ...hostRoutes,
  ...artifactShareRoutes,
  ...artifactReferenceRoutes,
  ...builtInGenerationRoutes,
  ...imageIoGenerateRoutes,
  ...avatarVideoRoutes,
  ...introVideoPresenterRoutes,
  ...introVideoAgentRoutes,
  ...introVideoRenderRoutes,
  ...videoIoGenerateRoutes,
  ...logsRoutes,
  ...mailRoutes,
  ...mapsRoutes,
  ...mcpConnectorsRoutes,
  ...mcpOAuthClientMetadataRoutes,
  ...weatherRoutes,
  ...scrapeRoutes,
  ...peopleSearchRoutes,
  ...webSearchRoutes,
  ...socialRoutes,
  ...sshConnectionsRoutes,
  ...sshAccessRoutes,
  ...runnerSshRoutes,
  ...browserRoutes,
  ...browserAuthorizationRoutes,
  ...modelPoliciesRoutes,
  ...modelProviderGatewayRoutes,
  ...modelProvidersRoutes,
  ...meModelProvidersDeleteRoutes,
  ...meModelProviderAccountRoutes,
  ...meModelProvidersListRoutes,
  ...meModelProvidersResetSubscriptionRoutes,
  ...meModelProvidersUpsertRoutes,
  ...voiceIoQuotaRoutes,
  ...voiceIoPolishRoutes,
  ...voiceIoSpeechRoutes,
  ...voiceIoSttRoutes,
  ...voiceIoTranscribeRoutes,
  ...webDownloadRoutes,
  ...webFileUrlRoutes,
  ...queuePositionRoutes,
  ...realtimeTokenRoutes,
  ...imageRecognitionRoutes,
  ...runDetailRoutes,
  ...runsRoutes,
  ...runsCancelRoutes,
  ...onboardingCompleteRoutes,
  ...onboardingStatusRoutes,
  ...orgInviteRoutes,
  ...orgDeleteRoutes,
  ...orgLogoRoutes,
  ...orgMembersRoutes,
  ...orgMembershipRequestsRoutes,
  ...orgReadRoutes,
  ...pushSubscriptionsRoutes,
  ...userPermissionGrantsRoutes,
  ...userPreferencesRoutes,
  ...userModelPreferenceRoutes,
  ...morningBriefPreferenceRoutes,
  ...emailSubscriptionRoutes,
  ...workflowsRoutes,
  ...officialWorkflowRoutes,
  ...workflowAutomationsRoutes,
  ...integrationsGithubRoutes,
  ...slackConnectRoutes,
  ...slackOauthRoutes,
  ...slackCommandsRoutes,
  ...slackEventsRoutes,
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
  ...integrationsSlackRoutes,
  ...integrationsSlackMessageRoutes,
  ...integrationsSlackReadRoutes,
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
  ...imageReferencesRoutes,
  ...registryResourceDownloadRoutes,
  ...usageMembersRoutes,
  ...usageRecordRoutes,
  ...runnersRoutes,
];
