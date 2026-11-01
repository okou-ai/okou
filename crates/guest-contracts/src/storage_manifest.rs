//! Runner-to-guest storage manifest wire contract.
//!
//! In the normal runner lifecycle, storage planning and cache-source resolution produce a
//! [`Manifest`]. The runner serializes it for stdin or fallback-file transport to
//! `guest-storage-apply`, which deserializes it before building its filesystem execution plan.
//!
//! ## Execution projection and canonical JSON
//!
//! Rust callers work with separate [`Manifest::storages`] and [`Manifest::artifacts`] collections.
//! The custom Serde implementations project both collections into one canonical `storageMounts`
//! JSON array and classify each incoming mount back into one of them. A mount with
//! `writeback: true` is an artifact; `writeback: false` or an absent `writeback` identifies a
//! read-only storage.
//! Serialization borrows mount fields and emits that array lazily, without a second owned mount
//! collection. Any encoded output buffer still belongs to the caller.
//!
//! During deserialization, read-only mounts cannot set `empty: true` or contain
//! `missingRootPolicy`. Duplicate `mountPath` values are rejected across the complete canonical
//! array. These checks validate incoming wire data; directly constructing and serializing a
//! [`Manifest`] does not run the same validation.
//!
//! ## Compatibility behavior
//!
//! `storageMounts` is required, so a legacy object containing only `storages` and/or `artifacts`
//! does not deserialize. Missing `cleanupPaths` and `instructionCleanups` arrays default to empty.
//! Serialization always includes `cleanupPaths` and omits `instructionCleanups` when it is empty.
//! Unknown top-level and mount fields are ignored during deserialization so future fields can be
//! added compatibly.
//!
//! `storageId` is optional in canonical `storageMounts` input. For a `writeback: true` mount,
//! omitting `storageId` defaults the value to `None` and preserves it as
//! [`ArtifactEntry::vas_storage_id`] == `None`; deserialization does not require the field. The
//! normal runner producer supplies an identifier for writeback mounts, but that producer behavior
//! is not an input requirement of this decoder.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// In-memory execution projection behind the canonical storage manifest wire contract.
///
/// Although this type separates storages from artifacts, its custom Serde implementations exchange
/// them through the canonical `storageMounts` array. The module-level contract documents the wire
/// classification, validation, and compatibility behavior.
#[derive(Debug, PartialEq, Eq)]
pub struct Manifest {
    /// Volume storage entries.
    pub storages: Vec<StorageEntry>,
    /// Artifact entries.
    pub artifacts: Vec<ArtifactEntry>,
    /// Paths to remove before materializing changed entries.
    pub cleanup_paths: Vec<String>,
    /// Instruction-specific cleanup operations.
    pub instruction_cleanups: Vec<InstructionCleanupEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestWire {
    storage_mounts: Vec<StorageMountEntry>,
    #[serde(default)]
    cleanup_paths: Vec<String>,
    #[serde(default)]
    instruction_cleanups: Vec<InstructionCleanupEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalManifest<'a> {
    storage_mounts: BorrowedStorageMounts<'a>,
    cleanup_paths: &'a [String],
    #[serde(skip_serializing_if = "instruction_cleanup_slice_is_empty")]
    instruction_cleanups: &'a [InstructionCleanupEntry],
}

struct BorrowedStorageMounts<'a> {
    storages: &'a [StorageEntry],
    artifacts: &'a [ArtifactEntry],
}

impl Serialize for BorrowedStorageMounts<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.collect_seq(
            self.storages
                .iter()
                .map(BorrowedStorageMountEntry::from_storage)
                .chain(
                    self.artifacts
                        .iter()
                        .map(BorrowedStorageMountEntry::from_artifact),
                ),
        )
    }
}

fn instruction_cleanup_slice_is_empty(value: &&[InstructionCleanupEntry]) -> bool {
    value.is_empty()
}

impl Serialize for Manifest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        CanonicalManifest {
            storage_mounts: BorrowedStorageMounts {
                storages: &self.storages,
                artifacts: &self.artifacts,
            },
            cleanup_paths: &self.cleanup_paths,
            instruction_cleanups: &self.instruction_cleanups,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Manifest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = ManifestWire::deserialize(deserializer)?;
        Self::from_storage_mounts(
            wire.storage_mounts,
            wire.cleanup_paths,
            wire.instruction_cleanups,
        )
        .map_err(serde::de::Error::custom)
    }
}

impl Manifest {
    fn from_storage_mounts(
        storage_mounts: Vec<StorageMountEntry>,
        cleanup_paths: Vec<String>,
        instruction_cleanups: Vec<InstructionCleanupEntry>,
    ) -> Result<Self, String> {
        validate_unique_mount_paths(&storage_mounts)?;

        let mut storages = Vec::new();
        let mut artifacts = Vec::new();

        for mount in storage_mounts {
            if mount.writeback {
                artifacts.push(ArtifactEntry {
                    mount_path: mount.mount_path,
                    archive_url: mount.archive_url,
                    empty: mount.empty,
                    cached: mount.cached,
                    vas_storage_name: mount.name,
                    vas_storage_id: mount.storage_id,
                    vas_version_id: mount.version_id,
                    missing_root_policy: mount.missing_root_policy,
                });
                continue;
            }

            if mount.empty {
                return Err("read-only storage mount cannot be empty".to_string());
            }
            if mount.missing_root_policy.is_some() {
                return Err("read-only storage mount cannot contain missingRootPolicy".to_string());
            }
            storages.push(StorageEntry {
                mount_path: mount.mount_path,
                archive_url: mount.archive_url,
                cached: mount.cached,
                vas_storage_name: mount.name,
                vas_version_id: mount.version_id,
            });
        }

        Ok(Self {
            storages,
            artifacts,
            cleanup_paths,
            instruction_cleanups,
        })
    }
}

