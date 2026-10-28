//! Shared Home-versus-blank assessment; physical checkout remains authoritative.

use runner_host::paths::short_digest;
use runner_lifecycle::home_image_cache::{
    HomeCacheProbe, HomeImageCache, snapshot::HomeCacheStateSnapshot,
};
use tracing::{info, warn};

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
    match cache
        .probe_home(reuse_key, profile, image_size_bytes, None)
        .await
    {
        Ok(HomeCacheProbe::Ready { source_run_id }) => {
            info!(%source_run_id, profile, reuse_key_fingerprint = %short_digest(reuse_key),
                "requested Home is ready outside the advertised inventory");
            true
        }
        // Preserve the normal checkout's bounded contention policy. An unknown
        // owner does not acquire the longer finalizing-producer wait budget.
        Ok(HomeCacheProbe::Busy) => true,
        Ok(HomeCacheProbe::Missing | HomeCacheProbe::Incompatible) => false,
        Err(error) => {
            warn!(%error, profile, reuse_key_fingerprint = %short_digest(reuse_key),
                "requested Home lookup failed before blank selection");
            false
        }
    }
}
