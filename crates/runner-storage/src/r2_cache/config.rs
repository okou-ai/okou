use std::sync::Arc;

use super::{R2Error, R2ImageCache, http_transport::R2HttpClient, io_other};

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

        // Only this explicit R2 endpoint and these explicit credentials are
        // used; never fall back to instance-metadata credential discovery.
        let client = Arc::new(R2HttpClient::new(
            &account_id,
            bucket.clone(),
            access_key,
            secret_key,
        )?);
        Ok(Some(Self { client, bucket }))
    }
}