fn validate_unique_mount_paths(storage_mounts: &[StorageMountEntry]) -> Result<(), String> {
    let mut mount_paths = HashSet::with_capacity(storage_mounts.len());
    for mount in storage_mounts {
        if !mount_paths.insert(mount.mount_path.as_str()) {
            return Err(format!(
                "storage manifest contains duplicate mountPath \"{}\"",
                mount.mount_path
            ));
        }
    }
    Ok(())
}

/// Volume storage entry in the guest storage manifest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageEntry {
    /// Guest filesystem path where the storage is mounted.
    pub mount_path: String,
    /// Archive URL, or `None` when existing contents are reused.
    #[serde(default)]
    pub archive_url: Option<String>,
    /// Whether existing contents match the current fingerprint.
    #[serde(default)]
    pub cached: bool,
    /// VAS storage name used for diagnostics and cache identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vas_storage_name: Option<String>,
    /// VAS version identifier used for diagnostics and cache identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vas_version_id: Option<String>,
}

/// Artifact entry in the guest storage manifest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntry {
    /// Guest filesystem path where the artifact is mounted.
    pub mount_path: String,
    /// Archive URL, including the repair source for a reused artifact.
    #[serde(default)]
    pub archive_url: Option<String>,
    /// Whether the artifact is explicitly empty.
    #[serde(default, skip_serializing_if = "is_false")]
    pub empty: bool,
    /// Whether existing contents match the current fingerprint.
    #[serde(default)]
    pub cached: bool,
    /// VAS storage name used for diagnostics and cache identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vas_storage_name: Option<String>,
    /// Optional VAS storage identifier retained from the runner payload or canonical input.
    ///
    /// A writeback mount accepted by canonical deserialization may omit `storageId`, in which case
    /// this value is `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vas_storage_id: Option<String>,
    /// VAS version identifier used for diagnostics and cache identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vas_version_id: Option<String>,
    /// Guest behavior label for a missing artifact mount root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_root_policy: Option<String>,
}

/// Canonical Storage mount exchanged between the runner and guest downloader.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageMountEntry {
    /// Storage name retained for diagnostics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Optional immutable Storage identifier.
    ///
    /// The normal runner producer supplies this for writeback mounts, but canonical deserialization
    /// accepts a writeback mount without `storageId`. In that case, the value defaults to `None` and
    /// is retained as [`ArtifactEntry::vas_storage_id`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_id: Option<String>,
    /// Resolved Storage version identifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    /// Guest filesystem path where the Storage is mounted.
    pub mount_path: String,
    /// Archive URL, or `None` when existing contents are reused or explicitly empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_url: Option<String>,
    /// Whether existing contents match the current fingerprint.
    #[serde(default)]
    pub cached: bool,
    /// Whether the resolved Storage version is explicitly empty.
    #[serde(default, skip_serializing_if = "is_false")]
    pub empty: bool,
    /// Guest behavior label for a missing writeback mount root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_root_policy: Option<String>,
    /// Whether changed contents are written back to the same Storage.
    #[serde(default)]
    pub writeback: bool,
}

// Match the owned wire type's Serde identity, field order and omission rules.
#[derive(Serialize)]
#[serde(rename = "StorageMountEntry", rename_all = "camelCase")]
struct BorrowedStorageMountEntry<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    storage_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version_id: Option<&'a str>,
    mount_path: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_url: Option<&'a str>,
    cached: bool,
    #[serde(skip_serializing_if = "is_false")]
    empty: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    missing_root_policy: Option<&'a str>,
    writeback: bool,
}

impl<'a> BorrowedStorageMountEntry<'a> {
    fn from_storage(entry: &'a StorageEntry) -> Self {
        Self {
            name: entry.vas_storage_name.as_deref(),
            storage_id: None,
            version_id: entry.vas_version_id.as_deref(),
            mount_path: &entry.mount_path,
            archive_url: entry.archive_url.as_deref(),
            cached: entry.cached,
            empty: false,
            missing_root_policy: None,
            writeback: false,
        }
    }

    fn from_artifact(entry: &'a ArtifactEntry) -> Self {
        Self {
            name: entry.vas_storage_name.as_deref(),
            storage_id: entry.vas_storage_id.as_deref(),
            version_id: entry.vas_version_id.as_deref(),
            mount_path: &entry.mount_path,
            archive_url: entry.archive_url.as_deref(),
            cached: entry.cached,
            empty: entry.empty,
            missing_root_policy: entry.missing_root_policy.as_deref(),
            writeback: true,
        }
    }
}

/// Instruction-specific cleanup operation.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionCleanupEntry {
    /// Guest filesystem path containing the instruction content.
    pub mount_path: String,
    /// Specific instruction filename, or `None` for all managed instructions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_filename: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[cfg(test)]
mod tests;
