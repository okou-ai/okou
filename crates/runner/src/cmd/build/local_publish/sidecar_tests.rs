use std::fs::{self, File};

use nix::fcntl::{Flock, FlockArg};
use runner_host::paths::{HomePaths, RootfsPaths};

use super::LocalFilePublish;

const MANIFEST: &[u8] = b"compiled-installed-manifest";
const ROOTFS: &[u8] = b"verified-rootfs";

struct PublicationFixture {
    rootfs: RootfsPaths,
    publish: LocalFilePublish,
    _lock: Flock<File>,
    _directory: tempfile::TempDir,
}

impl PublicationFixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(directory.path().to_path_buf());
        let rootfs = RootfsPaths::new(&home, "sidecar-publication");
        fs::create_dir_all(rootfs.dir()).unwrap();
        let lock_path = home.rootfs_lock("sidecar-publication");
        fs::create_dir_all(lock_path.parent().unwrap()).unwrap();
        let lock = Flock::lock(File::create(lock_path).unwrap(), FlockArg::LockExclusive).unwrap();
        fs::write(rootfs.rootfs_staging(), ROOTFS).unwrap();
        let publish = LocalFilePublish::for_rootfs(&rootfs);
        Self {
            rootfs,
            publish,
            _lock: lock,
            _directory: directory,
        }
    }
}

#[test]
fn commit_publishes_exact_sidecar_and_rootfs() {
    let fixture = PublicationFixture::new();
    fs::write(fixture.rootfs.okou_cli_manifest(), b"stale metadata").unwrap();

    fixture.publish.commit(Some(MANIFEST)).unwrap();

    assert_eq!(
        fs::read(fixture.rootfs.okou_cli_manifest()).unwrap(),
        MANIFEST
    );
    assert_eq!(fs::read(fixture.rootfs.rootfs()).unwrap(), ROOTFS);
    assert!(!fixture.rootfs.rootfs_staging().exists());
}

#[test]
fn commit_clears_stale_sidecar_when_cli_is_absent() {
    let fixture = PublicationFixture::new();
    fs::write(fixture.rootfs.okou_cli_manifest(), b"stale metadata").unwrap();

    fixture.publish.commit(None).unwrap();

    assert!(!fixture.rootfs.okou_cli_manifest().exists());
    assert_eq!(fs::read(fixture.rootfs.rootfs()).unwrap(), ROOTFS);
    assert!(!fixture.rootfs.rootfs_staging().exists());
}

#[test]
fn sidecar_write_failure_prevents_commit_and_preserves_original_error() {
    let fixture = PublicationFixture::new();
    fs::create_dir(fixture.rootfs.okou_cli_manifest()).unwrap();

    let error = fixture.publish.commit(Some(MANIFEST)).unwrap_err();

    assert!(error.to_string().contains("write Okou CLI sidecar"));
    assert!(!fixture.rootfs.rootfs().exists());
    assert_eq!(fs::read(fixture.rootfs.rootfs_staging()).unwrap(), ROOTFS);
    let original = error.to_string();
    let error = fixture.publish.finish_after_result(Err(error)).unwrap_err();
    assert_eq!(error.to_string(), original);
    assert!(!fixture.rootfs.rootfs_staging().exists());
    assert!(fixture.rootfs.okou_cli_manifest().is_dir());
}

#[test]
fn sidecar_removal_failure_prevents_commit_and_preserves_original_error() {
    let fixture = PublicationFixture::new();
    fs::create_dir(fixture.rootfs.okou_cli_manifest()).unwrap();

    let error = fixture.publish.commit(None).unwrap_err();

    assert!(error.to_string().contains("remove stale Okou CLI sidecar"));
    assert!(!fixture.rootfs.rootfs().exists());
    assert_eq!(fs::read(fixture.rootfs.rootfs_staging()).unwrap(), ROOTFS);
    let original = error.to_string();
    let error = fixture.publish.finish_after_result(Err(error)).unwrap_err();
    assert_eq!(error.to_string(), original);
    assert!(!fixture.rootfs.rootfs_staging().exists());
    assert!(fixture.rootfs.okou_cli_manifest().is_dir());
}
