use std::collections::HashMap;

use runner_types::storage_manifest::StorageManifest;
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
    Tainted,
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
            kind: StorageFingerprintKind::Tainted,
        }
    }

    pub fn is_tainted(&self) -> bool {
        matches!(self.kind, StorageFingerprintKind::Tainted)
    }

    pub fn matches(&self, name: &str, version: &str) -> bool {
        match &self.kind {
            StorageFingerprintKind::Known {
                vas_storage_name,
                vas_version_id,
            } => vas_storage_name == name && vas_version_id == version,
            StorageFingerprintKind::Tainted => false,
        }
    }

    pub fn vas_storage_name(&self) -> Option<&str> {
        match &self.kind {
            StorageFingerprintKind::Known {
                vas_storage_name, ..
            } => Some(vas_storage_name),
            StorageFingerprintKind::Tainted => None,
        }
    }

    pub fn vas_version_id(&self) -> Option<&str> {
        match &self.kind {
            StorageFingerprintKind::Known { vas_version_id, .. } => Some(vas_version_id),
            StorageFingerprintKind::Tainted => None,
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
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tagged_known_and_tainted_round_trip_without_tuple_fallback() {
        for (fingerprint, value) in [
            (
                StorageFingerprint::new("repo", "v1"),
                json!({"state":"known","vasStorageName":"repo","vasVersionId":"v1"}),
            ),
            (StorageFingerprint::tainted(), json!({"state":"tainted"})),
        ] {
            assert_eq!(serde_json::to_value(&fingerprint).unwrap(), value);
            assert_eq!(
                serde_json::from_value::<StorageFingerprint>(value).unwrap(),
                fingerprint
            );
        }
        assert!(serde_json::from_value::<StorageFingerprint>(json!(["repo", "v1"])).is_err());
        assert!(
            serde_json::from_value::<StorageFingerprint>(
                json!({"state":"tainted","vasStorageName":"repo"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<StorageFingerprint>(
                json!({"state":"known","vasStorageName":"a\u{0000}b","vasVersionId":"v1"})
            )
            .is_err()
        );
        let invalid = StorageFingerprint::new("a\0b", "v1");
        assert!(invalid.is_tainted());
        assert!(!invalid.matches("a\0b", "v1"));
        assert_eq!(
            serde_json::to_value(invalid).unwrap(),
            json!({"state":"tainted"})
        );
    }

    #[test]
    fn known_empty_is_distinct_from_unknown_and_partitions_survive() {
        let empty = Some(StorageFingerprints::default());
        assert_ne!(
            serde_json::to_value(&empty).unwrap(),
            serde_json::to_value(None::<StorageFingerprints>).unwrap()
        );
        assert_eq!(
            serde_json::from_value::<Option<StorageFingerprints>>(
                serde_json::to_value(empty).unwrap()
            )
            .unwrap(),
            Some(StorageFingerprints::default())
        );
        let current = StorageFingerprints {
            storages: HashMap::from([(
                "/home/user/repo".into(),
                StorageFingerprint::new("repo", "v2"),
            )]),
            artifacts: HashMap::from([(
                "/home/user/output".into(),
                StorageFingerprint::new("out", "v1"),
            )]),
        };
        let previous = StorageFingerprints {
            storages: HashMap::from([("/home/user/removed".into(), StorageFingerprint::tainted())]),
            artifacts: HashMap::from([(
                "/home/user/old-output".into(),
                StorageFingerprint::new("out", "v0"),
            )]),
        };
        let union = current.tainted_paths_including(Some(&previous));
        assert_eq!(union.storages.len(), 2);
        assert_eq!(union.artifacts.len(), 2);
        assert!(
            union
                .storages
                .values()
                .chain(union.artifacts.values())
                .all(StorageFingerprint::is_tainted)
        );
        assert_eq!(
            serde_json::from_slice::<StorageFingerprints>(&serde_json::to_vec(&union).unwrap())
                .unwrap(),
            union
        );
        assert!(!current.storages["/home/user/repo"].matches("repo", "v1"));
        assert_eq!(
            current.storages["/home/user/repo"].vas_version_id(),
            Some("v2")
        );
    }
}
