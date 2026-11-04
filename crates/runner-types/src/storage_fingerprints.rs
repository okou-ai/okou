use std::collections::HashMap;

use crate::storage_manifest::StorageManifest;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Captured managed state carried with a reusable filesystem. `Some(empty)`
/// means known empty; `None` at the storage-plan boundary means unknown.
/// Storage and artifact partitions must remain separate.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StorageFingerprints {
    pub storages: HashMap<String, StorageFingerprint>,
    pub artifacts: HashMap<String, StorageFingerprint>,
}

/// Canonical tagged state. No tuple or NUL-sentinel decoder is accepted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageFingerprint {
    kind: StorageFingerprintKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase", deny_unknown_fields)]
enum StorageFingerprintKind {
    Known {
        #[serde(rename = "vasStorageName")]
        vas_storage_name: String,
        #[serde(rename = "vasVersionId")]
        vas_version_id: String,
    },
    Tainted {},
}

impl StorageFingerprint {
    /// Invalid input cannot establish reusable knowledge. Do not encode malformed
    /// bytes as a magic value, or let them match a current manifest.
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Self {
        let name = name.into();
        let version = version.into();
        if name.contains('\0') || version.contains('\0') {
            return Self::tainted();
        }
        Self {
            kind: StorageFingerprintKind::Known {
                vas_storage_name: name,
                vas_version_id: version,
            },
        }
    }

    pub fn tainted() -> Self {
        Self {
            kind: StorageFingerprintKind::Tainted {},
        }
    }

    pub fn is_tainted(&self) -> bool {
        matches!(self.kind, StorageFingerprintKind::Tainted {})
    }

    pub fn matches(&self, name: &str, version: &str) -> bool {
        match &self.kind {
            StorageFingerprintKind::Known {
                vas_storage_name,
                vas_version_id,
            } => vas_storage_name == name && vas_version_id == version,
            StorageFingerprintKind::Tainted {} => false,
        }
    }

    pub fn vas_version_id(&self) -> Option<&str> {
        match &self.kind {
            StorageFingerprintKind::Known { vas_version_id, .. } => Some(vas_version_id),
            StorageFingerprintKind::Tainted {} => None,
        }
    }
}

impl Serialize for StorageFingerprint {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.kind.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for StorageFingerprint {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let kind = StorageFingerprintKind::deserialize(deserializer)?;
        if let StorageFingerprintKind::Known {
            vas_storage_name,
            vas_version_id,
        } = &kind
            && (vas_storage_name.contains('\0') || vas_version_id.contains('\0'))
        {
            return Err(serde::de::Error::custom("known fingerprint contains NUL"));
        }
        Ok(Self { kind })
    }
}

impl StorageFingerprints {
    pub fn from_manifest(manifest: &StorageManifest) -> Self {
        Self {
            storages: manifest
                .storages
                .iter()
                .map(|s| {
                    (
                        s.mount_path.clone(),
                        StorageFingerprint::new(
                            s.vas_storage_name.clone(),
                            s.vas_version_id.clone(),
                        ),
                    )
                })
                .collect(),
            artifacts: manifest
                .artifacts
                .iter()
                .map(|a| {
                    (
                        a.mount_path.clone(),
                        StorageFingerprint::new(
                            a.vas_storage_name.clone(),
                            a.vas_version_id.clone(),
                        ),
                    )
                })
                .collect(),
        }
    }

    /// Failed/cancelled reconciliation may leave removed previous paths behind.
    /// Retain the union, including already-tainted paths, in both partitions.
    pub fn tainted_paths_including(&self, previous: Option<&Self>) -> Self {
        let mut result = Self {
            storages: self
                .storages
                .keys()
                .map(|p| (p.clone(), StorageFingerprint::tainted()))
                .collect(),
            artifacts: self
                .artifacts
                .keys()
                .map(|p| (p.clone(), StorageFingerprint::tainted()))
                .collect(),
        };
        if let Some(previous) = previous {
            result.storages.extend(
                previous
                    .storages
                    .keys()
                    .map(|p| (p.clone(), StorageFingerprint::tainted())),
            );
            result.artifacts.extend(
                previous
                    .artifacts
                    .keys()
                    .map(|p| (p.clone(), StorageFingerprint::tainted())),
            );
        }
        result
    }
}

#[cfg(test)]
mod tests;
