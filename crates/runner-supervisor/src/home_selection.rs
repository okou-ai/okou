//! Shared Home-versus-blank assessment; physical checkout remains authoritative.

use runner_host::paths::short_digest;
use runner_lifecycle::home_image_cache::{
    HomeCacheProbe, HomeImageCache, snapshot::HomeCacheStateSnapshot,
};
use runner_types::ids::RunId;
use tracing::{info, warn};

pub(crate) async fn probe_home(
    cache: Option<&HomeImageCache>,
    reuse_key: &str,
    profile: &str,
    image_size_bytes: u64,
    required_source: Option<RunId>,
) -> Option<HomeCacheProbe> {
    match cache?
        .probe_home(reuse_key, profile, image_size_bytes, required_source)
        .await
    {
        Ok(observed) => Some(observed),
        Err(error) => {
            warn!(%error, profile, ?required_source, reuse_key_fingerprint = %short_digest(reuse_key),
                "requested Home lookup failed during selection");
            None
        }
    }
}

pub(crate) async fn prefer_home(
    cache: Option<&HomeImageCache>,
    snapshot: &HomeCacheStateSnapshot,
    reuse_key: Option<&str>,
    profile: &str,
    image_size_bytes: u64,
) -> bool {
    let (Some(cache), Some(reuse_key)) = (cache, reuse_key) else {
        return false;
    };
    if snapshot.might_contain_compatible_home(reuse_key, profile) {
        return true;
    }
    match probe_home(Some(cache), reuse_key, profile, image_size_bytes, None).await {
        Some(HomeCacheProbe::Ready { source_run_id }) => {
            info!(%source_run_id, profile, reuse_key_fingerprint = %short_digest(reuse_key),
                "requested Home is ready outside the advertised inventory");
            true
        }
        // Preserve the normal checkout's bounded contention policy. An unknown
        // owner does not acquire the longer finalizing-producer wait budget.
        Some(HomeCacheProbe::Busy) => true,
        Some(HomeCacheProbe::Missing | HomeCacheProbe::Incompatible) | None => false,
    }
}
