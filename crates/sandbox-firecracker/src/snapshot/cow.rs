use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::task::{Context, Poll};

use nbd_cow::{PooledDestroyError, PooledNbdCowDevice};
use tokio::task::JoinHandle;

use crate::cow_cleanup::{
    CowCleanupOutcome, classify_cow_destroy_result, cow_destroy_retry_policy,
};

use super::SnapshotError;
use super::output::cleanup_remove_dir_result;

// Keep kernel-device teardown at the boundary so snapshot ownership and
// filesystem cleanup can be exercised without root or a live NBD device.
pub(super) enum SnapshotCowDevice {
    Pooled(PooledNbdCowDevice),
    #[cfg(test)]
    Test {
        cow_file: PathBuf,
        destroy: Pin<Box<dyn Future<Output = Result<(), PooledDestroyError>> + Send>>,
        cleanup_complete: Option<tokio::sync::oneshot::Sender<()>>,
    },
}

impl From<PooledNbdCowDevice> for SnapshotCowDevice {
    fn from(device: PooledNbdCowDevice) -> Self {
        Self::Pooled(device)
    }
}

impl SnapshotCowDevice {
    pub(super) fn device_path(&self) -> &Path {
        match self {
            Self::Pooled(device) => device.device_path(),
            #[cfg(test)]
            Self::Test { .. } => panic!("test COW device cannot be used by Firecracker"),
        }
    }

    pub(super) fn into_pooled(self) -> PooledNbdCowDevice {
        match self {
            Self::Pooled(device) => device,
            #[cfg(test)]
            Self::Test { .. } => panic!("test COW device cannot be published"),
        }
    }

    fn cow_file(&self) -> &Path {
        match self {
            Self::Pooled(device) => device.cow_file(),
            #[cfg(test)]
            Self::Test { cow_file, .. } => cow_file,
        }
    }

    #[cfg(test)]
    fn take_cleanup_complete(&mut self) -> Option<tokio::sync::oneshot::Sender<()>> {
        match self {
            Self::Pooled(_) => None,
            Self::Test {
                cleanup_complete, ..
            } => cleanup_complete.take(),
        }
    }

    async fn destroy(self) -> Result<(), PooledDestroyError> {
        match self {
            Self::Pooled(device) => {
                device
                    .destroy_with_retries_detailed(cow_destroy_retry_policy())
                    .await
            }
            #[cfg(test)]
            Self::Test { destroy, .. } => destroy.await,
        }
    }
}

pub(super) struct SnapshotCowCleanupFinalizer {
    handle: Option<JoinHandle<nbd_cow::error::Result<()>>>,
}

impl SnapshotCowCleanupFinalizer {
    fn new(handle: JoinHandle<nbd_cow::error::Result<()>>) -> Self {
        Self {
            handle: Some(handle),
        }
    }
}

impl Future for SnapshotCowCleanupFinalizer {
    type Output = nbd_cow::error::Result<()>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let Some(handle) = this.handle.as_mut() else {
            return Poll::Ready(Err(nbd_cow::error::NbdCowError::Io(std::io::Error::other(
                "snapshot COW cleanup finalizer polled after completion",
            ))));
        };

        match Pin::new(handle).poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(result) => {
                this.handle.take();
                Poll::Ready(finish_snapshot_cow_cleanup_join(result))
            }
        }
    }
}

impl Drop for SnapshotCowCleanupFinalizer {
    fn drop(&mut self) {
        let Some(handle) = self.handle.take() else {
            return;
        };

        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(observe_detached_snapshot_cow_cleanup(handle));
            }
            Err(e) => tracing::warn!(
                error = %e,
                "snapshot COW cleanup finalizer dropped outside Tokio runtime; continuing without observer"
            ),
        }
    }
}

fn finish_snapshot_cow_cleanup_join(
    result: std::result::Result<nbd_cow::error::Result<()>, tokio::task::JoinError>,
) -> nbd_cow::error::Result<()> {
    match result {
        Ok(result) => result,
        Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
        Err(e) => Err(nbd_cow::error::NbdCowError::Io(std::io::Error::other(
            format!("snapshot COW cleanup finalizer task was cancelled: {e}"),
        ))),
    }
}

async fn observe_detached_snapshot_cow_cleanup(handle: JoinHandle<nbd_cow::error::Result<()>>) {
    match handle.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "detached snapshot COW cleanup finalizer failed");
        }
        Err(e) if e.is_panic() => {
            tracing::error!(error = %e, "detached snapshot COW cleanup finalizer panicked");
        }
        Err(e) => {
            tracing::warn!(error = %e, "detached snapshot COW cleanup finalizer task was cancelled");
        }
    }
}

