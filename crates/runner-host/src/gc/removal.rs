use std::io;
use std::path::Path;

use nix::fcntl::Flock;

/// Retain the acquired version lock through directory removal and return it for
/// the caller's remaining cleanup, together with the native filesystem result.
/// Once submitted, physical work owns the lock even if its async observer drops.
pub async fn remove_dir_all_with_lock(
    path: &Path,
    lock: Flock<std::fs::File>,
) -> (Flock<std::fs::File>, io::Result<()>) {
    let path = path.to_path_buf();
    let dispatch = tracing::dispatcher::get_default(Clone::clone);
    let span = tracing::Span::current();
    let result = tokio::task::spawn_blocking(move || {
        let _default = tracing::dispatcher::set_default(&dispatch);
        let _entered = span.enter();
        let result = std::fs::remove_dir_all(path);
        (lock, result)
    })
    .await;
    match result {
        Ok(result) => result,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}

#[cfg(test)]
mod tests;
