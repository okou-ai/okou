use super::*;

#[tokio::test]
async fn publication_replaces_stale_staging_with_complete_archive() {
    let temp = tempfile::tempdir().unwrap();
    let cache_dir = temp.path().join("storages/name/version");
    let staging = staging_dir(&cache_dir);
    fs::create_dir_all(&staging).await.unwrap();
    fs::write(staging.join("stale"), b"interrupted attempt")
        .await
        .unwrap();

    write_to_cache(&cache_dir, b"complete archive")
        .await
        .unwrap();

    assert_eq!(
        fs::read(cache_dir.join("archive.tar.gz")).await.unwrap(),
        b"complete archive"
    );
    assert!(!cache_dir.join("stale").exists());
    assert!(!staging.exists());
}

#[tokio::test]
async fn publication_collision_preserves_existing_archive_and_retires_staging() {
    let temp = tempfile::tempdir().unwrap();
    let cache_dir = temp.path().join("storages/name/version");
    fs::create_dir_all(&cache_dir).await.unwrap();
    let archive = cache_dir.join("archive.tar.gz");
    fs::write(&archive, b"winning archive").await.unwrap();

    write_to_cache(&cache_dir, b"superseded archive")
        .await
        .unwrap();

    assert_eq!(fs::read(&archive).await.unwrap(), b"winning archive");
    assert!(!staging_dir(&cache_dir).exists());
}

#[tokio::test]
async fn publication_rejects_incomplete_destination_and_retires_staging() {
    let temp = tempfile::tempdir().unwrap();
    let cache_dir = temp.path().join("storages/name/version");
    fs::create_dir_all(&cache_dir).await.unwrap();
    let retained = cache_dir.join("unrelated");
    fs::write(&retained, b"existing contents").await.unwrap();

    let error = write_to_cache(&cache_dir, b"candidate archive")
        .await
        .unwrap_err();

    assert!(error.to_string().contains("rename"), "got: {error}");
    assert_eq!(fs::read(&retained).await.unwrap(), b"existing contents");
    assert!(!cache_dir.join("archive.tar.gz").exists());
    assert!(!staging_dir(&cache_dir).exists());
}
