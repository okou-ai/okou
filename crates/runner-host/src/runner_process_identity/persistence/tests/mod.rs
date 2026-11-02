use super::*;

#[tokio::test]
async fn runner_id_generate_and_persist() {
    let dir = tempfile::tempdir().unwrap();
    let id1 = load_or_generate_runner_id(dir.path()).await.unwrap();

    // Second call reads the same ID
    let id2 = load_or_generate_runner_id(dir.path()).await.unwrap();
    assert_eq!(id1, id2);
}

#[tokio::test]
async fn runner_id_reads_existing() {
    let dir = tempfile::tempdir().unwrap();
    let expected = Uuid::new_v4();
    tokio::fs::write(dir.path().join("runner_id"), expected.to_string())
        .await
        .unwrap();
    let id = load_or_generate_runner_id(dir.path()).await.unwrap();
    assert_eq!(id, expected);
}

#[cfg(unix)]
#[tokio::test]
async fn runner_id_rejects_symlink_without_reading_target() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("outside-runner-id");
    let link = dir.path().join("runner_id");
    let outside_id = Uuid::new_v4().to_string();
    tokio::fs::write(&target, &outside_id).await.unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();

    let result = load_or_generate_runner_id(dir.path()).await;

    assert!(result.is_err());
    assert_eq!(
        tokio::fs::read_to_string(&target).await.unwrap(),
        outside_id
    );
}

#[tokio::test]
async fn runner_id_rejects_invalid() {
    let dir = tempfile::tempdir().unwrap();
    tokio::fs::write(dir.path().join("runner_id"), "not-a-uuid")
        .await
        .unwrap();
    let result = load_or_generate_runner_id(dir.path()).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn runner_id_trims_whitespace() {
    let dir = tempfile::tempdir().unwrap();
    let expected = Uuid::new_v4();
    // Write with trailing newline (common with echo/editors)
    tokio::fs::write(dir.path().join("runner_id"), format!("  {expected}\n"))
        .await
        .unwrap();
    let id = load_or_generate_runner_id(dir.path()).await.unwrap();
    assert_eq!(id, expected);
}

#[tokio::test]
async fn runner_id_rejects_empty_file() {
    let dir = tempfile::tempdir().unwrap();
    tokio::fs::write(dir.path().join("runner_id"), "")
        .await
        .unwrap();
    let result = load_or_generate_runner_id(dir.path()).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn heartbeat_generation_increments_across_starts() {
    let dir = tempfile::tempdir().unwrap();

    assert_eq!(
        load_runner_process_identity(dir.path())
            .await
            .unwrap()
            .heartbeat_generation(),
        1
    );
    assert_eq!(
        load_runner_process_identity(dir.path())
            .await
            .unwrap()
            .heartbeat_generation(),
        2
    );
    assert_eq!(
        tokio::fs::read_to_string(dir.path().join("heartbeat_generation"))
            .await
            .unwrap(),
        "2"
    );
}

#[tokio::test]
async fn heartbeat_generation_rejects_invalid_or_exhausted_state() {
    for value in [
        "not-a-number",
        "-1",
        "9007199254740991",
        "9007199254740992",
        "18446744073709551615",
    ] {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("heartbeat_generation"), value)
            .await
            .unwrap();

        let result = load_runner_process_identity(dir.path()).await;

        assert!(result.is_err(), "generation state {value:?} must fail");
    }
}

#[tokio::test]
async fn invalid_generation_keeps_earlier_runner_id_write() {
    let dir = tempfile::tempdir().unwrap();
    tokio::fs::write(dir.path().join("heartbeat_generation"), "not-a-number")
        .await
        .unwrap();

    let error = load_runner_process_identity(dir.path()).await.unwrap_err();

    assert!(
        matches!(error, HostError::Config(message) if message.contains("invalid heartbeat generation"))
    );
    Uuid::parse_str(
        &tokio::fs::read_to_string(dir.path().join("runner_id"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        tokio::fs::read_to_string(dir.path().join("heartbeat_generation"))
            .await
            .unwrap(),
        "not-a-number"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn heartbeat_generation_rejects_symlink_without_replacing_target() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("outside-heartbeat-generation");
    let link = dir.path().join("heartbeat_generation");
    tokio::fs::write(&target, "41").await.unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();

    let result = load_runner_process_identity(dir.path()).await;

    assert!(result.is_err());
    assert_eq!(tokio::fs::read_to_string(&target).await.unwrap(), "41");
}
