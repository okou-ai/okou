use std::fs::File;
use std::future::Future;
use std::path::PathBuf;
use std::sync::mpsc;
use std::task::{Context, Waker};
use std::time::Duration;

use nix::fcntl::Flock;
use tokio::runtime::Builder;

use crate::gc::{ExistingLockProbe, probe_existing_lock};
use crate::lock::lock_matches_path;

const WAIT: Duration = Duration::from_secs(5);

struct ReleaseWorkerOnDrop(mpsc::Sender<()>);

impl Drop for ReleaseWorkerOnDrop {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

/// Cancel the observer while physical removal is queued behind an occupied
/// blocking worker. Verify the actual named locks remain held, then release the
/// worker and return successor guards only after physical authority retires.
pub fn cancel_queued_removal(
    removal: impl Future,
    lock_paths: &[PathBuf],
) -> Result<Vec<Flock<File>>, String> {
    let runtime = Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .map_err(|error| format!("build removal test runtime: {error}"))?;
    let (started, started_rx) = mpsc::sync_channel(0);
    let (release, release_rx) = mpsc::channel();
    // Release on every exit, including assertion unwinding, before Runtime drops.
    let gate = ReleaseWorkerOnDrop(release);
    let worker = runtime.spawn_blocking(move || {
        started
            .send(())
            .map_err(|error| format!("publish occupied worker: {error}"))?;
        release_rx
            .recv()
            .map_err(|error| format!("wait for worker release: {error}"))
    });
    started_rx
        .recv_timeout(WAIT)
        .map_err(|error| format!("wait for occupied blocking worker: {error}"))?;

    let mut removal = Box::pin(removal);
    let entered = runtime.enter();
    let pending = removal
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
        .is_pending();
    drop(entered);
    drop(removal);
    assert!(pending, "removal must queue behind the occupied worker");
    for path in lock_paths {
        assert!(
            matches!(probe_existing_lock(path), ExistingLockProbe::Held),
            "observer cancellation released authority before physical removal: {}",
            path.display()
        );
    }

    drop(gate);
    runtime.block_on(async {
        tokio::time::timeout(WAIT, async {
            worker
                .await
                .map_err(|error| format!("join occupied worker: {error}"))??;
            let mut successors = Vec::new();
            for path in lock_paths {
                let successor = loop {
                    match probe_existing_lock(path) {
                        ExistingLockProbe::Free(lock) => break lock,
                        ExistingLockProbe::Held => tokio::task::yield_now().await,
                        ExistingLockProbe::Missing => {
                            return Err(format!(
                                "removal lock path disappeared: {}",
                                path.display()
                            ));
                        }
                        ExistingLockProbe::Error(error) => {
                            return Err(format!("probe {}: {error}", path.display()));
                        }
                    }
                };
                assert!(
                    lock_matches_path(&successor, path)
                        .map_err(|error| format!("match successor {}: {error}", path.display()))?,
                    "successor must own the original lock path"
                );
                successors.push(successor);
            }
            Ok(successors)
        })
        .await
        .map_err(|error| format!("accepted removal did not retire its authority: {error}"))?
    })
}
