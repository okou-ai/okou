use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

use crate::error;
use tokio::task::JoinHandle;

pub(super) struct PooledCowFinalizer<T, E = error::NbdCowError>
where
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    handle: Option<JoinHandle<std::result::Result<T, E>>>,
}

impl<T, E> PooledCowFinalizer<T, E>
where
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    pub(super) fn new(handle: JoinHandle<std::result::Result<T, E>>) -> Self {
        Self {
            handle: Some(handle),
        }
    }
}

pub(super) fn run_finalizer<T, E>(
    future: impl Future<Output = std::result::Result<T, E>> + Send + 'static,
) -> PooledCowFinalizer<T, E>
where
    T: Send + 'static,
    E: From<error::NbdCowError> + std::fmt::Display + Send + 'static,
{
    PooledCowFinalizer::new(tokio::spawn(future))
}

impl<T, E> Future for PooledCowFinalizer<T, E>
where
    T: Send + 'static,
    E: From<error::NbdCowError> + std::fmt::Display + Send + 'static,
{
    type Output = std::result::Result<T, E>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let Some(handle) = this.handle.as_mut() else {
            return Poll::Ready(Err(E::from(error::NbdCowError::Io(std::io::Error::other(
                "pooled NBD COW finalizer polled after completion",
            )))));
        };

        match Pin::new(handle).poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(result) => {
                this.handle.take();
                Poll::Ready(finish_finalizer_join(result))
            }
        }
    }
}

impl<T, E> Drop for PooledCowFinalizer<T, E>
where
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    fn drop(&mut self) {
        let Some(handle) = self.handle.take() else {
            return;
        };

        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(observe_detached_finalizer(handle));
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "pooled NBD COW finalizer future dropped outside Tokio runtime; continuing without observer"
                );
            }
        }
    }
}

fn finish_finalizer_join<T, E>(
    result: std::result::Result<std::result::Result<T, E>, tokio::task::JoinError>,
) -> std::result::Result<T, E>
where
    E: From<error::NbdCowError>,
{
    match result {
        Ok(result) => result,
        Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
        Err(e) => Err(E::from(error::NbdCowError::Io(std::io::Error::other(
            format!("pooled NBD COW finalizer task was cancelled: {e}"),
        )))),
    }
}

async fn observe_detached_finalizer<T, E>(handle: JoinHandle<std::result::Result<T, E>>)
where
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    match handle.await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "detached pooled NBD COW finalizer failed");
        }
        Err(e) if e.is_panic() => {
            tracing::error!(error = %e, "detached pooled NBD COW finalizer panicked");
        }
        Err(e) => {
            tracing::warn!(error = %e, "detached pooled NBD COW finalizer task was cancelled");
        }
    }
}

#[cfg(test)]
mod tests;
