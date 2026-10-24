// Keep each domain statically scoped; never import the complete ROUTES registry.
import type { RouteEntry } from "../signals/route-entry";
import { getStartedRoutes } from "../signals/routes/get-started";
import { healthRoutes } from "../signals/routes/health";
import { buildInfoRoutes } from "../signals/routes/build-info";
import { authMeRoutes } from "../signals/routes/auth-me";
import { cliAuthRoutes } from "../signals/routes/cli-auth";
import { desktopUpdateRoutes } from "../signals/routes/desktop-updates";
import { userExportRoutes } from "../signals/routes/user-export";
import { webhooksClerkRoutes } from "../signals/routes/webhooks-clerk";
import { webhooksStripeRoutes } from "../signals/routes/webhooks-stripe";
import { webhooksStripeConnectRoutes } from "../signals/routes/webhooks-stripe-connect";
import { walletRoutes } from "../signals/routes/wallet";
import { linkApprovalWorkflowRoutes } from "../signals/routes/link-approval-workflow";
import { cronReconcileArtifactCatalogRoutes } from "../signals/routes/cron-reconcile-artifact-catalog";
import { cronCompactUsageEventsRoutes } from "../signals/routes/cron-compact-usage-events";
import { cronDrainEmailOutboxRoutes } from "../signals/routes/cron-drain-email-outbox";
import { cronProcessUsageEventsRoutes } from "../signals/routes/cron-process-usage-events";
import { cronReconcileBillingEntitlementsRoutes } from "../signals/routes/cron-reconcile-billing-entitlements";
import { cronPruneStoragePresignedUrlsRoutes } from "../signals/routes/cron-prune-storage-presigned-urls";
import { emailUnsubscribeRoutes } from "../signals/routes/email-unsubscribe";
import { artifactCatalogRoutes } from "../signals/routes/artifact-catalog";
import { billingAutoRechargeRoutes } from "../signals/routes/billing-auto-recharge";
import { billingCheckoutRoutes } from "../signals/routes/billing-checkout";
import { billingConcurrencyCheckoutRoutes } from "../signals/routes/billing-concurrency-checkout";
import { billingConcurrencySubscriptionRoutes } from "../signals/routes/billing-concurrency-subscriptions";
import { billingCreditCheckoutRoutes } from "../signals/routes/billing-credit-checkout";
import { billingDowngradeRoutes } from "../signals/routes/billing-downgrade";
import { billingInvoicesRoutes } from "../signals/routes/billing-invoices";
import { billingPortalRoutes } from "../signals/routes/billing-portal";
import { billingRedeemCodeRoutes } from "../signals/routes/billing-redeem-code";
import { billingRedeemRoutes } from "../signals/routes/billing-redeem";
import { billingRestoreRoutes } from "../signals/routes/billing-restore";
import { billingStatusRoutes } from "../signals/routes/billing-status";
import { billingUsagePackCreditsRoutes } from "../signals/routes/billing-usage-pack-credits";
import { bankingRoutes } from "../signals/routes/banking";
import { featureSwitchesRoutes } from "../signals/routes/feature-switches";
import { hostRoutes } from "../signals/routes/host";
import { artifactShareRoutes } from "../signals/routes/artifact-shares";
import { artifactReferenceRoutes } from "../signals/routes/artifact-references";
import { artifactOgRoutes } from "../signals/routes/artifact-og";
import { artifactDownloadRoutes } from "../signals/routes/artifact-downloads";
import { modelCatalogRoutes } from "../signals/routes/model-catalog";
import { voiceIoQuotaRoutes } from "../signals/routes/voice-io-quota";
import { voiceIoPolishRoutes } from "../signals/routes/voice-io-polish";
import { voiceIoTranscribeRoutes } from "../signals/routes/voice-io-transcribe";
import { webFileUrlRoutes } from "../signals/routes/web-file-url";
import { realtimeTokenRoutes } from "../signals/routes/realtime-token";
import { onboardingCompleteRoutes } from "../signals/routes/onboarding-complete";
import { onboardingStatusRoutes } from "../signals/routes/onboarding-status";
import { onboardingSourcesRoutes } from "../signals/routes/onboarding-sources";
import { orgInviteRoutes } from "../signals/routes/org-invite";
import { orgDeleteRoutes } from "../signals/routes/org-delete";
import { orgLogoRoutes } from "../signals/routes/org-logo";
import { orgMembersRoutes } from "../signals/routes/org-members";
import { orgMembershipRequestsRoutes } from "../signals/routes/org-membership-requests";
import { orgReadRoutes } from "../signals/routes/org-read";
import { orgOpenrouterPresetRoutes } from "../signals/routes/org-openrouter-preset";
import { pushSubscriptionsRoutes } from "../signals/routes/push-subscriptions";
import { userPermissionGrantsRoutes } from "../signals/routes/user-permission-grants";
import { userPreferencesRoutes } from "../signals/routes/user-preferences";
import { paidToolsRoutes } from "../signals/routes/paid-tools";
import { userModelPreferenceRoutes } from "../signals/routes/user-model-preference";
import { morningBriefPreferenceRoutes } from "../signals/routes/morning-brief-preference";
import {
  proactiveSuggestionsRoutes,
  proactiveJobsRoutes,
} from "../signals/routes/proactive-preferences";
import { emailSubscriptionRoutes } from "../signals/routes/email-subscription";
import { notificationsRoutes } from "../signals/routes/notifications";
import { uploadsCompleteRoutes } from "../signals/routes/uploads-complete";
import { uploadsMultipartRoutes } from "../signals/routes/uploads-multipart";
import { uploadsPrepareRoutes } from "../signals/routes/uploads-prepare";
import { presentationTemplatesRoutes } from "../signals/routes/presentation-templates";
import { userTemplatesRoutes } from "../signals/routes/user-templates";
import { registryResourceDownloadRoutes } from "../signals/routes/registry-resources-download";
import { usageMembersRoutes } from "../signals/routes/usage-members";
import { usageRecordRoutes } from "../signals/routes/usage-record";

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