pub(super) fn destroy_snapshot_cow_and_cleanup_attempt_dir(
    cow_device: impl Into<SnapshotCowDevice>,
) -> SnapshotCowCleanupFinalizer {
    let cow_device = cow_device.into();
    #[cfg(test)]
    let (cow_device, cleanup_complete) = {
        let mut cow_device = cow_device;
        let cleanup_complete = cow_device.take_cleanup_complete();
        (cow_device, cleanup_complete)
    };
    let cow_file = cow_device.cow_file().to_path_buf();
    let cleanup = async move {
        let result = cow_device.destroy().await;
        let outcome = classify_cow_destroy_result(&result);

        match (result, outcome) {
            (Ok(()), _) => {}
            (Err(e), CowCleanupOutcome::BackingFilesSafeToDelete) => {
                tracing::warn!(
                    error = %e,
                    "snapshot COW device released but file cleanup failed; continuing attempt-dir cleanup"
                );
            }
            (Err(e), CowCleanupOutcome::DeviceMayStillReferenceBackingFiles) => {
                return Err(e.into_inner());
            }
        }
        cleanup_snapshot_attempt_dir_for_cow(&cow_file).await;
        Ok(())
    };
    SnapshotCowCleanupFinalizer::new(tokio::spawn(async move {
        let result = cleanup.await;
        #[cfg(test)]
        if let Some(tx) = cleanup_complete {
            let _ = tx.send(());
        }
        result
    }))
}

pub(super) async fn destroy_snapshot_cow_after_error(
    context: &'static str,
    cow_device: SnapshotCowDevice,
) {
    if let Err(e) = destroy_snapshot_cow_and_cleanup_attempt_dir(cow_device).await {
        tracing::warn!(
            error = %e,
            context,
            "failed to destroy COW device after snapshot setup error"
        );
    }
}

pub(super) fn create_sparse_cow_file(path: &Path, size: u64) -> Result<(), SnapshotError> {
    let file = std::fs::File::create(path)
        .map_err(|e| SnapshotError::Setup(format!("create COW file: {e}")))?;
    file.set_len(size)
        .map_err(|e| SnapshotError::Setup(format!("set COW file size: {e}")))?;
    Ok(())
}

pub(super) fn snapshot_attempt_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub(super) fn snapshot_attempt_dir(work_dir: &Path, token: &str) -> PathBuf {
    work_dir.join("attempts").join(token)
}

pub(super) fn snapshot_attempt_cow_file(work_dir: &Path, token: &str) -> PathBuf {
    snapshot_attempt_dir(work_dir, token).join("cow.img")
}

pub(super) fn snapshot_attempt_home_image_file(work_dir: &Path, token: &str) -> PathBuf {
    snapshot_attempt_dir(work_dir, token).join("home.ext4")
}

pub(super) struct SnapshotAttemptDirGuard {
    dir: Option<PathBuf>,
}

impl SnapshotAttemptDirGuard {
    pub(super) fn new(dir: PathBuf) -> Self {
        Self { dir: Some(dir) }
    }

    pub(super) fn disarm(&mut self) {
        self.dir.take();
    }
}

impl Drop for SnapshotAttemptDirGuard {
    fn drop(&mut self) {
        let Some(dir) = self.dir.take() else {
            return;
        };
        if let Err(e) = std::fs::remove_dir_all(&dir)
            && e.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(
                error = %e,
                dir = %dir.display(),
                "failed to cleanup unowned snapshot attempt dir"
            );
        }
    }
}

pub(super) async fn cleanup_snapshot_attempt_dir_for_cow(cow_file: &Path) -> bool {
    let Some(dir) = cow_file.parent() else {
        return true;
    };
    cleanup_remove_dir_result(
        tokio::fs::remove_dir(dir).await,
        dir,
        "failed to cleanup snapshot attempt dir",
    )
}

