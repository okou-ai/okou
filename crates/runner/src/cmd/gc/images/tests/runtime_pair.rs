use super::*;

#[tokio::test]
async fn one_image_lease_retains_both_sources_and_gc_retires_the_whole_pair() {
    let dir = tempfile::tempdir().unwrap();
    let home = test_home(dir.path());
    let rootfs = runner_host::paths::RootfsPaths::new(&home, "runtime-pair");
    std::fs::create_dir_all(rootfs.dir()).unwrap();
    for path in [rootfs.rootfs(), rootfs.runtime(), rootfs.runtime_staging()] {
        std::fs::write(path, b"owned image bytes").unwrap();
    }
    set_mtime(rootfs.dir(), old_gc_time());
    let lease = lock::acquire_shared(home.rootfs_lock("runtime-pair"))
        .await
        .unwrap();
    assert_eq!(gc_nested_images(&home, Some(0), false).await.unwrap(), 0);
    assert!(rootfs.rootfs().is_file());
    assert!(rootfs.runtime().is_file());
    assert!(rootfs.runtime_staging().is_file());
    drop(lease);
    assert!(gc_nested_images(&home, Some(0), false).await.unwrap() > 0);
    assert!(!rootfs.dir().exists());
}
