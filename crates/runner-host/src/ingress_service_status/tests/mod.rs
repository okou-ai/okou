use super::*;

#[tokio::test]
async fn observes_current_membership_across_exit_and_restart() {
    let directory = tempfile::tempdir().unwrap();
    let membership = directory.path().join("cgroup.procs");

    assert!(!query_active(&membership).await);
    tokio::fs::write(&membership, "123\n456\n").await.unwrap();
    assert!(query_active(&membership).await);

    tokio::fs::write(&membership, "").await.unwrap();
    assert!(!query_active(&membership).await);

    tokio::fs::write(&membership, "789\n").await.unwrap();
    assert!(query_active(&membership).await);

    tokio::fs::remove_file(&membership).await.unwrap();
    assert!(!query_active(&membership).await);
}

#[tokio::test]
async fn invalid_or_unreadable_membership_is_unavailable() {
    let directory = tempfile::tempdir().unwrap();
    let membership = directory.path().join("cgroup.procs");

    for contents in ["\n", "0\n", "not-a-pid\n", "123\ninvalid\n"] {
        tokio::fs::write(&membership, contents).await.unwrap();
        assert!(!query_active(&membership).await, "{contents:?}");
    }

    assert!(!query_active(directory.path()).await);
}
