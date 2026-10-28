use std::fs::File;
use std::os::fd::AsRawFd;

use futures_util::FutureExt;
use nix::fcntl::Flock;

use crate::gc::test_support::cancel_queued_removal;
use crate::gc::{ExistingLockProbe, LockProbe, probe_existing_lock, probe_lock};
use crate::lock::lock_matches_path;

use super::*;

#[derive(Clone, Copy)]
enum Removal {
    Directory,
    File,
}

impl Removal {
    fn prepare(self, path: &Path, failing: bool) {
        match (self, failing) {
            (Self::Directory, false) | (Self::File, true) => {
                std::fs::create_dir(path).unwrap();
                std::fs::write(path.join("archive.tar.gz"), b"cache bytes").unwrap();
            }
            (Self::File, false) | (Self::Directory, true) => {
                std::fs::write(path, b"cache bytes").unwrap();
            }
        }
    }

    async fn remove(self, path: &Path, lock: Flock<File>) -> (Flock<File>, io::Result<()>) {
        match self {
            Self::Directory => remove_dir_all_with_lock(path, lock).await,
            Self::File => remove_file_with_lock(path, lock).await,
        }
    }

    fn error_kind(self) -> io::ErrorKind {
        match self {
            Self::Directory => io::ErrorKind::NotADirectory,
            Self::File => io::ErrorKind::IsADirectory,
        }
    }

    fn assert_retained(self, path: &Path) {
        let retained = match self {
            Self::Directory => path.to_path_buf(),
            Self::File => path.join("archive.tar.gz"),
        };
        assert_eq!(std::fs::read(retained).unwrap(), b"cache bytes");
    }
}

fn acquire(path: &Path) -> Flock<File> {
    match probe_lock(path) {
        LockProbe::Free(lock) => lock,
        LockProbe::Held => panic!("test removal lock unexpectedly held"),
        LockProbe::Error(error) => panic!("cannot acquire test removal lock: {error}"),
    }
}

fn cancelled_removal_retains_authority(failing: bool) {
    for kind in [Removal::Directory, Removal::File] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache");
        let lock_path = dir.path().join("resource.lock");
        kind.prepare(&path, failing);
        let lock = acquire(&lock_path);
        let _successors = cancel_queued_removal(kind.remove(&path, lock), &[lock_path]).unwrap();

        if failing {
            kind.assert_retained(&path);
        } else {
            assert!(!path.try_exists().unwrap());
        }
    }
}

#[test]
fn cancelled_deletion_retains_lock_until_physical_retirement() {
    cancelled_removal_retains_authority(false);
}

#[test]
fn cancelled_io_error_retains_lock_until_physical_retirement() {
    cancelled_removal_retains_authority(true);
}

#[tokio::test]
async fn observed_results_return_the_original_guard() {
    for kind in [Removal::Directory, Removal::File] {
        // Physical success, native IO error, and missing-path semantics all return
        // the same acquired descriptor, without releasing/reacquiring its flock.
        for failing in [Some(false), Some(true), None] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("cache");
            let lock_path = dir.path().join("resource.lock");
            if let Some(failing) = failing {
                kind.prepare(&path, failing);
            }
            let lock = acquire(&lock_path);
            let original_fd = lock.as_raw_fd();
            let (lock, result) = kind.remove(&path, lock).await;

            match failing {
                Some(false) => {
                    result.unwrap();
                    assert!(!path.try_exists().unwrap());
                }
                Some(true) => {
                    assert_eq!(result.unwrap_err().kind(), kind.error_kind());
                    kind.assert_retained(&path);
                }
                None => assert_eq!(result.unwrap_err().kind(), io::ErrorKind::NotFound),
            }
            assert_eq!(lock.as_raw_fd(), original_fd);
            assert!(lock_matches_path(&lock, &lock_path).unwrap());
            assert!(matches!(
                probe_existing_lock(&lock_path),
                ExistingLockProbe::Held
            ));
            drop(lock);
            assert!(matches!(
                probe_existing_lock(&lock_path),
                ExistingLockProbe::Free(_)
            ));
        }
    }
}

#[tokio::test]
async fn blocking_worker_preserves_tracing_dispatch_and_span() {
    let _subscriber = tracing::subscriber::set_default(tracing_subscriber::registry());
    let span = tracing::info_span!("gc-removal");
    let _entered = span.enter();
    let (_, result) = remove_with_lock(Path::new("unused"), (), |_| {
        assert_eq!(
            tracing::Span::current().metadata().map(|meta| meta.name()),
            Some("gc-removal")
        );
        Ok(())
    })
    .await;
    result.unwrap();
}

#[tokio::test]
async fn blocking_worker_resumes_the_original_panic_and_releases_guard() {
    let dir = tempfile::tempdir().unwrap();
    let lock_path = dir.path().join("resource.lock");
    let lock = acquire(&lock_path);
    let panic = std::panic::AssertUnwindSafe(remove_with_lock(dir.path(), lock, |_| {
        std::panic::panic_any(42_u64)
    }))
    .catch_unwind()
    .await
    .unwrap_err();

    assert_eq!(panic.downcast_ref::<u64>(), Some(&42));
    assert!(matches!(
        probe_existing_lock(&lock_path),
        ExistingLockProbe::Free(_)
    ));
}
