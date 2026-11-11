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
  "docusign\0oauth": FeatureSwitchKey.DocuSignConnector,
  "paypal\0api-token": FeatureSwitchKey.PayPalConnector,
  "ramp\0oauth": FeatureSwitchKey.RampConnector,
  "spotify\0oauth": FeatureSwitchKey.SpotifyConnector,
  "test-oauth\0api": FeatureSwitchKey.TestOauthConnector,
  "test-oauth\0api-token": FeatureSwitchKey.TestOauthConnector,
  "test-oauth\0oauth": FeatureSwitchKey.TestOauthConnector,
  "test-oauth-device\0api": FeatureSwitchKey.TestOauthConnector,
  "test-oauth-device\0oauth": FeatureSwitchKey.TestOauthConnector,
  "tiktok\0oauth": FeatureSwitchKey.TikTokOAuthConnector,
  "zoom\0oauth": FeatureSwitchKey.ZoomConnector,
});

export function connectorAuthMethodFeatureSwitch(
  connectorSlug: ConnectorSlug,
  authMethodId: ConnectorAuthMethodId,
): FeatureSwitchKey | undefined {
  return FEATURE_SWITCH_BY_AUTH_METHOD[`${connectorSlug}\0${authMethodId}`];
}
