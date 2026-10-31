import { createAppWithRoutes } from "../app-factory-runtime";
import { createWorkerHandler } from "../worker-runtime";
import type { RouteEntry } from "../signals/route-entry";
import { githubOauthRoutes } from "../signals/routes/github-oauth";
import { cronReconcileImageGenerationsRoutes } from "../signals/routes/cron-reconcile-image-generations";
import { webhooksBuiltInGenerationRoutes } from "../signals/routes/webhooks-built-in-generations";
import { webhooksStripeConnectRoutes } from "../signals/routes/webhooks-stripe-connect";
import { cronProcessUsageEventsRoutes } from "../signals/routes/cron-process-usage-events";
import { billingAutoRechargeRoutes } from "../signals/routes/billing-auto-recharge";
import { billingConcurrencyCheckoutRoutes } from "../signals/routes/billing-concurrency-checkout";
import { billingConcurrencySubscriptionRoutes } from "../signals/routes/billing-concurrency-subscriptions";
import { billingCreditCheckoutRoutes } from "../signals/routes/billing-credit-checkout";
import { billingDowngradeRoutes } from "../signals/routes/billing-downgrade";
import { billingInvoicesRoutes } from "../signals/routes/billing-invoices";
import { billingPortalRoutes } from "../signals/routes/billing-portal";
import { billingRedeemRoutes } from "../signals/routes/billing-redeem";
import { billingRestoreRoutes } from "../signals/routes/billing-restore";
import { billingStatusRoutes } from "../signals/routes/billing-status";
import { builtInGenerationRoutes } from "../signals/routes/built-in-generation";
import { imageIoGenerateRoutes } from "../signals/routes/image-io-generate";
import { mailRoutes } from "../signals/routes/mail";
import { onboardingRecommendationRoutes } from "../signals/routes/onboarding-recommendations";
import { onboardingSourcesRoutes } from "../signals/routes/onboarding-sources";
import { orgInviteRoutes } from "../signals/routes/org-invite";
import { userPermissionGrantsRoutes } from "../signals/routes/user-permission-grants";
import { integrationsGithubRoutes } from "../signals/routes/integrations-github";
import { slackOauthRoutes } from "../signals/routes/slack-oauth";
import { usageMembersRoutes } from "../signals/routes/usage-members";
import { usageRecordRoutes } from "../signals/routes/usage-record";
import { initializeNoServices$ } from "./initialize-no-services";

const roleRoutes: readonly RouteEntry[] = [
  ...githubOauthRoutes,
  ...cronReconcileImageGenerationsRoutes,
  ...webhooksBuiltInGenerationRoutes,
  ...webhooksStripeConnectRoutes,
  ...cronProcessUsageEventsRoutes,
  ...billingAutoRechargeRoutes,
  ...billingConcurrencyCheckoutRoutes,
  ...billingConcurrencySubscriptionRoutes,
  ...billingCreditCheckoutRoutes,
  ...billingDowngradeRoutes,
  ...billingInvoicesRoutes,
  ...billingPortalRoutes,
  ...billingRedeemRoutes,
  ...billingRestoreRoutes,
  ...billingStatusRoutes,
  ...builtInGenerationRoutes,
  ...imageIoGenerateRoutes,
  ...mailRoutes,
  ...onboardingRecommendationRoutes,
  ...onboardingSourcesRoutes,
  ...orgInviteRoutes,
  ...userPermissionGrantsRoutes,
  ...integrationsGithubRoutes,
  ...slackOauthRoutes,
  ...usageMembersRoutes,
  ...usageRecordRoutes,
];

export default createWorkerHandler((signal) => {
  return createAppWithRoutes({
    signal,
    routes: roleRoutes,
    initializeServices$: initializeNoServices$,
  });
});
