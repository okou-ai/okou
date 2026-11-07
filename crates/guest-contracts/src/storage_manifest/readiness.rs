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
/// The Guest bounds publication waiting to 60 seconds; an enclosing operation's
/// process deadline may expire sooner. A failed application must never launch
/// an Agent or make partially applied storage eligible for reuse.
/// Omit this descriptor for the ordinary all-prepared path. Runner and Guest
/// binaries share one artifact; this is not an independently activated API.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ArchiveReadiness {
    /// Fresh namespace for this application, including separate batches of a Run.
    pub id: Uuid,
    /// Ordered unique local archive URLs already referenced by the manifest.
    pub sources: Vec<String>,
}

impl ArchiveReadiness {
    /// Validate the descriptor without accessing or changing the filesystem.
    pub fn validate(&self, manifest: &Manifest) -> Result<(), &'static str> {
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
