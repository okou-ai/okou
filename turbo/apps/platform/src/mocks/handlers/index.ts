/**
 * MSW Request Handlers
 *
 * This file aggregates all API mock handlers.
 * Import handlers from individual files and combine them here.
 */

import {
  apiConnectorsHandlers,
  resetMockConnectors,
} from "./api-connectors.ts";
import { apiOrgHandlers, resetMockOrg, resetMockOrgLogo } from "./api-org.ts";
import {
  apiOrgMembersHandlers,
  resetMockOrgMembers,
} from "./api-org-members.ts";
import { apiUsageHandlers, resetMockUsageMembers } from "./api-usage.ts";
import {
  apiUsageRecordHandlers,
  resetMockUsageRecord,
} from "./api-usage-record.ts";
import {
  apiOrgModelProvidersHandlers,
  resetMockOrgModelProviders,
} from "./api-org-model-providers.ts";
import {
  apiOrgModelPoliciesHandlers,
  resetMockOrgModelPolicies,
} from "./api-org-model-policies.ts";
import {
  apiPersonalModelProvidersHandlers,
  resetMockPersonalModelProviders,
} from "./api-personal-model-providers.ts";
import {
  apiPresentationTemplatesHandlers,
  resetMockPresentationTemplates,
} from "./api-presentation-templates.ts";
import {
  apiUserTemplatesHandlers,
  resetMockUserTemplates,
} from "./api-user-templates.ts";
import { appLogsHandlers } from "./api-logs.ts";
import {
  apiIntegrationsSlackOrgHandlers,
  resetMockSlackOrgIntegration,
} from "./api-integrations-slack-org.ts";
import {
  apiIntegrationsTelegramHandlers,
  resetMockTelegramIntegration,
} from "./api-integrations-telegram.ts";
import {
  apiIntegrationsTeamsHandlers,
  resetMockTeamsIntegration,
} from "./api-integrations-teams.ts";
import {
  apiIntegrationsAgentPhoneHandlers,
  resetMockAgentPhoneIntegration,
} from "./api-integrations-agentphone.ts";
import {
  apiIntegrationsGithubHandlers,
  resetMockGithubIntegration,
} from "./api-integrations-github.ts";
import {
  apiAgentsHandlers,
  resetMockAgents,
  resetMockUserConnectors,
} from "./api-agents.ts";
import { apiWorkflowsHandlers, resetMockWorkflows } from "./api-workflows.ts";
import { apiRunsHandlers } from "./api-runs.ts";
import { apiFeatureSwitchesHandlers } from "./api-feature-switches.ts";
import { apiPaidToolsHandlers, resetMockPaidTools } from "./api-paid-tools.ts";
import { apiGetStartedHandlers } from "./api-get-started.ts";
import { apiRealtimeHandlers } from "./api-realtime.ts";
import { resetAblySubscriptions } from "../ably.ts";
import {
  apiUserPreferencesHandlers,
  resetMockUserPreferences,
} from "./api-user-preferences.ts";
import {
  apiEmailSubscriptionHandlers,
  resetMockEmailSubscription,
} from "./api-email-subscription.ts";
import {
  apiMorningBriefPreferenceHandlers,
  resetMockMorningBriefPreference,
} from "./api-morning-brief-preference.ts";
import {
  apiUserModelPreferenceHandlers,
  resetMockUserModelPreference,
} from "./api-user-model-preference.ts";
import {
  apiOnboardingHandlers,
  resetMockOnboardingStatus,
} from "./api-onboarding.ts";
import { apiBillingHandlers, resetMockBilling } from "./api-billing.ts";
import { apiAttributionHandlers } from "./api-attribution.ts";
import { resetMockWorkflowAutomations } from "./workflow-automations-store.ts";
import { apiQueuePositionHandlers } from "./api-queue-position.ts";
import {
  apiIntegrationsSlackConnectHandlers,
  resetMockSlackConnect,
} from "./api-integrations-slack-connect.ts";
import {
  apiUserPermissionGrantsHandlers,
  resetMockUserPermissionGrants,
} from "./api-user-permission-grants.ts";
import { apiVoiceIoHandlers } from "./api-voice-io.ts";
import { apiBuildInfoHandlers } from "./api-build-info.ts";
import { apiWebFilesHandlers } from "./api-web-files.ts";
import { localeResourceHandlers } from "./locale-resources.ts";
import { clerkLocalizationHandlers } from "./clerk-localizations.ts";

export const handlers = [
  ...clerkLocalizationHandlers,
  ...localeResourceHandlers,
  ...apiBuildInfoHandlers,
  ...apiConnectorsHandlers,
  ...apiOrgHandlers,
  ...apiOrgMembersHandlers,
  ...apiUsageHandlers,
  ...apiUsageRecordHandlers,
  ...apiOrgModelProvidersHandlers,
  ...apiOrgModelPoliciesHandlers,
  ...apiPersonalModelProvidersHandlers,
  ...apiPresentationTemplatesHandlers,
  ...apiUserTemplatesHandlers,
  ...appLogsHandlers,
  ...apiIntegrationsSlackOrgHandlers,
  ...apiIntegrationsTelegramHandlers,
  ...apiIntegrationsTeamsHandlers,
  ...apiIntegrationsAgentPhoneHandlers,
  ...apiIntegrationsGithubHandlers,
  ...apiAgentsHandlers,
  ...apiWorkflowsHandlers,
  ...apiRunsHandlers,
  ...apiUserPreferencesHandlers,
  ...apiPaidToolsHandlers,
  ...apiMorningBriefPreferenceHandlers,
  ...apiEmailSubscriptionHandlers,
  ...apiUserModelPreferenceHandlers,
  ...apiOnboardingHandlers,
  ...apiBillingHandlers,
  ...apiAttributionHandlers,
  ...apiIntegrationsSlackConnectHandlers,
  ...apiFeatureSwitchesHandlers,
  ...apiGetStartedHandlers,
  ...apiRealtimeHandlers,
  ...apiUserPermissionGrantsHandlers,
  ...apiQueuePositionHandlers,
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
  resetMockEmailSubscription();
  resetMockUserModelPreference();
  resetMockOrgModelProviders();
  resetMockOrgModelPolicies();
  resetMockPersonalModelProviders();
  resetMockPresentationTemplates();
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
