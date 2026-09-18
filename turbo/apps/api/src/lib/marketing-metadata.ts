// Attribution and provider delivery state belong to Marketing. Do not copy
// historical marketing metadata into a new billing object or schedule phase.
const ATTRIBUTION_METADATA_KEYS = Object.freeze([
  "signup_attribution",
  "google_data_manager_acquisition_conversions",
  "source_type",
  "referrer_domain",
  "landing_host",
  "landing_path",
  "vm0_source",
  "okou_source",
  "okou_campaign_id",
  "okou_ad_group_id",
  "vm0_campaign_id",
  "vm0_ad_group_id",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "vm0_experiment",
  "vm0_variant",
  "lp_variant",
  "gclid",
  "gbraid",
  "wbraid",
  "gclid_present",
  "gbraid_present",
  "wbraid_present",
  "ga_client_id",
  "ga_session_id",
]);

export function retireMarketingMetadata<T>(
  metadata: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => {
      return (
        !key.startsWith("impact_") &&
        !key.startsWith("gdm_") &&
        !key.startsWith("marketing_privacy_") &&
        !ATTRIBUTION_METADATA_KEYS.includes(key)
      );
    }),
  );
}
