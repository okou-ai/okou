use std::io;
use std::path::Path;

/// Retain the acquired guard(s) through directory removal and return them for the
/// caller's remaining cleanup, together with the native filesystem result.
/// Once submitted, physical work owns the guards even if its async observer drops.
pub async fn remove_dir_all_with_lock<G: Send + 'static>(
    path: &Path,
    guards: G,
) -> (G, io::Result<()>) {
    remove_with_lock(path, guards, |path| std::fs::remove_dir_all(path)).await
}

/// Retain the acquired guard(s) through file removal, including after observer
/// cancellation, and return them together with the native filesystem result.
pub async fn remove_file_with_lock<G: Send + 'static>(
    path: &Path,
    guards: G,
) -> (G, io::Result<()>) {
    remove_with_lock(path, guards, |path| std::fs::remove_file(path)).await
}

async fn remove_with_lock<G: Send + 'static>(
    path: &Path,
    guards: G,
    remove: fn(&Path) -> io::Result<()>,
) -> (G, io::Result<()>) {
    let path = path.to_path_buf();
    let dispatch = tracing::dispatcher::get_default(Clone::clone);
    let span = tracing::Span::current();
    let result = tokio::task::spawn_blocking(move || {
        let _default = tracing::dispatcher::set_default(&dispatch);
        let _entered = span.enter();
        let result = remove(&path);
        (guards, result)
    })
    .await;
    match result {
        Ok(result) => result,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}

#[cfg(test)]
mod tests;
