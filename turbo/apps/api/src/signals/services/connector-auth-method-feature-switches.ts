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
  "canva\0oauth": FeatureSwitchKey.CanvaConnector,
  "deel\0oauth": FeatureSwitchKey.DeelConnector,
  "docusign\0oauth": FeatureSwitchKey.DocuSignConnector,
  "garmin-connect\0oauth": FeatureSwitchKey.GarminConnectConnector,
  "neon\0oauth": FeatureSwitchKey.NeonConnector,
  "netsuite\0api-token": FeatureSwitchKey.NetSuiteConnector,
  "paypal\0api-token": FeatureSwitchKey.PayPalConnector,
  "ramp\0oauth": FeatureSwitchKey.RampConnector,
  "reddit\0oauth": FeatureSwitchKey.RedditConnector,
  "spotify\0oauth": FeatureSwitchKey.SpotifyConnector,
  "supabase\0oauth": FeatureSwitchKey.SupabaseConnector,
  "test-oauth\0api": FeatureSwitchKey.TestOauthConnector,
  "test-oauth\0api-token": FeatureSwitchKey.TestOauthConnector,
  "test-oauth\0oauth": FeatureSwitchKey.TestOauthConnector,
  "test-oauth-device\0api": FeatureSwitchKey.TestOauthConnector,
  "test-oauth-device\0oauth": FeatureSwitchKey.TestOauthConnector,
  "tiktok\0oauth": FeatureSwitchKey.TikTokOAuthConnector,
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
