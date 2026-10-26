// Keep each domain statically scoped; never import the complete ROUTES registry.
import type { RouteEntry } from "../route-entry";
import { getStartedRoutes } from "../routes/get-started";
import { healthRoutes } from "../routes/health";
import { buildInfoRoutes } from "../routes/build-info";
import { authMeRoutes } from "../routes/auth-me";
import { cliAuthRoutes } from "../routes/cli-auth";
import { desktopUpdateRoutes } from "../routes/desktop-updates";
import { userExportRoutes } from "../routes/user-export";
import { webhooksClerkRoutes } from "../routes/webhooks-clerk";
import { webhooksStripeRoutes } from "../routes/webhooks-stripe";
import { webhooksStripeConnectRoutes } from "../routes/webhooks-stripe-connect";
import { walletRoutes } from "../routes/wallet";
import { linkApprovalWorkflowRoutes } from "../routes/link-approval-workflow";
import { cronReconcileArtifactCatalogRoutes } from "../routes/cron-reconcile-artifact-catalog";
import { cronCompactUsageEventsRoutes } from "../routes/cron-compact-usage-events";
import { cronDrainEmailOutboxRoutes } from "../routes/cron-drain-email-outbox";
import { cronProcessUsageEventsRoutes } from "../routes/cron-process-usage-events";
import { cronReconcileBillingEntitlementsRoutes } from "../routes/cron-reconcile-billing-entitlements";
import { cronPruneStoragePresignedUrlsRoutes } from "../routes/cron-prune-storage-presigned-urls";
import { emailUnsubscribeRoutes } from "../routes/email-unsubscribe";
import { artifactCatalogRoutes } from "../routes/artifact-catalog";
import { billingAutoRechargeRoutes } from "../routes/billing-auto-recharge";
import { billingCheckoutRoutes } from "../routes/billing-checkout";
import { billingConcurrencyCheckoutRoutes } from "../routes/billing-concurrency-checkout";
import { billingConcurrencySubscriptionRoutes } from "../routes/billing-concurrency-subscriptions";
import { billingCreditCheckoutRoutes } from "../routes/billing-credit-checkout";
import { billingDowngradeRoutes } from "../routes/billing-downgrade";
import { billingInvoicesRoutes } from "../routes/billing-invoices";
import { billingPortalRoutes } from "../routes/billing-portal";
import { billingRedeemCodeRoutes } from "../routes/billing-redeem-code";
import { billingRedeemRoutes } from "../routes/billing-redeem";
import { billingRestoreRoutes } from "../routes/billing-restore";
import { billingStatusRoutes } from "../routes/billing-status";
import { billingUsagePackCreditsRoutes } from "../routes/billing-usage-pack-credits";
import { bankingRoutes } from "../routes/banking";
import { featureSwitchesRoutes } from "../routes/feature-switches";
import { hostRoutes } from "../routes/host";
import { artifactShareRoutes } from "../routes/artifact-shares";
import { artifactReferenceRoutes } from "../routes/artifact-references";
import { artifactOgRoutes } from "../routes/artifact-og";
import { artifactDownloadRoutes } from "../routes/artifact-downloads";
import { modelCatalogRoutes } from "../routes/model-catalog";
import { voiceIoQuotaRoutes } from "../routes/voice-io-quota";
import { voiceIoPolishRoutes } from "../routes/voice-io-polish";
import { voiceIoTranscribeRoutes } from "../routes/voice-io-transcribe";
import { webFileUrlRoutes } from "../routes/web-file-url";
import { realtimeTokenRoutes } from "../routes/realtime-token";
import { onboardingCompleteRoutes } from "../routes/onboarding-complete";
import { onboardingStatusRoutes } from "../routes/onboarding-status";
import { onboardingSourcesRoutes } from "../routes/onboarding-sources";
import { orgInviteRoutes } from "../routes/org-invite";
import { orgDeleteRoutes } from "../routes/org-delete";
import { orgLogoRoutes } from "../routes/org-logo";
import { orgMembersRoutes } from "../routes/org-members";
import { orgMembershipRequestsRoutes } from "../routes/org-membership-requests";
import { orgReadRoutes } from "../routes/org-read";
import { orgOpenrouterPresetRoutes } from "../routes/org-openrouter-preset";
import { pushSubscriptionsRoutes } from "../routes/push-subscriptions";
import { iosPushRegistrationsRoutes } from "../routes/ios-push-registrations";
import { userPermissionGrantsRoutes } from "../routes/user-permission-grants";
import { userPreferencesRoutes } from "../routes/user-preferences";
import { paidToolsRoutes } from "../routes/paid-tools";
import { userModelPreferenceRoutes } from "../routes/user-model-preference";
import { morningBriefPreferenceRoutes } from "../routes/morning-brief-preference";
import {
  proactiveSuggestionsRoutes,
  proactiveJobsRoutes,
} from "../routes/proactive-preferences";

