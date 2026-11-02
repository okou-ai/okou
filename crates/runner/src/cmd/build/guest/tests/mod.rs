use super::*;

#[tokio::test]
async fn resolve_guest_snapshots_cli_binary_into_temp_dir() {
    let temp_dir = tempfile::tempdir().unwrap();
    let source = temp_dir.path().join("source-guest");
    tokio::fs::write(&source, b"v1").await.unwrap();

    let tmp_dir = tempfile::tempdir().unwrap();
    let resolved = resolve_guest(Some(source.clone()), "guest-agent", tmp_dir.path())
        .await
        .unwrap();

    tokio::fs::write(&source, b"v2").await.unwrap();
    assert_eq!(tokio::fs::read(&resolved).await.unwrap(), b"v1");
    assert!(resolved.starts_with(tmp_dir.path()));
    assert_ne!(resolved, source);
}
