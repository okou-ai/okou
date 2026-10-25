// Build-time ownership only. Preserve production route order.
export const WORKER_DOMAINS = ["core", "execution", "integrations", "data"];
export const ROUTE_MODULE_OWNERSHIP = [
  {
    domain: "execution",
    module: "../signals/routes/runners-startup",
    exportName: "runnersStartupRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/get-started",
    exportName: "getStartedRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/health",
    exportName: "healthRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/build-info",
    exportName: "buildInfoRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/auth-me",
    exportName: "authMeRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/cli-auth",
    exportName: "cliAuthRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/desktop-updates",
    exportName: "desktopUpdateRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/github-oauth",
    exportName: "githubOauthRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/user-export",
    exportName: "userExportRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/cron-process-background-jobs",
    exportName: "cronProcessBackgroundJobsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/cron-reconcile-image-generations",
    exportName: "cronReconcileImageGenerationsRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/webhooks-clerk",
    exportName: "webhooksClerkRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/webhooks-built-in-generations",
    exportName: "webhooksBuiltInGenerationRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/webhooks-github",
    exportName: "webhooksGithubRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/webhooks-gmail",
    exportName: "webhooksGmailRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/webhooks-google-forms",
    exportName: "webhooksGoogleFormsRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/webhooks-google-calendar",
    exportName: "webhooksGoogleCalendarRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/webhooks-google-workspace-events",
    exportName: "webhooksGoogleWorkspaceEventsRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/webhooks-notion",
    exportName: "webhooksNotionRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/webhooks-workflow-automations",
    exportName: "webhooksWorkflowAutomationsRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/webhooks-stripe",
    exportName: "webhooksStripeRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/webhooks-stripe-connect",
    exportName: "webhooksStripeConnectRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/webhooks-agent-health-usage-telemetry",
    exportName: "webhooksAgentHealthUsageTelemetryRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/webhooks-agent-complete",
    exportName: "webhooksAgentCompleteRoutes",
  },
  {
    domain: "data",
    module: "../signals/routes/webhooks-agent-data-request",
    exportName: "webhooksAgentDataRequestRoutes",
  },
  {
    domain: "data",
    module: "../signals/routes/data-router-history",
    exportName: "dataRouterHistoryRoutes",
  },
  {
    domain: "data",
    module: "../signals/routes/data-router-tools",
    exportName: "dataRouterToolsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/webhooks-agent-events",
    exportName: "webhooksAgentEventsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/webhooks-agent-session-output",
    exportName: "webhooksAgentSessionOutputRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/webhooks-agent-firewall-auth",
    exportName: "webhooksAgentFirewallAuthRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/webhooks-agent-storage",
    exportName: "webhooksAgentStorageRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/connectors-automatic",
    exportName: "builtinConnectorsAutomaticRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/wallet",
    exportName: "walletRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/link-approval-workflow",
    exportName: "linkApprovalWorkflowRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/connectors-slug-callback",
    exportName: "builtinConnectorsSlugCallbackRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/cron-compact-chat-thread-snapshots",
    exportName: "cronCompactChatThreadSnapshotsRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/cron-reconcile-artifact-catalog",
    exportName: "cronReconcileArtifactCatalogRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/cron-project-chat-event-search",
    exportName: "cronProjectChatEventSearchRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/cron-snapshot-chat-events",
    exportName: "cronSnapshotChatEventsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/cron-retain-chat-events",
    exportName: "cronRetainChatEventsRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/cron-compact-usage-events",
    exportName: "cronCompactUsageEventsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/cron-cleanup-sandboxes",
    exportName: "cronCleanupSandboxesRoutes",
  },
  {
    domain: "data",
    module: "../signals/routes/cron-cleanup-x-resource-reads",
    exportName: "cronCleanupXResourceReadsRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/cron-connector-catalog",
    exportName: "cronConnectorCatalogRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/cron-official-workflow-catalog",
    exportName: "cronOfficialWorkflowCatalogRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/cron-connector-oauth-state-cleanup",
    exportName: "cronConnectorOauthStateCleanupRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/cron-drain-email-outbox",
    exportName: "cronDrainEmailOutboxRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/cron-execute-workflow-automations",
    exportName: "cronExecuteWorkflowAutomationsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/cron-monitor-chat-event-queue",
    exportName: "cronMonitorChatEventQueueRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/cron-renew-gmail-watches",
    exportName: "cronRenewGmailWatchesRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/cron-renew-google-forms-watches",
    exportName: "cronRenewGoogleFormsWatchesRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/cron-renew-google-calendar-watches",
    exportName: "cronRenewGoogleCalendarWatchesRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/cron-renew-google-workspace-event-subscriptions",
    exportName: "cronRenewGoogleWorkspaceEventSubscriptionsRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/cron-process-usage-events",
    exportName: "cronProcessUsageEventsRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/cron-reconcile-billing-entitlements",
    exportName: "cronReconcileBillingEntitlementsRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/cron-prune-storage-presigned-urls",
    exportName: "cronPruneStoragePresignedUrlsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/cron-materialize-pi-resource-indexes",
    exportName: "cronMaterializePiResourceIndexesRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/cron-computer-use-screenshot-cleanup",
    exportName: "cronComputerUseScreenshotCleanupRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/cron-browser-reconcile",
    exportName: "cronBrowserReconcileRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/cron-steer-run-time-budget",
    exportName: "cronSteerRunTimeBudgetRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/cron-sync-skills",
    exportName: "cronSyncSkillsRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/cron-telegram-cleanup",
    exportName: "cronTelegramCleanupRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/email-unsubscribe",
    exportName: "emailUnsubscribeRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/agent-draft",
    exportName: "agentDraftRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/suggestions",
    exportName: "suggestionsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/jobs",
    exportName: "jobsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/agent-instructions",
    exportName: "agentInstructionsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/agents",
    exportName: "agentsRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/connector-agent-access",
    exportName: "connectorAgentAccessRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/artifact-catalog",
    exportName: "artifactCatalogRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/billing-auto-recharge",
    exportName: "billingAutoRechargeRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/billing-checkout",
    exportName: "billingCheckoutRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/billing-concurrency-checkout",
    exportName: "billingConcurrencyCheckoutRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/billing-concurrency-subscriptions",
    exportName: "billingConcurrencySubscriptionRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/billing-credit-checkout",
    exportName: "billingCreditCheckoutRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/billing-downgrade",
    exportName: "billingDowngradeRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/billing-invoices",
    exportName: "billingInvoicesRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/billing-portal",
    exportName: "billingPortalRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/billing-redeem-code",
    exportName: "billingRedeemCodeRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/billing-redeem",
    exportName: "billingRedeemRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/billing-restore",
    exportName: "billingRestoreRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/billing-status",
    exportName: "billingStatusRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/billing-usage-pack-credits",
    exportName: "billingUsagePackCreditsRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/banking",
    exportName: "bankingRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/chat-threads",
    exportName: "chatThreadRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/welcome-chat-threads",
    exportName: "welcomeChatThreadRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/chat-events",
    exportName: "chatEventsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/shared-threads",
    exportName: "sharedThreadRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/claude-code-device-auth",
    exportName: "claudeCodeDeviceAuthRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/computer-use-authorization",
    exportName: "computerUseAuthorizationRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/desktop-shell-authorization",
    exportName: "desktopShellAuthorizationRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/computer-use",
    exportName: "computerUseRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/codex-device-auth",
    exportName: "codexDeviceAuthRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/atom-subscription-grants",
    exportName: "atomSubscriptionGrantRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/connector-catalog",
    exportName: "connectorCatalogRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/agent-connector-access",
    exportName: "agentConnectorAccessRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/connected-connectors",
    exportName: "connectedConnectorsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/remotes",
    exportName: "remotesRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/connector-check",
    exportName: "connectorCheckRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/connectors-external-code",
    exportName: "builtinConnectorsExternalCodeRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/connectors-oauth-device-auth",
    exportName: "builtinConnectorsOauthDeviceAuthRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/connectors",
    exportName: "builtinConnectorsRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/connector-accounts",
    exportName: "connectorAccountRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/custom-connectors",
    exportName: "customConnectorsRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/email-inbound",
    exportName: "emailInboundRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/feature-switches",
    exportName: "featureSwitchesRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/host",
    exportName: "hostRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/artifact-shares",
    exportName: "artifactShareRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/artifact-references",
    exportName: "artifactReferenceRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/artifact-og",
    exportName: "artifactOgRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/artifact-downloads",
    exportName: "artifactDownloadRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/built-in-generation",
    exportName: "builtInGenerationRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/image-io-generate",
    exportName: "imageIoGenerateRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/logs",
    exportName: "logsRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/mail",
    exportName: "mailRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/mcp-connectors",
    exportName: "mcpConnectorsRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/mcp-oauth-client-metadata",
    exportName: "mcpOAuthClientMetadataRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/mcp-server",
    exportName: "mcpServerRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/ssh-connections",
    exportName: "sshConnectionsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/vnc-connections",
    exportName: "vncConnectionsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/chat-remote-access",
    exportName: "chatRemoteAccessRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/vnc-access",
    exportName: "vncAccessRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/runner-vnc",
    exportName: "runnerVncRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/cloudflare-access",
    exportName: "cloudflareAccessRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/tailscale",
    exportName: "tailscaleRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/ssh-access",
    exportName: "sshAccessRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/runner-ssh",
    exportName: "runnerSshRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/browser",
    exportName: "browserRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/browser-authorization",
    exportName: "browserAuthorizationRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/browser-user-actions",
    exportName: "browserUserActionRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/model-catalog",
    exportName: "modelCatalogRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/run-models",
    exportName: "runModelsRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/me-model-providers-delete",
    exportName: "meModelProvidersDeleteRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/me-model-provider-accounts",
    exportName: "meModelProviderAccountRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/me-model-providers-list",
    exportName: "meModelProvidersListRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/me-model-providers-list",
    exportName: "meThirdPartySubscriptionsListRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/me-model-providers-reset-subscription",
    exportName: "meModelProvidersResetSubscriptionRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/me-model-providers-upsert",
    exportName: "meModelProvidersUpsertRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/voice-io-quota",
    exportName: "voiceIoQuotaRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/voice-io-polish",
    exportName: "voiceIoPolishRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/agent-setup-prompts",
    exportName: "agentSetupPromptRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/voice-io-transcribe",
    exportName: "voiceIoTranscribeRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/web-file-url",
    exportName: "webFileUrlRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/realtime-token",
    exportName: "realtimeTokenRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/run-detail",
    exportName: "runDetailRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/runs",
    exportName: "runsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/runs-cancel",
    exportName: "runsCancelRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/onboarding-complete",
    exportName: "onboardingCompleteRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/onboarding-recommendations",
    exportName: "onboardingRecommendationRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/onboarding-status",
    exportName: "onboardingStatusRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/onboarding-sources",
    exportName: "onboardingSourcesRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/org-invite",
    exportName: "orgInviteRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/org-delete",
    exportName: "orgDeleteRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/org-logo",
    exportName: "orgLogoRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/org-members",
    exportName: "orgMembersRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/org-membership-requests",
    exportName: "orgMembershipRequestsRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/org-read",
    exportName: "orgReadRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/org-openrouter-preset",
    exportName: "orgOpenrouterPresetRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/push-subscriptions",
    exportName: "pushSubscriptionsRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/user-permission-grants",
    exportName: "userPermissionGrantsRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/user-preferences",
    exportName: "userPreferencesRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/paid-tools",
    exportName: "paidToolsRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/user-model-preference",
    exportName: "userModelPreferenceRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/morning-brief-preference",
    exportName: "morningBriefPreferenceRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/proactive-preferences",
    exportName: "proactiveSuggestionsRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/proactive-preferences",
    exportName: "proactiveJobsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/proactive-preferences",
    exportName: "proactiveLearningRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/proactive-preferences",
    exportName: "proactivePlanningRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/email-subscription",
    exportName: "emailSubscriptionRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/notifications",
    exportName: "notificationsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/debug-morning-brief",
    exportName: "debugMorningBriefRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/workflows",
    exportName: "workflowsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/workflow-automations",
    exportName: "workflowAutomationsRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/skill-import",
    exportName: "skillImportRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-github",
    exportName: "integrationsGithubRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/slack-connect",
    exportName: "slackConnectRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/slack-oauth",
    exportName: "slackOauthRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/discord-oauth",
    exportName: "discordOauthRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/discord-interactions",
    exportName: "discordInteractionsRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/slack-commands",
    exportName: "slackCommandsRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/slack-events",
    exportName: "slackEventsRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-wechat",
    exportName: "integrationsWechatRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-wechat-messages",
    exportName: "integrationsWechatMessagesRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-wechat-files",
    exportName: "integrationsWechatFileRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/wechat-receiver",
    exportName: "wechatReceiverRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/discord-gateway",
    exportName: "discordGatewayRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/slack-interactive",
    exportName: "slackInteractiveRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/feishu-browser-connect",
    exportName: "feishuBrowserConnectRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/feishu-connect",
    exportName: "feishuConnectRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/feishu-events",
    exportName: "feishuEventsRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/feishu-oauth",
    exportName: "feishuOauthRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/teams-browser-connect",
    exportName: "teamsBrowserConnectRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/teams-bot",
    exportName: "teamsBotRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/teams-connect",
    exportName: "teamsConnectRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/teams-oauth",
    exportName: "teamsOauthRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-agentphone",
    exportName: "integrationsAgentPhoneRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-phone-download-file",
    exportName: "integrationsPhoneDownloadFileRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-phone-message",
    exportName: "integrationsPhoneMessageRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-phone-upload-complete",
    exportName: "integrationsPhoneUploadCompleteRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-phone-upload-init",
    exportName: "integrationsPhoneUploadInitRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-github-download-file",
    exportName: "integrationsGithubDownloadFileRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-github-upload-complete",
    exportName: "integrationsGithubUploadCompleteRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-github-upload-init",
    exportName: "integrationsGithubUploadInitRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-feishu-files",
    exportName: "integrationsFeishuFileRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-discord-files",
    exportName: "integrationsDiscordFileRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-slack",
    exportName: "integrationsSlackRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-discord",
    exportName: "integrationsDiscordRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-slack-message",
    exportName: "integrationsSlackMessageRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-slack-read",
    exportName: "integrationsSlackReadRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-discord-read",
    exportName: "integrationsDiscordReadRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-discord-message",
    exportName: "integrationsDiscordMessageRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-feishu-message",
    exportName: "integrationsFeishuMessageRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-slack-upload-complete",
    exportName: "integrationsSlackUploadCompleteRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-slack-upload-init",
    exportName: "integrationsSlackUploadInitRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-slack-upload-materialize",
    exportName: "integrationsSlackUploadMaterializeRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-teams-download-file",
    exportName: "integrationsTeamsDownloadFileRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-teams-message",
    exportName: "integrationsTeamsMessageRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-teams-upload-complete",
    exportName: "integrationsTeamsUploadCompleteRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-teams-upload-init",
    exportName: "integrationsTeamsUploadInitRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/slack-channels",
    exportName: "slackChannelsRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-telegram",
    exportName: "integrationsTelegramRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-telegram-message",
    exportName: "integrationsTelegramMessageRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-telegram-upload-complete",
    exportName: "integrationsTelegramUploadCompleteRoutes",
  },
  {
    domain: "integrations",
    module: "../signals/routes/integrations-telegram-upload-init",
    exportName: "integrationsTelegramUploadInitRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/uploads-complete",
    exportName: "uploadsCompleteRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/uploads-multipart",
    exportName: "uploadsMultipartRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/uploads-prepare",
    exportName: "uploadsPrepareRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/presentation-templates",
    exportName: "presentationTemplatesRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/user-templates",
    exportName: "userTemplatesRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/registry-resources-download",
    exportName: "registryResourceDownloadRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/usage-members",
    exportName: "usageMembersRoutes",
  },
  {
    domain: "core",
    module: "../signals/routes/usage-record",
    exportName: "usageRecordRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/runners",
    exportName: "runnersRoutes",
  },
  {
    domain: "execution",
    module: "../signals/routes/runner-cancellation",
    exportName: "runnerCancellationRoutes",
  },
];
