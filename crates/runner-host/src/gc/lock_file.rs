use std::path::Path;

use nix::fcntl::Flock;
use tracing::{info, warn};

use crate::lock::{self, ExistingTryLock, TryLock};

pub enum LockProbe {
    /// Lock acquired — resource is not in use.
    Free(Flock<std::fs::File>),
    /// Lock held by another process.
    Held,
    /// Could not probe (file error).
    Error(String),
}

pub enum ExistingLockProbe {
    /// Lock acquired — resource is not in use.
    Free(Flock<std::fs::File>),
    /// Lock held by another process.
    Held,
    /// The path no longer exists.
    Missing,
    /// Could not probe (file error).
    Error(String),
}

/// Try a nonblocking exclusive flock to check if a resource is in use.
pub fn probe_lock(path: &Path) -> LockProbe {
    match lock::try_acquire_or_busy_blocking(path) {
        Ok(TryLock::Acquired(lock)) => LockProbe::Free(lock),
        Ok(TryLock::Busy) => LockProbe::Held,
        Err(e) => LockProbe::Error(e.to_string()),
    }
}

/// Try a nonblocking exclusive flock without creating a missing lock path.
pub fn probe_existing_lock(path: &Path) -> ExistingLockProbe {
    match lock::try_acquire_existing_or_missing_blocking(path) {
        Ok(ExistingTryLock::Acquired(lock)) => ExistingLockProbe::Free(lock),
        Ok(ExistingTryLock::Busy) => ExistingLockProbe::Held,
        Ok(ExistingTryLock::Missing) => ExistingLockProbe::Missing,
        Err(e) => ExistingLockProbe::Error(e.to_string()),
    }
}

/// Retire a lock path while retaining its acquired flock through physical IO.
///
/// Accepted blocking work owns the guard even if its observer is cancelled.
/// Revalidate path identity inside that owner before unlinking a free lock.
/// Unexpected worker panics propagate with their original payload.
pub async fn remove_unused_lock_after_probe(
    lock_path: &Path,
    lock: Flock<std::fs::File>,
    name: &str,
    dry_run: bool,
) -> bool {
    let lock_path = lock_path.to_path_buf();
    let name = name.to_owned();
    let dispatcher = tracing::dispatcher::get_default(Clone::clone);
    let span = tracing::Span::current();
    let result = tokio::task::spawn_blocking(move || {
        tracing::dispatcher::with_default(&dispatcher, || {
            span.in_scope(|| {
                if !lock_guard_matches_path(&lock_path, &lock) {
                    return false;
                }

                if dry_run {
                    info!("[dry-run] would remove unused lock {name}");
                    return true;
                }

                remove_lock_file(&lock_path)
            })
        })
    })
    .await;

    match result {
        Ok(removed) => removed,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}

fn lock_guard_matches_path(lock_path: &Path, lock: &Flock<std::fs::File>) -> bool {
    match lock::lock_matches_path(lock, lock_path) {
        Ok(true) => true,
        Ok(false) => false,
        Err(e) => {
            warn!("{e}");
            false
        }
    }
}

fn remove_lock_file(lock_path: &Path) -> bool {
    match std::fs::remove_file(lock_path) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => {
            warn!("cannot remove {}: {e}", lock_path.display());
            false
        }
    }
}

#[cfg(test)]
mod tests;
