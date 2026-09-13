import * as runActivitySnapshotSchema from "./schema/run-activity-snapshot";
import * as artifactShareSchema from "./schema/artifact-share";
import * as userSchema from "./schema/user";
import * as privacyChoiceSchema from "./schema/privacy-choice";
import * as deviceCodesSchema from "./schema/device-codes";
import * as cliTokensSchema from "./schema/cli-tokens";
import * as desktopAuthHandoffCodeSchema from "./schema/desktop-auth-handoff-code";
import * as agentSchema from "./schema/agent";
import * as agentRunSchema from "./runtime/agent-run";
import * as agentRunConnectorDiagnosticRegistrationSchema from "./schema/agent-run-connector-diagnostic-registration";
import * as conversationSchema from "./schema/conversation";
import * as checkpointSchema from "./schema/checkpoint";
import * as agentSessionSchema from "./schema/agent-session";
import * as storageSchema from "./schema/storage";
import * as systemStoragePresignedUrlCacheSchema from "./schema/system-storage-presigned-url-cache";
import * as blobSchema from "./schema/blob";

import * as sandboxTelemetrySchema from "./schema/sandbox-telemetry";
import * as runnerSchema from "./schema/runner-job-queue";
import * as runnerStateSchema from "./schema/runner-state";
import * as agentRunQueueSchema from "./schema/agent-run-queue";
import * as chatAgentRunContextSchema from "./schema/chat-agent-run-context";
import * as chatAgentphoneContextSchema from "./schema/chat-agentphone-context";
import * as chatAutomationContextSchema from "./schema/chat-automation-context";
import * as chatFeishuContextSchema from "./schema/chat-feishu-context";
import * as chatGithubContextSchema from "./schema/chat-github-context";
import * as chatSlackContextSchema from "./schema/chat-slack-context";
import * as chatTeamsContextSchema from "./schema/chat-teams-context";
import * as chatTelegramContextSchema from "./schema/chat-telegram-context";
import * as secretSchema from "./schema/secret";
import * as modelProviderSchema from "./schema/model-provider";
import * as modelProviderAccountSchema from "./schema/model-provider-account";
import * as modelProviderGatewaySchema from "./schema/model-provider-gateway";
import * as orgModelPolicySchema from "./schema/org-model-policy";
import * as variableSchema from "./schema/variable";
import * as composeJobSchema from "./schema/compose-job";
import * as connectorSchema from "./schema/connector";
import * as chatThreadConnectorSelectionSchema from "./schema/chat-thread-connector-selection";
import * as connectorExternalCodeSessionSchema from "./schema/connector-external-code-session";
import * as modelProviderAuthSessionSchema from "./schema/model-provider-auth-session";
import * as connectorOauthDeviceAuthorizationSessionSchema from "./schema/connector-oauth-device-authorization-session";
import * as connectorOauthStateSchema from "./schema/connector-oauth-state";
import * as usageEventSchema from "./schema/usage-event";
import * as usageEventHourlyRollupSchema from "./schema/usage-event-hourly-rollup";
import * as usagePackCreditGrantSchema from "./schema/usage-pack-credit-grant";
import * as usagePackCreditRefundSchema from "./schema/usage-pack-credit-refund";
import * as usagePackSubscriptionSchema from "./schema/usage-pack-subscription";
import * as runBuiltInAdmissionSchema from "./schema/run-built-in-admission";
import * as githubInstallationSchema from "./schema/github-installation";
import * as githubUserLinkSchema from "./schema/github-user-link";
import * as githubChatThreadRouteSchema from "./schema/github-chat-thread-route";
import * as telegramInstallationSchema from "./schema/telegram-installation";
import * as telegramOfficialUserLinkSchema from "./schema/telegram-official-user-link";
import * as telegramUserLinkSchema from "./schema/telegram-user-link";
import * as telegramUserAgentPreferenceSchema from "./schema/telegram-user-agent-preference";
import * as telegramChatThreadRouteSchema from "./schema/telegram-chat-thread-route";
import * as telegramMessageSchema from "./schema/telegram-message";
import * as agentphoneUserLinkSchema from "./schema/agentphone-user-link";
import * as agentphoneUserAgentPreferenceSchema from "./schema/agentphone-user-agent-preference";
import * as agentphoneChatThreadRouteSchema from "./schema/agentphone-chat-thread-route";
import * as agentphoneMessageSchema from "./schema/agentphone-message";
import * as agentphoneVerificationSendCooldownSchema from "./schema/agentphone-verification-send-cooldown";
import * as slackOrgInstallationSchema from "./schema/slack-org-installation";
import * as slackOrgConnectionSchema from "./schema/slack-org-connection";
import * as slackChatThreadRouteSchema from "./schema/slack-chat-thread-route";
import * as slackChatIngressSchema from "./schema/slack-chat-ingress";
import * as slackUserAgentPreferenceSchema from "./schema/slack-user-agent-preference";
import * as teamsOrgInstallationSchema from "./schema/teams-org-installation";
import * as teamsOrgConnectionSchema from "./schema/teams-org-connection";
import * as teamsChatThreadRouteSchema from "./schema/teams-chat-thread-route";
import * as teamsUserAgentPreferenceSchema from "./schema/teams-user-agent-preference";
import * as feishuOrgInstallationSchema from "./schema/feishu-org-installation";
import * as feishuOrgConnectionSchema from "./schema/feishu-org-connection";
import * as feishuOrgEventSchema from "./schema/feishu-org-event";
import * as feishuChatThreadRouteSchema from "./schema/feishu-chat-thread-route";
import * as feishuChatIngressSchema from "./schema/feishu-chat-ingress";
import * as feishuUserAgentPreferenceSchema from "./schema/feishu-user-agent-preference";
import * as orgSchema from "./schema/org-metadata";
import * as orgPlanEntitlementSchema from "./schema/org-plan-entitlement";
import * as orgConcurrencyEntitlementSchema from "./schema/org-concurrency-entitlement";
import * as orgConcurrencySubscriptionSchema from "./schema/org-concurrency-subscription";
import * as orgUsageAllowanceSchema from "./schema/org-usage-allowance";
import * as orgCacheSchema from "./schema/org-cache";
import * as orgMembersSchema from "./schema/org-members-metadata";
import * as orgMembersCacheSchema from "./schema/org-members-cache";
import * as userCacheSchema from "./schema/user-cache";
import * as exportJobSchema from "./schema/export-job";
import * as emailSuppressionSchema from "./schema/email-suppression";
import * as skillSchema from "./schema/skill";
import * as usagePricingSchema from "./schema/usage-pricing";
import * as agentDraftSchema from "./schema/agent-draft";
import * as userPermissionGrantSchema from "./schema/user-permission-grant";
import * as storageVersionLineageSchema from "./schema/storage-version-lineage";
import * as runUploadedFileSchema from "./schema/run-uploaded-file";
import * as builtInModelKeySchema from "./schema/built-in-model-key";
import * as builtInModelCooldownSchema from "./schema/built-in-model-cooldown";
import * as workflowSchema from "./schema/workflow";
import * as computerUseHostSchema from "./schema/computer-use-host";
import * as userFeatureSwitchesSchema from "./schema/user-feature-switches";
import * as userBehaviorCountSchema from "./schema/user-behavior-count";
import * as activeInputDeliverySchema from "./schema/active-input-delivery";
import * as chatThreadSchema from "./schema/chat-thread";
import * as chatEventSchema from "./schema/chat-event";
import * as chatEventSearchSchema from "./schema/chat-event-search";
import * as chatEventSnapshotSchema from "./schema/chat-event-snapshot";
import * as chatThreadEventSchema from "./schema/chat-thread-event";
import * as chatThreadSnapshotSchema from "./schema/chat-thread-snapshot";
import * as runOutputMaterializationSchema from "./schema/run-output-materialization";
import * as runOutputMemoryCitationSchema from "./schema/run-output-memory-citation";
import * as runOutputLegacyPiEventSchema from "./schema/run-output-legacy-pi-event";
import * as orgCustomConnectorSchema from "./schema/org-custom-connector";
import * as orgCustomConnectorOauthConfigSchema from "./schema/org-custom-connector-oauth-config";
import * as orgCustomConnectorDcrRegistrationSchema from "./schema/org-custom-connector-dcr-registration";
import * as customConnectorAccountOauthBindingSchema from "./schema/custom-connector-account-oauth-binding";
import * as hostedSiteSchema from "./schema/hosted-site";
import * as artifactSchema from "./schema/artifact";
import * as sharedThreadSchema from "./schema/shared-thread";
import * as userArtifactFavoriteSchema from "./schema/user-artifact-favorite";
import * as builtInGenerationJobSchema from "./schema/built-in-generation-job";
import * as socialKitDownloadJobSchema from "./schema/socialkit-download-job";
import * as bankingSchema from "./schema/banking";
import * as gmailEventSchema from "./schema/gmail-event";
import * as notionEventSchema from "./schema/notion-event";
import * as stripeAutomationEventSchema from "./schema/stripe-automation-event";
import * as googleCalendarEventSchema from "./schema/google-calendar-event";
import * as googleFormsEventSchema from "./schema/google-forms-event";
import * as googleWorkspaceEventSchema from "./schema/google-workspace-event";
import * as connectorCatalogSchema from "./schema/connector-catalog";
import * as officialWorkflowCatalogSchema from "./schema/official-workflow-catalog";
import * as mailDraftSchema from "./schema/mail-draft";
import * as browserSessionSchema from "./schema/browser-session";
import * as presentationTemplateSchema from "./schema/presentation-template";
import * as imageReferenceSchema from "./schema/image-reference";
import * as piResourceSnapshotSchema from "./schema/pi-resource-snapshot";
import * as piResourceVersionIndexSchema from "./schema/pi-resource-version-index";
import * as memorySummaryProjectionSchema from "./schema/memory-summary-projection";
import * as piMemoryStage1CandidateSchema from "./schema/pi-memory-stage1-candidate";
import * as piMemoryPhase2JobSchema from "./schema/pi-memory-phase2-job";
import * as piMemoryPhase2CheckpointSchema from "./schema/pi-memory-phase2-checkpoint";
import * as piMemoryPublicationProvenanceSchema from "./schema/pi-memory-publication-provenance";
import * as sshConnectionSchema from "./schema/ssh-connection";
import * as sshCredentialSchema from "./schema/ssh-credential";
import * as agentSshAccessSchema from "./schema/agent-ssh-access";