pub(super) fn cleanup_snapshot_attempt_dir_for_cow_sync(cow_file: &Path) -> bool {
    let Some(dir) = cow_file.parent() else {
        return true;
    };
    cleanup_remove_dir_result(
        std::fs::remove_dir(dir),
        dir,
        "failed to cleanup snapshot attempt dir",
    )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn snapshot_attempt_cow_file_is_attempt_scoped() {
        let work = std::path::Path::new("/tmp/snapshot-work");

        assert_eq!(
            snapshot_attempt_cow_file(work, "abc123ef"),
            work.join("attempts").join("abc123ef").join("cow.img")
        );
        assert_ne!(
            snapshot_attempt_cow_file(work, "abc123ef"),
            work.join("cow.img")
        );
    }

    #[test]
    fn snapshot_attempt_home_image_file_is_attempt_scoped() {
        let work = std::path::Path::new("/tmp/snapshot-work");

        assert_eq!(
            snapshot_attempt_home_image_file(work, "abc123ef"),
            work.join("attempts").join("abc123ef").join("home.ext4")
        );
        assert_ne!(
            snapshot_attempt_home_image_file(work, "abc123ef"),
            work.join("home.ext4")
        );
    }

    #[test]
    fn snapshot_attempt_dir_guard_removes_unowned_attempt_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let attempt_dir = dir.path().join("work").join("attempts").join("abc123ef");
        std::fs::create_dir_all(&attempt_dir).expect("create attempt dir");
        std::fs::write(attempt_dir.join("cow.img"), b"partial cow").expect("write cow");

        {
            let _guard = SnapshotAttemptDirGuard::new(attempt_dir.clone());
        }

        assert!(
            !attempt_dir.exists(),
            "unowned attempt dir should be removed on cancellation"
        );
    }

    #[test]
    fn snapshot_attempt_dir_guard_disarm_preserves_owned_attempt_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let attempt_dir = dir.path().join("work").join("attempts").join("abc123ef");
        std::fs::create_dir_all(&attempt_dir).expect("create attempt dir");

        {
            let mut guard = SnapshotAttemptDirGuard::new(attempt_dir.clone());
            guard.disarm();
        }

        assert!(
            attempt_dir.exists(),
            "disarmed attempt dir guard should leave the owned dir intact"
        );
    }

    #[tokio::test]
    async fn snapshot_cow_cleanup_finalizer_continues_after_future_drop() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();

        let finalizer = SnapshotCowCleanupFinalizer::new(tokio::spawn(async move {
            let _ = started_tx.send(());
            finish_rx.await.map_err(|e| {
                nbd_cow::error::NbdCowError::Io(std::io::Error::other(format!(
                    "test cleanup finalizer release dropped: {e}"
                )))
            })?;
            let _ = done_tx.send(());
            Ok(())
        }));

        started_rx
            .await
            .expect("cleanup finalizer task should start");
        drop(finalizer);
        finish_tx.send(()).expect("release cleanup finalizer");
        tokio::time::timeout(Duration::from_secs(1), done_rx)
            .await
            .expect("dropped cleanup finalizer should continue")
            .expect("cleanup finalizer should finish");
    }

    #[tokio::test]
    async fn cleanup_snapshot_attempt_dir_removes_empty_token_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let work = dir.path().join("work");
        let cow = snapshot_attempt_cow_file(&work, "abc123ef");
        let attempt_dir = cow.parent().expect("attempt dir").to_path_buf();
        tokio::fs::create_dir_all(&attempt_dir)
            .await
            .expect("create attempt dir");
        tokio::fs::write(&cow, b"cow").await.expect("write cow");
        tokio::fs::remove_file(&cow).await.expect("remove cow");

        assert!(cleanup_snapshot_attempt_dir_for_cow(&cow).await);
        assert!(
            !tokio::fs::try_exists(&attempt_dir).await.unwrap(),
            "empty attempt token dir should be removed after cow cleanup"
        );
    }

    #[tokio::test]
    async fn cleanup_snapshot_attempt_dir_treats_missing_dir_as_clean() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cow = snapshot_attempt_cow_file(&dir.path().join("work"), "missing");

        assert!(cleanup_snapshot_attempt_dir_for_cow(&cow).await);
    }

    #[tokio::test]
    async fn cleanup_snapshot_attempt_dir_reports_nonempty_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let work = dir.path().join("work");
        let cow = snapshot_attempt_cow_file(&work, "abc123ef");
        let attempt_dir = cow.parent().expect("attempt dir").to_path_buf();
        tokio::fs::create_dir_all(&attempt_dir)
            .await
            .expect("create attempt dir");
        tokio::fs::write(attempt_dir.join("extra"), b"keep")
            .await
            .expect("write extra");

        assert!(!cleanup_snapshot_attempt_dir_for_cow(&cow).await);
        assert!(
            tokio::fs::try_exists(&attempt_dir).await.unwrap(),
            "nonempty attempt dir should not be force removed"
        );
    }
}
