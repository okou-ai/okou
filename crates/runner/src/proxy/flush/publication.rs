//! Deadline-bounded callers with ownership of uncancellable marker I/O.

use std::io::{self, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::OwnedMutexGuard;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tokio_util::task::AbortOnDropHandle;

use super::super::runtime::MitmdumpRuntime;
use crate::error::{RunnerError, RunnerResult};

pub(super) struct MarkerPublication {
    pub path: PathBuf,
    pub content: Vec<u8>,
    pub deadline: Instant,
    pub request_guard: OwnedMutexGuard<()>,
    // Keep the shared addon directory exclusively owned even if the proxy and
    // the waiting caller are dropped while a filesystem syscall is running.
    pub runtime: Option<Arc<MitmdumpRuntime>>,
    #[cfg(test)]
    pub staged_gate: Option<(
        tokio::sync::oneshot::Sender<()>,
        std::sync::mpsc::Receiver<()>,
    )>,
}

impl MarkerPublication {
    pub async fn publish(self) -> RunnerResult<OwnedMutexGuard<()>> {
        let path = self.path.clone();
        let deadline = self.deadline;
        let cancelled = CancellationToken::new();
        let worker_cancelled = cancelled.clone();
        let mut worker = AbortOnDropHandle::new(tokio::task::spawn_blocking(move || {
            self.write(worker_cancelled)
        }));
        // Cancel before dropping/aborting the handle. Aborting alone only stops
        // queued work; a running worker must keep its guard until cleanup ends.
        let _cancel_on_drop = cancelled.drop_guard();
        tokio::time::timeout_at(deadline, &mut worker)
            .await
            .map_err(|_| {
                RunnerError::Internal(format!(
                    "publish flush request {} timed out",
                    path.display()
                ))
            })?
            .map_err(|error| {
                RunnerError::Internal(format!(
                    "flush request publisher {} failed: {error}",
                    path.display()
                ))
            })?
            .map_err(|error| {
                RunnerError::Internal(format!("publish flush request {}: {error}", path.display()))
            })
    }

    fn write(self, cancelled: CancellationToken) -> io::Result<OwnedMutexGuard<()>> {
        let _runtime = self.runtime;
        let ensure_active = || {
            if cancelled.is_cancelled() || Instant::now() >= self.deadline {
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "flush request publication expired or was cancelled",
                ))
            } else {
                Ok(())
            }
        };
        ensure_active()?;
        let parent = self.path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "flush request has no parent")
        })?;
        let name = self.path.file_name().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "flush request has no file name",
            )
        })?;
        let mut staging = tempfile::Builder::new()
            .prefix(&format!(".{}.", name.to_string_lossy()))
            .suffix(".tmp")
            .tempfile_in(parent)?;
        staging
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(
                crate::host_file::PRIVATE_FILE_MODE,
            ))?;
        staging.write_all(&self.content)?;
        staging.flush()?;
        #[cfg(test)]
        if let Some((ready, release)) = self.staged_gate {
            let _ = ready.send(());
            let _ = release.recv_timeout(std::time::Duration::from_secs(10));
        }
        ensure_active()?;
        // NamedTempFile owns cleanup on errors and unwind. A rename that has
        // already started can finish after cancellation, but the request guard
        // prevents a newer publication from overtaking it.
        staging.persist(&self.path).map_err(|error| error.error)?;
        Ok(self.request_guard)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::Mutex;

    async fn staged_publication_retains_ownership(until_timeout: bool) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-flush-request");
        std::fs::write(&path, b"previous request").unwrap();
        let runtime_root = dir.path().join("runtime");
        let runtime_lock_path = dir.path().join("runtime.lock");
        let runtime = MitmdumpRuntime::acquire(runtime_root.clone(), runtime_lock_path.clone())
            .await
            .unwrap();
        let request_lock = Arc::new(Mutex::new(()));
        let (staged_tx, staged_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let operation = MarkerPublication {
            path: path.clone(),
            content: b"expired request".to_vec(),
            deadline: Instant::now() + Duration::from_secs(5),
            request_guard: Arc::clone(&request_lock).lock_owned().await,
            runtime: Some(runtime),
            staged_gate: Some((staged_tx, release_rx)),
        };
        let mut publication = Box::pin(operation.publish());
        assert!(futures_util::poll!(&mut publication).is_pending());
        tokio::time::timeout(Duration::from_secs(2), staged_rx)
            .await
            .unwrap()
            .unwrap();
        if until_timeout {
            tokio::time::pause();
            tokio::time::advance(Duration::from_secs(6)).await;
            assert!(matches!(
                futures_util::poll!(&mut publication),
                std::task::Poll::Ready(Err(_))
            ));
            tokio::time::resume();
        }
        drop(publication);

        assert!(request_lock.try_lock().is_err());
        let runtime_error =
            match MitmdumpRuntime::acquire(runtime_root.clone(), runtime_lock_path.clone()).await {
                Ok(_) => panic!("active publisher released the proxy runtime ownership"),
                Err(error) => error,
            };
        assert!(runtime_error.to_string().contains("lock is already held"));
        assert_eq!(std::fs::read(&path).unwrap(), b"previous request");
        assert_eq!(staging_file_count(dir.path()), 1);

        release_tx.send(()).unwrap();
        let request_guard = tokio::time::timeout(
            Duration::from_secs(2),
            Arc::clone(&request_lock).lock_owned(),
        )
        .await
        .unwrap();
        assert_eq!(staging_file_count(dir.path()), 0);
        assert_eq!(std::fs::read(&path).unwrap(), b"previous request");
        let runtime = MitmdumpRuntime::acquire(runtime_root, runtime_lock_path)
            .await
            .unwrap();
        let _guard = MarkerPublication {
            path: path.clone(),
            content: b"new request".to_vec(),
            deadline: Instant::now() + Duration::from_secs(5),
            request_guard,
            runtime: Some(runtime),
            staged_gate: None,
        }
        .publish()
        .await
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new request");
        assert_eq!(staging_file_count(dir.path()), 0);
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    fn staging_file_count(dir: &std::path::Path) -> usize {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| name.to_string_lossy().ends_with(".tmp"))
            .count()
    }

    #[tokio::test]
    async fn timed_out_staged_publication_cleans_up_before_releasing_ownership() {
        staged_publication_retains_ownership(true).await;
    }

    #[tokio::test]
    async fn dropped_staged_publication_cleans_up_before_releasing_ownership() {
        staged_publication_retains_ownership(false).await;
    }
}
