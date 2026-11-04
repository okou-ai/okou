use super::*;

#[test]
fn resolve_snapshot_rejects_invalid_socket_id() {
    let tmp = tempfile::tempdir().unwrap();
    let snapshot_ref = SnapshotRef {
        output_dir: tmp.path().join("snapshot"),
        hash: "../snapshot".into(),
    };

    let err = FirecrackerRuntime::resolve_snapshot(&snapshot_ref).unwrap_err();

    match err {
        SandboxError::Configuration { message } => {
            assert!(message.contains("snapshot socket id"), "got: {message}");
            assert!(
                message.contains("runtime socket id must be"),
                "got: {message}"
            );
        }
        other => panic!("expected configuration error, got {other:?}"),
    }
}

#[test]
fn resolve_snapshot_uses_checked_runtime_socket_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let hash = "a".repeat(64);
    let snapshot_ref = SnapshotRef {
        output_dir: tmp.path().join("snapshot"),
        hash: hash.clone(),
    };

    let snapshot = FirecrackerRuntime::resolve_snapshot(&snapshot_ref).unwrap();

    assert_eq!(
        snapshot.vsock_bind_dir,
        RuntimePaths::new().sock_dir(&hash).join("vsock")
    );
}