import { emailSubscriptionRoutes } from "../routes/email-subscription";
import { notificationsRoutes } from "../routes/notifications";
import { uploadsCompleteRoutes } from "../routes/uploads-complete";
import { uploadsMultipartRoutes } from "../routes/uploads-multipart";
import { uploadsPrepareRoutes } from "../routes/uploads-prepare";
import { presentationTemplatesRoutes } from "../routes/presentation-templates";
import { userTemplatesRoutes } from "../routes/user-templates";
import { registryResourceDownloadRoutes } from "../routes/registry-resources-download";
import { usageMembersRoutes } from "../routes/usage-members";
import { usageRecordRoutes } from "../routes/usage-record";

export const CORE_ROUTES: readonly RouteEntry[] = [
  ...getStartedRoutes,
  ...healthRoutes,
  ...buildInfoRoutes,
  ...authMeRoutes,
  ...cliAuthRoutes,
  ...desktopUpdateRoutes,
  ...userExportRoutes,
  ...webhooksClerkRoutes,
  ...webhooksStripeRoutes,
  ...webhooksStripeConnectRoutes,
  ...walletRoutes,
  ...linkApprovalWorkflowRoutes,
  ...cronReconcileArtifactCatalogRoutes,
  ...cronCompactUsageEventsRoutes,
  ...cronDrainEmailOutboxRoutes,
  ...cronProcessUsageEventsRoutes,
  ...cronReconcileBillingEntitlementsRoutes,
  ...cronPruneStoragePresignedUrlsRoutes,
  ...emailUnsubscribeRoutes,
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
  ...featureSwitchesRoutes,
  ...hostRoutes,
  ...artifactShareRoutes,
  ...artifactReferenceRoutes,
  ...artifactOgRoutes,
  ...artifactDownloadRoutes,
  ...modelCatalogRoutes,
  ...voiceIoQuotaRoutes,
  ...voiceIoPolishRoutes,
  ...voiceIoTranscribeRoutes,
  ...webFileUrlRoutes,
  ...realtimeTokenRoutes,
  ...onboardingCompleteRoutes,
  ...onboardingStatusRoutes,
  ...onboardingSourcesRoutes,
  ...orgInviteRoutes,
  ...orgDeleteRoutes,
  ...orgLogoRoutes,
  ...orgMembersRoutes,
  ...orgMembershipRequestsRoutes,
  ...orgReadRoutes,
  ...orgOpenrouterPresetRoutes,
  ...pushSubscriptionsRoutes,
  ...iosPushRegistrationsRoutes,
  ...userPermissionGrantsRoutes,
  ...userPreferencesRoutes,
  ...paidToolsRoutes,
  ...userModelPreferenceRoutes,
  ...morningBriefPreferenceRoutes,
  ...proactiveSuggestionsRoutes,
  ...proactiveJobsRoutes,
  ...emailSubscriptionRoutes,
  ...notificationsRoutes,
  ...uploadsCompleteRoutes,
  ...uploadsMultipartRoutes,
  ...uploadsPrepareRoutes,
  ...presentationTemplatesRoutes,
  ...userTemplatesRoutes,
  ...registryResourceDownloadRoutes,
  ...usageMembersRoutes,
  ...usageRecordRoutes,
];
