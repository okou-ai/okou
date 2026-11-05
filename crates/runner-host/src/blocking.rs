use tokio_util::sync::CancellationToken;

/// Own the cancellation guard while awaiting one cooperative blocking operation.
///
/// Dropping the awaiter requests cancellation; the worker retains responsibility for observing
/// the token and retiring its work. A completed join disarms cancellation before returning its
/// result or resuming the original worker panic.
pub(crate) async fn run_cancellable_blocking<F, T>(
    cancel: CancellationToken,
    work: F,
    #[cfg(test)] task_submissions: Option<&std::sync::atomic::AtomicUsize>,
) -> T
where
    F: FnOnce(&CancellationToken) -> T + Send + 'static,
    T: Send + 'static,
{
    let cancel_on_drop = cancel.clone().drop_guard();

    #[cfg(test)]
    if let Some(task_submissions) = task_submissions {
        task_submissions.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    let result = tokio::task::spawn_blocking(move || work(&cancel)).await;
    let _cancel = cancel_on_drop.disarm();
    match result {
        Ok(value) => value,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}

#[cfg(test)]
mod tests;
