use std::fs::File;
use std::io;
use std::path::Path;

use nix::fcntl::Flock;

/// Keep the acquired cache authority with each accepted physical unlink, even
/// when its async observer drops. Return it for the caller's remaining files.
pub(super) async fn remove_cache_file(
    path: &Path,
    lock: Flock<File>,
) -> (Flock<File>, io::Result<()>) {
    let path = path.to_path_buf();
    let dispatch = tracing::dispatcher::get_default(Clone::clone);
    let span = tracing::Span::current();
    let result = tokio::task::spawn_blocking(move || {
        let _default = tracing::dispatcher::set_default(&dispatch);
        let _entered = span.enter();
        let result = std::fs::remove_file(path);
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
