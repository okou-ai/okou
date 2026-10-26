/**
 * MSW Request Handlers
 *
 * This file aggregates all API mock handlers.
 * Import handlers from individual files and combine them here.
 */

import { resetAblySubscriptions } from "../ably.ts";
import {
  apiAgentsHandlers,
  resetMockAgents,
  resetMockUserConnectors,
} from "./api-agents.ts";
import { apiBillingHandlers, resetMockBilling } from "./api-billing.ts";
import { apiBuildInfoHandlers } from "./api-build-info.ts";
import {
  apiConnectorsHandlers,
  resetMockConnectors,
} from "./api-connectors.ts";
import {
  apiEmailSubscriptionHandlers,
  resetMockEmailSubscription,
} from "./api-email-subscription.ts";
import { apiFeatureSwitchesHandlers } from "./api-feature-switches.ts";
import { apiGetStartedHandlers } from "./api-get-started.ts";
import { apiHalloweenHandlers } from "./api-halloween.ts";
import { apiHostHandlers } from "./api-host.ts";
import {
  apiIntegrationsAgentPhoneHandlers,
  resetMockAgentPhoneIntegration,
} from "./api-integrations-agentphone.ts";
import { apiIntegrationsDiscordHandlers } from "./api-integrations-discord.ts";
import {
  apiIntegrationsGithubHandlers,
  resetMockGithubIntegration,
} from "./api-integrations-github.ts";
import {
  apiIntegrationsSlackConnectHandlers,
  resetMockSlackConnect,
} from "./api-integrations-slack-connect.ts";
import {
  apiIntegrationsSlackOrgHandlers,
  resetMockSlackOrgIntegration,
} from "./api-integrations-slack-org.ts";
import {
  apiIntegrationsTeamsHandlers,
  resetMockTeamsIntegration,
} from "./api-integrations-teams.ts";
import {
  apiIntegrationsTelegramHandlers,
  resetMockTelegramIntegration,
} from "./api-integrations-telegram.ts";
import { appLogsHandlers } from "./api-logs.ts";
import { apiMarketingEventsHandlers } from "./api-marketing-events.ts";
import { apiModelCatalogHandlers } from "./api-model-catalog.ts";
import {
  apiMorningBriefPreferenceHandlers,
  resetMockMorningBriefPreference,
} from "./api-morning-brief-preference.ts";
import {
  apiOnboardingHandlers,
  resetMockOnboardingStatus,
} from "./api-onboarding.ts";
import {
  apiOrgMembersHandlers,
  resetMockOrgMembers,
} from "./api-org-members.ts";
import { apiOrgHandlers, resetMockOrg, resetMockOrgLogo } from "./api-org.ts";
import { apiPaidToolsHandlers, resetMockPaidTools } from "./api-paid-tools.ts";
import {
  apiPersonalModelProvidersHandlers,
  resetMockPersonalModelProviders,
} from "./api-personal-model-providers.ts";
import { apiPresentationTemplatesHandlers } from "./api-presentation-templates.ts";
import { apiRealtimeHandlers } from "./api-realtime.ts";
import {
  apiAvailableRunModelsHandlers,
  resetMockAvailableRunModels,
} from "./api-run-models.ts";
import { apiRunsHandlers } from "./api-runs.ts";
import { apiSkillImportHandlers } from "./api-skill-import.ts";
import {
  apiUsageRecordHandlers,
  resetMockUsageRecord,
} from "./api-usage-record.ts";
import { apiUsageHandlers, resetMockUsageMembers } from "./api-usage.ts";
import {
  apiUserModelPreferenceHandlers,
  resetMockUserModelPreference,
} from "./api-user-model-preference.ts";
import {
  apiUserPermissionGrantsHandlers,
  resetMockUserPermissionGrants,
} from "./api-user-permission-grants.ts";
import {
  apiUserPreferencesHandlers,
  resetMockUserPreferences,
} from "./api-user-preferences.ts";
import {
  apiUserTemplatesHandlers,
  resetMockUserTemplates,
} from "./api-user-templates.ts";
import { apiVoiceIoHandlers } from "./api-voice-io.ts";
import { apiWebFilesHandlers } from "./api-web-files.ts";
import { apiWorkflowsHandlers, resetMockWorkflows } from "./api-workflows.ts";
import { chatThreadEmojiHandlers } from "./chat-thread-emoji.ts";
import { clerkLocalizationHandlers } from "./clerk-localizations.ts";
import { localeResourceHandlers } from "./locale-resources.ts";
import { resetMockWorkflowAutomations } from "./workflow-automations-store.ts";
import {
  apiProactiveSuggestionsHandlers,
  resetMockProactiveSuggestions,
} from "./api-proactive-suggestions.ts";
import { apiJobsHandlers, resetMockJobs } from "./api-jobs.ts";

