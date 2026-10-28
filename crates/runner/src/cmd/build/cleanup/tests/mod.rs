use std::path::Path;
use std::sync::mpsc::{self, Sender};
use std::time::Duration;

use nix::errno::Errno;
use nix::fcntl::FlockArg;
use runner_host::{lock, paths::HomePaths};

use super::super::{
    RootfsPaths, RootfsScripts, TEMPLATE_BUILD_DIR_PREFIX, template_warm_parent_dir,
};
use super::*;

struct BlockingSlot {
    release: Option<Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl BlockingSlot {
    fn occupy(runtime: &tokio::runtime::Runtime) -> Self {
        let (started_tx, started_rx) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let task = runtime.spawn_blocking(move || {
            started_tx.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        Self {
            release: Some(release),
            task,
        }
    }

    fn finish(&mut self, runtime: &tokio::runtime::Runtime) {
        self.release.take().unwrap().send(()).unwrap();
        runtime.block_on(&mut self.task).unwrap();
    }
}

impl Drop for BlockingSlot {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
    }
}

#[derive(Clone, Copy)]
enum CleanupCase {
    RootfsAttempt,
    WarmParent,
}

fn independently_contended(path: &Path) -> bool {
    match Flock::lock(
        lock::open_lock_file(path).unwrap(),
        FlockArg::LockExclusiveNonblock,
    ) {
        Ok(_) => false,
        Err((_, error)) => {
            assert_eq!(error, Errno::EWOULDBLOCK);
            true
        }
    }
}

fn cancelled_cleanup_retains_primary_authority(case: CleanupCase) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().to_path_buf());
    let (parent, prefix, lock_path) = match case {
        CleanupCase::RootfsAttempt => (
            RootfsPaths::new(&home, "cleanup-rootfs")
                .dir()
                .to_path_buf(),
            TEMPLATE_BUILD_DIR_PREFIX,
            home.rootfs_lock("cleanup-rootfs"),
        ),
        CleanupCase::WarmParent => (
            template_warm_parent_dir(&home, "cleanup-template"),
            TEMPLATE_WARM_ATTEMPT_DIR_PREFIX,
            home.template_lock("cleanup-template"),
        ),
    };
    let guard = Arc::new(runtime.block_on(lock::acquire(lock_path.clone())).unwrap());
    let cleanup = match case {
        CleanupCase::RootfsAttempt => {
            let scripts = RootfsScripts::new(guard, None);
            scripts.cleanup()
        }
        CleanupCase::WarmParent => TemplateCleanup::new(guard),
    };
    let stale = parent.join(format!("{prefix}stale.tmp"));
    std::fs::create_dir_all(stale.join("nested")).unwrap();
    std::fs::write(stale.join("nested/partial"), b"stale").unwrap();
    let unmatched = parent.join("keep");
    std::fs::write(&unmatched, b"unmatched").unwrap();
    let outside = dir.path().join("outside");
    std::fs::write(&outside, b"outside").unwrap();
    let link = parent.join(format!("{prefix}linked.tmp"));
    std::os::unix::fs::symlink(&outside, &link).unwrap();

    let mut slot = BlockingSlot::occupy(&runtime);
    let mut observer = Box::pin(async move {
        match case {
            CleanupCase::RootfsAttempt => cleanup.stale_attempts(&parent, prefix).await,
            CleanupCase::WarmParent => cleanup.warm_parent(&parent).await,
        }
    });
    runtime.block_on(async {
        assert!(futures_util::poll!(observer.as_mut()).is_pending());
    });
    drop(observer);
    let contended = independently_contended(&lock_path);
    let removal_was_queued = stale.exists();
    slot.finish(&runtime);
    // One blocking slot and FIFO admission: this marker completes after removal.
    let physical = runtime.spawn_blocking(|| {});
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(5), physical)
            .await
            .unwrap()
            .unwrap();
    });

    assert!(
        contended,
        "template cleanup released its primary lock before physical removal"
    );
    assert!(removal_was_queued);
    assert!(!stale.exists());
    assert_eq!(
        std::fs::symlink_metadata(&link).unwrap_err().kind(),
        std::io::ErrorKind::NotFound
    );
    assert_eq!(std::fs::read(&unmatched).unwrap(), b"unmatched");
    assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
    assert!(!independently_contended(&lock_path));
}

#[test]
fn cancelled_rootfs_attempt_cleanup_retains_lock_through_removal() {
    cancelled_cleanup_retains_primary_authority(CleanupCase::RootfsAttempt);
}

#[test]
fn cancelled_warm_parent_cleanup_retains_lock_through_removal() {
    cancelled_cleanup_retains_primary_authority(CleanupCase::WarmParent);
}
