//! Optional source publication within one embedded Runner/Guest artifact.

use super::Manifest;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

/// Sources that may arrive after the complete storage application starts.
///
/// The publisher must use a fresh operation ID, finish each source write before
/// creating its empty regular ready marker, and never modify a published source.
/// An empty regular failed marker aborts the operation. Markers belong to the
/// captured Run runtime and its existing reclamation owner, not a retained cache.
/// The default publication wait is 60 seconds. The embedded Host can bind it to
/// its existing operation budget (at most 300 seconds); this never extends the
/// enclosing process deadline or renews a producer's retry budget. A failed
/// application must never launch an Agent or make partially applied storage
/// eligible for reuse.
/// Omit this descriptor for the ordinary all-prepared path. Runner and Guest
/// binaries share one artifact; this is not an independently activated API.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ArchiveReadiness {
    /// Fresh namespace for this application, including separate batches of a Run.
    pub id: Uuid,
    /// Ordered unique local archive URLs already referenced by the manifest.
    pub sources: Vec<String>,
    /// Existing accepted-operation budget, without extending its process deadline.
    #[serde(
        default,
        rename = "waitTimeoutMs",
        skip_serializing_if = "Option::is_none"
    )]
    pub wait_timeout_ms: Option<u32>,
    /// Query current runtime-path eligibility without preparing or applying inputs.
    #[serde(default, rename = "checkOnly", skip_serializing_if = "is_false")]
    pub check_only: bool,
}

fn is_false(value: &bool) -> bool {
    !value
}

impl ArchiveReadiness {
    /// Maximum existing storage-operation budget accepted from the embedded Host.
    pub const MAX_WAIT_TIMEOUT_MS: u32 = 300_000;

    /// Publication waiting remains bounded independently of process containment.
    #[must_use]
    pub fn wait_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_millis(u64::from(self.wait_timeout_ms.unwrap_or(60_000)))
    }

    /// Validate the descriptor without accessing or changing the filesystem.
    pub fn validate(&self, manifest: &Manifest) -> Result<(), &'static str> {
        if self
            .wait_timeout_ms
            .is_some_and(|timeout| timeout == 0 || timeout > Self::MAX_WAIT_TIMEOUT_MS)
        {
            return Err("invalid archive publication budget");
        }
        let available = manifest
            .storages
            .iter()
            .filter_map(|entry| entry.archive_url.as_deref())
            .chain(
                manifest
                    .artifacts
                    .iter()
                    .filter(|entry| !entry.empty)
                    .filter_map(|entry| entry.archive_url.as_deref()),
            )
            .collect::<HashSet<_>>();
        if self.sources.is_empty() || self.sources.len() > available.len() {
            return Err("invalid pending archive count");
        }
        let mut seen = HashSet::with_capacity(self.sources.len());
        for url in &self.sources {
            let path = url.strip_prefix("file://").map(Path::new).filter(|path| {
                path.is_absolute()
                    && !url.contains('\0')
                    && !path.components().any(|part| part == Component::ParentDir)
            });
            if path.is_none() || !available.contains(url.as_str()) || !seen.insert(url) {
                return Err("invalid pending local archive binding");
            }
        }
        Ok(())
    }

    /// Private operation directory below an already captured Run runtime.
    #[must_use]
    pub fn directory(&self, runtime: &Path) -> PathBuf {
        runtime.join("archive-readiness").join(self.id.to_string())
    }

    /// Publish only after the source at this index is completely readable.
    #[must_use]
    pub fn ready_path(&self, runtime: &Path, index: usize) -> PathBuf {
        self.directory(runtime).join(format!("{index}.ready"))
    }

    /// Explicit producer failure for this operation only.
    #[must_use]
    pub fn failed_path(&self, runtime: &Path) -> PathBuf {
        self.directory(runtime).join("failed")
    }
}
