//! Dedicated, private Guest-initiated vsock endpoint for opaque duplex frames.

use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use guest_contracts::private_duplex::ACTIVATE;
use guest_control_client::{ExternalOperationReservation, GuestControlClient};
use sandbox::{AcceptedGuestDuplex, GuestDuplexAcceptor};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{UnixListener, UnixStream};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

use crate::park_coordinator::ParkCoordinator;
use crate::runtime_dirs::set_private_runtime_socket_mode;
use crate::sandbox::SandboxState;

/// The guest worker must already have connected before this deadline. Old images fail closed.
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) struct ContextData {
    pub sandbox_id: String,
    pub state: Arc<AtomicU8>,
    pub guest: Arc<tokio::sync::Mutex<Option<Arc<GuestControlClient>>>>,
    pub coordinator: ParkCoordinator,
}

struct Shared {
    listener: Mutex<Option<Arc<UnixListener>>>,
    path: PathBuf,
    closed: CancellationToken,
    context: ContextData,
}

impl Shared {
    fn close(&self) {
        let mut listener = self.listener.lock().unwrap_or_else(|e| e.into_inner());
        if listener.take().is_none() {
            return;
        }
        self.closed.cancel();
        // Runtime exit must revoke in-flight streams even when park/terminate
        // has not yet changed the coordinator's assignment state.
        self.context.coordinator.cancel_guest_rpc_operations();
        if let Err(error) = std::fs::remove_file(&self.path)
            && error.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!(sandbox_id = %self.context.sandbox_id, error = %error, "remove private duplex listener failed");
        }
    }

    fn ensure_running(&self) -> io::Result<()> {
        if self.closed.is_cancelled()
            || self.context.state.load(Ordering::Acquire) != SandboxState::Running as u8
        {
            return Err(unavailable());
        }
        Ok(())
    }
}

pub(crate) struct Endpoint {
    shared: Arc<Shared>,
    cleanup: tokio::task::JoinHandle<()>,
}

impl Endpoint {
    pub(crate) fn bind(
        path: PathBuf,
        context: ContextData,
        runtime_cancel: CancellationToken,
    ) -> io::Result<Self> {
        // Parent is the already validated private (0700) sandbox vsock directory.
        let listener = UnixListener::bind(&path)?;
        let shared = Arc::new(Shared {
            listener: Mutex::new(Some(Arc::new(listener))),
            path,
            closed: CancellationToken::new(),
            context,
        });
        if let Err(error) = set_private_runtime_socket_mode(&shared.path) {
            shared.close();
            return Err(error);
        }
        let cleanup_shared = Arc::clone(&shared);
        let cleanup = tokio::spawn(async move {
            runtime_cancel.cancelled().await;
            cleanup_shared.close();
        });
        Ok(Self { shared, cleanup })
    }

    pub(crate) fn acceptor(&self, run_id: &str) -> Arc<dyn GuestDuplexAcceptor> {
        Arc::new(Acceptor {
            shared: Arc::clone(&self.shared),
            run_id: run_id.to_owned(),
        })
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        self.shared.close();
        self.cleanup.abort();
    }
}

struct Acceptor {
    shared: Arc<Shared>,
    run_id: String,
}

#[async_trait]
impl GuestDuplexAcceptor for Acceptor {
    async fn accept(&self) -> io::Result<AcceptedGuestDuplex> {
        self.shared.ensure_running()?;
        let assignment_cancel = self
            .shared
            .context
            .coordinator
            .guest_rpc_assignment_cancellation(&self.run_id)?;
        let listener = self
            .shared
            .listener
            .lock()
            .map_err(|_| unavailable())?
            .as_ref()
            .cloned()
            .ok_or_else(unavailable)?;
        let (mut stream, _) = tokio::select! {
            biased;
            () = self.shared.closed.cancelled() => return Err(unavailable()),
            () = assignment_cancel.cancelled() => return Err(unavailable()),
            result = tokio::time::timeout(ACCEPT_TIMEOUT, listener.accept()) =>
                result.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "guest channel unavailable"))??,
        };
        let guest = tokio::select! {
            biased;
            () = self.shared.closed.cancelled() => return Err(unavailable()),
            () = assignment_cancel.cancelled() => return Err(unavailable()),
            guest = tokio::time::timeout(ACCEPT_TIMEOUT, self.shared.context.guest.lock()) =>
                guest.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "guest control unavailable"))?
                    .as_ref().cloned().ok_or_else(unavailable)?,
        };
        self.shared.ensure_running()?;
        let (reservation, cancelled) = self
            .shared
            .context
            .coordinator
            .reserve_guest_rpc_operation(&self.run_id, &guest)?;
        if cancelled.is_cancelled() || self.shared.ensure_running().is_err() {
            return Err(unavailable());
        }
        // The Guest does not spawn a worker until this assignment-scoped activation.
        tokio::select! {
            biased;
            () = cancelled.cancelled() => return Err(unavailable()),
            () = self.shared.closed.cancelled() => return Err(unavailable()),
            result = tokio::time::timeout(ACCEPT_TIMEOUT, stream.write_all(&[ACTIVATE])) =>
                result.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "guest activation timed out"))??,
        }
        Ok(AcceptedGuestDuplex {
            sandbox_id: self.shared.context.sandbox_id.clone(),
            stream: Box::new(ReservedStream {
                stream,
                _reservation: reservation,
                read_cancelled: Box::pin(cancelled.clone().cancelled_owned()),
                write_cancelled: Box::pin(cancelled.clone().cancelled_owned()),
            }),
            cancelled,
        })
    }
}

#[cfg(test)]
mod tests;

fn unavailable() -> io::Error {
    io::Error::new(
        io::ErrorKind::NotConnected,
        "guest channel assignment unavailable",
    )
}

struct ReservedStream {
    stream: UnixStream,
    _reservation: ExternalOperationReservation,
    read_cancelled: Pin<Box<WaitForCancellationFutureOwned>>,
    write_cancelled: Pin<Box<WaitForCancellationFutureOwned>>,
}

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
