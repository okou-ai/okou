use std::time::Duration;

use aws_sdk_s3::config::{
    BehaviorVersion, Credentials, Region, ResponseChecksumValidation, SharedCredentialsProvider,
    timeout::TimeoutConfig,
};

use super::{R2Error, R2ImageCache, io_other};

/// All four R2 env vars must be set together. Missing all four -> cache disabled
/// (dev path); missing 1-3 -> fatal misconfiguration.
pub(super) const ENV_VARS: [&str; 4] = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_USER_STORAGES_BUCKET_NAME",
];

impl R2ImageCache {
    /// Returns `Ok(None)` if all four env vars are unset or empty — build proceeds without R2.
    /// Returns `Ok(Some(_))` if all four are set to non-empty values.
    /// Returns `Err(PartialConfig { .. })` if 1-3 are set — likely a typo'd
    /// secret rotation; surface loudly rather than silently disable.
    ///
    /// Empty strings count as unset: callers (Ansible, GH Actions) often
    /// substitute `""` for missing secrets, and `""` is never a valid R2
    /// credential — treating it as unset is more robust than failing later.
    pub async fn from_env() -> Result<Option<Self>, R2Error> {
        let present: Vec<String> = ENV_VARS
            .iter()
            .filter(|v| std::env::var(v).map(|s| !s.is_empty()).unwrap_or(false))
            .map(|s| s.to_string())
            .collect();

        match present.len() {
            0 => return Ok(None),
            4 => {}
            _ => {
                let missing: Vec<String> = ENV_VARS
                    .iter()
                    .filter(|v| !present.iter().any(|p| p == *v))
                    .map(|s| s.to_string())
                    .collect();
                return Err(R2Error::PartialConfig { present, missing });
            }
        }

        // safe: all four guaranteed present (and non-empty) by the match above
        let account_id = std::env::var("R2_ACCOUNT_ID").map_err(io_other)?;
        let access_key = std::env::var("R2_ACCESS_KEY_ID").map_err(io_other)?;
        let secret_key = std::env::var("R2_SECRET_ACCESS_KEY").map_err(io_other)?;
        let bucket = std::env::var("R2_USER_STORAGES_BUCKET_NAME").map_err(io_other)?;

        let endpoint = format!("https://{account_id}.r2.cloudflarestorage.com");
        let creds = Credentials::new(access_key, secret_key, None, None, "r2-env");
        // Build the S3 config directly without going through `aws_config::defaults()`
        // — that's the entry point for the credential / region / endpoint discovery
        // chain, which can hit IMDS on EC2-like hosts and waste seconds on metal.
        // We have all four values explicitly, so skip the chain entirely.
        let config = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("auto"))
            .endpoint_url(endpoint)
            .credentials_provider(SharedCredentialsProvider::new(creds))
            // Bound connection and first-response waits. Upload parts use a
            // separate response budget; downloaded bodies retain SDK stalled-stream
            // protection without a short whole-transfer deadline.
            .timeout_config(
                TimeoutConfig::builder()
                    .connect_timeout(Duration::from_secs(10))
                    .read_timeout(Duration::from_secs(60))
                    .build(),
            )
            // The SDK default enables GetObject checksum validation when supported.
            // R2/S3 multipart objects may return part-level checksums that the Rust
            // SDK cannot validate, which only produces noisy warnings. We do not
            // explicitly request checksum validation on R2 cache downloads.
            .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
            .build();
        let client = aws_sdk_s3::Client::from_conf(config);

        Ok(Some(Self { client, bucket }))
    }
}
