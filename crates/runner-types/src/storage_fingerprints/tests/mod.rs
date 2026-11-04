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
        serde_json::from_value::<Option<StorageFingerprints>>(serde_json::to_value(empty).unwrap())
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