export const schema = {
  ...runActivitySnapshotSchema,
  ...userSchema,
  ...privacyChoiceSchema,
  ...artifactShareSchema,
  ...deviceCodesSchema,
  ...cliTokensSchema,
  ...desktopAuthHandoffCodeSchema,
  ...agentSchema,
  ...agentRunSchema,
  ...agentRunConnectorDiagnosticRegistrationSchema,
  ...conversationSchema,
  ...checkpointSchema,
  ...agentSessionSchema,
  ...storageSchema,
  ...systemStoragePresignedUrlCacheSchema,
  ...blobSchema,

  ...sandboxTelemetrySchema,
  ...runnerSchema,
  ...runnerStateSchema,
  ...agentRunQueueSchema,
  ...chatAgentRunContextSchema,
  ...chatAgentphoneContextSchema,
  ...chatAutomationContextSchema,
  ...chatFeishuContextSchema,
  ...chatGithubContextSchema,
  ...chatSlackContextSchema,
  ...chatTeamsContextSchema,
  ...chatTelegramContextSchema,
  ...secretSchema,
  ...modelProviderSchema,
  ...modelProviderAccountSchema,
  ...modelProviderGatewaySchema,
  ...orgModelPolicySchema,
  ...slackOrgInstallationSchema,
  ...slackOrgConnectionSchema,
  ...slackChatThreadRouteSchema,
  ...slackChatIngressSchema,
  ...slackUserAgentPreferenceSchema,
  ...teamsOrgInstallationSchema,
  ...teamsOrgConnectionSchema,
  ...teamsChatThreadRouteSchema,
  ...teamsUserAgentPreferenceSchema,
  ...feishuOrgInstallationSchema,
  ...feishuOrgConnectionSchema,
  ...feishuOrgEventSchema,
  ...feishuChatThreadRouteSchema,
  ...feishuChatIngressSchema,
  ...feishuUserAgentPreferenceSchema,
  ...variableSchema,
  ...composeJobSchema,
  ...connectorSchema,
  ...chatThreadConnectorSelectionSchema,
  ...connectorExternalCodeSessionSchema,
  ...modelProviderAuthSessionSchema,
  ...connectorOauthDeviceAuthorizationSessionSchema,
  ...connectorOauthStateSchema,
  ...usageEventSchema,
  ...usageEventHourlyRollupSchema,
  ...usagePackCreditGrantSchema,
  ...usagePackCreditRefundSchema,
  ...usagePackSubscriptionSchema,
  ...runBuiltInAdmissionSchema,
  ...githubInstallationSchema,
  ...githubUserLinkSchema,
  ...githubChatThreadRouteSchema,
  ...telegramInstallationSchema,
  ...telegramOfficialUserLinkSchema,
  ...telegramUserLinkSchema,
  ...telegramUserAgentPreferenceSchema,
  ...telegramChatThreadRouteSchema,
  ...telegramMessageSchema,
  ...agentphoneUserLinkSchema,
  ...agentphoneUserAgentPreferenceSchema,
  ...agentphoneChatThreadRouteSchema,
  ...agentphoneMessageSchema,
  ...agentphoneVerificationSendCooldownSchema,
  ...orgSchema,
  ...orgPlanEntitlementSchema,
  ...orgConcurrencyEntitlementSchema,
  ...orgConcurrencySubscriptionSchema,
  ...orgUsageAllowanceSchema,
  ...orgCacheSchema,
  ...orgMembersSchema,
  ...orgMembersCacheSchema,
  ...userCacheSchema,
  ...exportJobSchema,
  ...emailSuppressionSchema,
  ...skillSchema,
  ...usagePricingSchema,
  ...agentDraftSchema,
  ...userPermissionGrantSchema,
  ...storageVersionLineageSchema,
  ...runUploadedFileSchema,
  ...builtInModelKeySchema,
  ...builtInModelCooldownSchema,
  ...workflowSchema,
  ...computerUseHostSchema,
  ...userFeatureSwitchesSchema,
  ...userBehaviorCountSchema,
  ...activeInputDeliverySchema,
  ...chatThreadSchema,
  ...chatEventSchema,
  ...chatEventSearchSchema,
  ...chatEventSnapshotSchema,
  ...chatThreadEventSchema,
  ...chatThreadSnapshotSchema,
  ...runOutputMaterializationSchema,
  ...runOutputMemoryCitationSchema,
  ...runOutputLegacyPiEventSchema,
  ...orgCustomConnectorSchema,
  ...orgCustomConnectorOauthConfigSchema,
  ...orgCustomConnectorDcrRegistrationSchema,
  ...customConnectorAccountOauthBindingSchema,
  ...hostedSiteSchema,
  ...artifactSchema,
  ...sharedThreadSchema,
  ...userArtifactFavoriteSchema,
  ...builtInGenerationJobSchema,
  ...socialKitDownloadJobSchema,
  ...bankingSchema,
  ...gmailEventSchema,
  ...notionEventSchema,
  ...stripeAutomationEventSchema,
  ...googleCalendarEventSchema,
  ...googleFormsEventSchema,
  ...googleWorkspaceEventSchema,
  ...connectorCatalogSchema,
  ...officialWorkflowCatalogSchema,
  ...mailDraftSchema,
  ...browserSessionSchema,
  ...presentationTemplateSchema,
  ...imageReferenceSchema,
  ...piResourceSnapshotSchema,
  ...piResourceVersionIndexSchema,
  ...memorySummaryProjectionSchema,
  ...piMemoryStage1CandidateSchema,
  ...piMemoryPhase2JobSchema,
  ...piMemoryPhase2CheckpointSchema,
  ...piMemoryPublicationProvenanceSchema,
  ...sshConnectionSchema,
  ...sshCredentialSchema,
  ...agentSshAccessSchema,
};

export type DatabaseSchema = typeof schema;
