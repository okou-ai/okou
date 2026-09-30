//! Shared assignment-bound stream lifetime, not a shared protocol ingress.
//!
//! Both endpoints use the same normal-operation reservation and park epoch.
//! A listener failure revokes only streams accepted by that listener.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::task::{Context, Poll};

use guest_control_client::ExternalOperationReservation;
use sandbox::GuestRpcStream;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::UnixStream;
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

#[derive(Default)]
pub(crate) struct EndpointOperations {
    active: Mutex<Vec<Weak<CancellationToken>>>,
}

impl EndpointOperations {
    pub(crate) fn track(&self, operation: &Arc<CancellationToken>, closed: &CancellationToken) {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Completed streams release their strong references; prune on admission
        // so this list stays bounded even during long-lived assignments.
        active.retain(|prior| prior.strong_count() > 0);
        active.push(Arc::downgrade(operation));
        // Close can win before track acquires this lock.
        if closed.is_cancelled() {
            operation.cancel();
        }
    }

    pub(crate) fn cancel(&self) {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for operation in active.drain(..) {
            if let Some(operation) = operation.upgrade() {
                operation.cancel();
            }
        }
    }
}

/// Holds the authoritative park reservation for either private transport.
/// The endpoint's cancellation token is also a child of the run assignment.
pub(crate) struct ReservedStream {
    stream: UnixStream,
    _reservation: ExternalOperationReservation,
    _operation: Arc<CancellationToken>,
    read_cancelled: Pin<Box<WaitForCancellationFutureOwned>>,
    write_cancelled: Pin<Box<WaitForCancellationFutureOwned>>,
}

impl ReservedStream {
    pub(crate) fn new(
        stream: UnixStream,
        reservation: ExternalOperationReservation,
        operation: Arc<CancellationToken>,
    ) -> Self {
        Self {
            stream,
            _reservation: reservation,
            read_cancelled: Box::pin(operation.as_ref().clone().cancelled_owned()),
            write_cancelled: Box::pin(operation.as_ref().clone().cancelled_owned()),
            _operation: operation,
        }
    }
}

impl GuestRpcStream for ReservedStream {}

impl AsyncRead for ReservedStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.read_cancelled.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(unavailable()));
        }
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for ReservedStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.write_cancelled.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(unavailable()));
        }
        Pin::new(&mut self.stream).poll_write(cx, bytes)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.write_cancelled.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(unavailable()));
        }
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.write_cancelled.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(unavailable()));
        }
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

fn unavailable() -> io::Error {
    io::Error::new(
        io::ErrorKind::NotConnected,
        "guest sandbox transport unavailable",
    )
}
