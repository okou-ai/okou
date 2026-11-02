//! Readiness producers retained by the original Sandbox, not borrowed observers.

use std::future::Future;
use std::io;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use uuid::Uuid;

#[derive(Debug)]
struct Failure {
    kind: io::ErrorKind,
    message: String,
}

pub(super) struct Step {
    producer: Shared<BoxFuture<'static, Result<(), Arc<Failure>>>>,
}

impl Step {
    pub(super) fn new(future: impl Future<Output = io::Result<()>> + Send + 'static) -> Self {
        Self {
            producer: async move {
                AssertUnwindSafe(future)
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| {
                        Err(io::Error::other("native transition producer panicked"))
                    })
                    .map_err(|error| {
                        Arc::new(Failure {
                            kind: error.kind(),
                            message: error.to_string(),
                        })
                    })
            }
            .boxed()
            .shared(),
        }
    }

    /// Losing this observation leaves the original producer/result here.
    pub(super) async fn join(&self) -> io::Result<()> {
        self.producer
            .clone()
            .await
            .map_err(|error| io::Error::new(error.kind, error.message.clone()))
    }
}

pub(super) struct Attempt {
    pub(super) id: Uuid,
    pub(super) native: Step,
    pub(super) guest: Step,
}

impl Attempt {
    pub(super) fn new(
        id: Uuid,
        native: impl Future<Output = io::Result<()>> + Send + 'static,
        guest: impl Future<Output = io::Result<()>> + Send + 'static,
    ) -> Self {
        Self {
            id,
            native: Step::new(native),
            guest: Step::new(guest),
        }
    }
}

#[cfg(test)]
mod tests;