export const handlers = [
  ...apiHostHandlers,
  ...apiMarketingEventsHandlers,
  ...clerkLocalizationHandlers,
  ...localeResourceHandlers,
  ...chatThreadEmojiHandlers,
  ...apiBuildInfoHandlers,
  ...apiConnectorsHandlers,
  ...apiOrgHandlers,
  ...apiOrgMembersHandlers,
  ...apiUsageHandlers,
  ...apiUsageRecordHandlers,
  ...apiModelCatalogHandlers,
  ...apiAvailableRunModelsHandlers,
  ...apiPersonalModelProvidersHandlers,
  ...apiPresentationTemplatesHandlers,
  ...apiUserTemplatesHandlers,
  ...appLogsHandlers,
  ...apiIntegrationsSlackOrgHandlers,
  ...apiIntegrationsTelegramHandlers,
  ...apiIntegrationsTeamsHandlers,
  ...apiIntegrationsDiscordHandlers,
  ...apiIntegrationsAgentPhoneHandlers,
  ...apiIntegrationsGithubHandlers,
  ...apiAgentsHandlers,
  ...apiWorkflowsHandlers,
  ...apiSkillImportHandlers,
  ...apiRunsHandlers,
  ...apiUserPreferencesHandlers,
  ...apiPaidToolsHandlers,
  ...apiMorningBriefPreferenceHandlers,
  ...apiProactiveSuggestionsHandlers,
  ...apiJobsHandlers,
  ...apiEmailSubscriptionHandlers,
  ...apiUserModelPreferenceHandlers,
  ...apiOnboardingHandlers,
  ...apiBillingHandlers,
  ...apiIntegrationsSlackConnectHandlers,
  ...apiFeatureSwitchesHandlers,
  ...apiGetStartedHandlers,
  ...apiHalloweenHandlers,
  ...apiRealtimeHandlers,
  ...apiUserPermissionGrantsHandlers,
  ...apiVoiceIoHandlers,
  ...apiWebFilesHandlers,
];

export function resetAllMockHandlers(): void {
  resetMockConnectors();
  resetMockSlackOrgIntegration();
  resetMockTelegramIntegration();
  resetMockTeamsIntegration();
  resetMockAgentPhoneIntegration();
  resetMockGithubIntegration();
  resetMockUserPreferences();
  resetMockPaidTools();
  resetMockMorningBriefPreference();
  resetMockProactiveSuggestions();
  resetMockJobs();
  resetMockEmailSubscription();
  resetMockUserModelPreference();
  resetMockAvailableRunModels();
  resetMockPersonalModelProviders();
  resetMockUserTemplates();
  resetMockBilling();
  resetMockSlackConnect();
  resetAblySubscriptions();
  resetMockUserPermissionGrants();
  resetMockOrg();
  resetMockOrgLogo();
  resetMockOrgMembers();
  resetMockUsageMembers();
  resetMockUsageRecord();
  resetMockWorkflowAutomations();
  resetMockAgents();
  resetMockUserConnectors();
  resetMockWorkflows();
  resetMockOnboardingStatus();
}
