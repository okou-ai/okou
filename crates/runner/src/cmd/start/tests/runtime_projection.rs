use super::super::*;

#[test]
fn runtime_profile_projection_preserves_concrete_inputs_without_startup_effects() {
    let temp = tempfile::tempdir().unwrap();
    let home_root = temp.path().join("home-not-created");
    let home = HomePaths::with_root(home_root.clone());
    let base_dir = temp.path().join("base-not-created");
    let firecracker = config::FirecrackerConfig {
        binary: temp.path().join("firecracker"),
        kernel: temp.path().join("vmlinux"),
    };
    let profiles = BTreeMap::from([
        (
            "vm0/a".into(),
            ProfileConfig {
                rootfs_hash: "root-a".into(),
                snapshot_hash: "snap-a".into(),
                vcpu: 2,
                memory_mb: 4096,
                rootfs_disk_mb: 8192,
                home_disk_mb: 10240,
            },
        ),
        (
            "vm0/b".into(),
            ProfileConfig {
                rootfs_hash: "root-b".into(),
                snapshot_hash: "snap-b".into(),
                vcpu: 4,
                memory_mb: 8192,
                rootfs_disk_mb: 16384,
                home_disk_mb: 20480,
            },
        ),
    ]);
    let projected = runtime_profiles(&profiles, &firecracker, &base_dir, &home);
    assert_eq!(
        projected.keys().map(String::as_str).collect::<Vec<_>>(),
        vec!["vm0/a", "vm0/b"]
    );
    for (name, original) in &profiles {
        let actual = projected.get(name).unwrap();
        assert_eq!(actual.vcpu, original.vcpu);
        assert_eq!(actual.memory_mb, original.memory_mb);
        assert_eq!(actual.rootfs_hash, original.rootfs_hash);
        assert_eq!(actual.rootfs_disk_mb, original.rootfs_disk_mb);
        assert_eq!(actual.home_disk_mb, original.home_disk_mb);
        let factory = &actual.factory_config;
        assert_eq!(factory.profile, *name);
        assert_eq!(factory.binary_path, firecracker.binary);
        assert_eq!(factory.kernel_path, firecracker.kernel);
        assert_eq!(factory.base_dir, base_dir);
        let rootfs = runner_host::paths::RootfsPaths::new(&home, &original.rootfs_hash);
        assert_eq!(factory.rootfs_path, rootfs.rootfs());
        let snapshot = factory.snapshot.as_ref().unwrap();
        assert_eq!(snapshot.hash, original.snapshot_hash);
        assert_eq!(
            snapshot.output_dir,
            rootfs.snapshot(&original.snapshot_hash).dir()
        );
    }
    assert!(
        !home_root.exists(),
        "projection must not allocate image resources"
    );
    assert!(!base_dir.exists(), "projection must not start a factory");
}
