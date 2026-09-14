import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

/**
 * Okou owns rollout associations. Deploy an association before publishing a
 * method that should be gated, and remove it when its switch graduates.
 */
const FEATURE_SWITCH_BY_AUTH_METHOD = Object.freeze<
  Record<string, FeatureSwitchKey | undefined>
>({
  "ahrefs\0oauth": FeatureSwitchKey.AhrefsConnector,
  "bentoml\0api-token": FeatureSwitchKey.BentomlConnector,
  "bill\0api-token": FeatureSwitchKey.BillConnector,
  "cal-com\0api-token": FeatureSwitchKey.CalComConnector,
  "cal-com\0oauth": FeatureSwitchKey.CalComConnector,
  "calendly\0oauth": FeatureSwitchKey.CalendlyOAuthConnector,
  "canva\0oauth": FeatureSwitchKey.CanvaConnector,
  "close\0oauth": FeatureSwitchKey.CloseConnector,
  "copper\0oauth": FeatureSwitchKey.CopperConnector,
  "datadog\0oauth": FeatureSwitchKey.DatadogConnector,
  "deel\0oauth": FeatureSwitchKey.DeelConnector,
  "docusign\0oauth": FeatureSwitchKey.DocuSignConnector,
  "expensify\0api-token": FeatureSwitchKey.ExpensifyConnector,
  "figma\0oauth": FeatureSwitchKey.FigmaConnector,
  "garmin-connect\0oauth": FeatureSwitchKey.GarminConnectConnector,
  "mailchimp\0oauth": FeatureSwitchKey.MailchimpConnector,
  "mercury\0oauth": FeatureSwitchKey.MercuryConnector,
  "neon\0oauth": FeatureSwitchKey.NeonConnector,
  "netsuite\0api-token": FeatureSwitchKey.NetSuiteConnector,
  "paypal\0api-token": FeatureSwitchKey.PayPalConnector,
  "ramp\0oauth": FeatureSwitchKey.RampConnector,
  "reddit\0oauth": FeatureSwitchKey.RedditConnector,
  "spotify\0oauth": FeatureSwitchKey.SpotifyConnector,
  "stripe\0oauth": FeatureSwitchKey.StripeMarketplaceOAuthConnector,
  "supabase\0oauth": FeatureSwitchKey.SupabaseConnector,
  "test-oauth\0api": FeatureSwitchKey.TestOauthConnector,
  "test-oauth\0api-token": FeatureSwitchKey.TestOauthConnector,
  "test-oauth\0oauth": FeatureSwitchKey.TestOauthConnector,
  "test-oauth-device\0api": FeatureSwitchKey.TestOauthConnector,
  "test-oauth-device\0oauth": FeatureSwitchKey.TestOauthConnector,
  "webflow\0oauth": FeatureSwitchKey.WebflowConnector,
  "workday\0api-token": FeatureSwitchKey.WorkdayConnector,
  "zapier\0api-token": FeatureSwitchKey.ZapierConnector,
  "zoom\0oauth": FeatureSwitchKey.ZoomConnector,
});

export function connectorAuthMethodFeatureSwitch(
  connectorSlug: ConnectorSlug,
  authMethodId: ConnectorAuthMethodId,
): FeatureSwitchKey | undefined {
  return FEATURE_SWITCH_BY_AUTH_METHOD[`${connectorSlug}\0${authMethodId}`];
}
