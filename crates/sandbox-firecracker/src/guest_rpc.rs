//! Sandbox-owned dedicated guest listener. There is no production method handler.

use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use guest_contracts::private_duplex::{ACTIVATE, PREFACE, READY};
use guest_control_client::{ExternalOperationReservation, GuestControlClient};
use sandbox::{
    AcceptedGuestDuplex, AcceptedGuestRpc, GuestDuplexAcceptor, GuestRpcAcceptor, GuestRpcStream,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

use crate::park_coordinator::ParkCoordinator;
use crate::runtime_dirs::set_private_runtime_socket_mode;
use crate::sandbox::SandboxState;

const CLASSIFY_TIMEOUT: Duration = Duration::from_secs(2);
const DUPLEX_ACTIVATE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_CLASSIFIERS: usize = 16;

pub(crate) struct GuestRpcContext {
    pub(crate) sandbox_id: String,
    pub(crate) state: Arc<AtomicU8>,
    pub(crate) guest: Arc<tokio::sync::Mutex<Option<Arc<GuestControlClient>>>>,
    pub(crate) coordinator: ParkCoordinator,
}

struct Shared {
    listener: Mutex<Option<Arc<UnixListener>>>,
    rpc: tokio::sync::Mutex<mpsc::Receiver<(UnixStream, u8)>>,
    duplex: tokio::sync::Mutex<mpsc::Receiver<UnixStream>>,
    path: PathBuf,
    closed: CancellationToken,
    context: GuestRpcContext,
}

impl Shared {
    fn close(&self) {
        let mut listener = self
            .listener
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if listener.take().is_none() {
            return;
        }
        self.closed.cancel();
        self.context.coordinator.cancel_guest_rpc_operations();
        if let Err(error) = std::fs::remove_file(&self.path)
            && error.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!(sandbox_id = %self.context.sandbox_id, error = %error, "remove guest RPC listener failed");
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

/// Sole close/unlink owner; capabilities cannot extend a listener epoch.
pub(crate) struct GuestRpcEndpoint {
    shared: Arc<Shared>,
    ingress: tokio::task::JoinHandle<()>,
    cleanup: tokio::task::JoinHandle<()>,
}

impl GuestRpcEndpoint {
    pub(crate) fn bind(
        path: PathBuf,
        context: GuestRpcContext,
        runtime_cancel: CancellationToken,
    ) -> io::Result<Self> {
        // The parent is the already-validated 0700 sandbox vsock directory.
        // Do not remove an existing entry: it belongs to another bind owner.
        let listener = UnixListener::bind(&path)?;
        let (rpc_tx, rpc_rx) = mpsc::channel(16);
        // One speculative Guest connector, never a pool of parked reservations.
        let (duplex_tx, duplex_rx) = mpsc::channel(1);
        let shared = Arc::new(Shared {
            listener: Mutex::new(Some(Arc::new(listener))),
            rpc: tokio::sync::Mutex::new(rpc_rx),
            duplex: tokio::sync::Mutex::new(duplex_rx),
            path,
            closed: CancellationToken::new(),
            context,
        });
        if let Err(error) = set_private_runtime_socket_mode(&shared.path) {
            shared.close();
            return Err(error);
        }
        let ingress = tokio::spawn(route_connections(Arc::clone(&shared), rpc_tx, duplex_tx));
        // A retained old acceptor may keep Shared alive after park. Close its
        // queued idle sockets promptly, not only its listener and active IO.
        let drain_shared = Arc::clone(&shared);
        tokio::spawn(async move {
            drain_shared.closed.cancelled().await;
            let mut duplex = drain_shared.duplex.lock().await;
            duplex.close();
            while duplex.try_recv().is_ok() {}
            let mut rpc = drain_shared.rpc.lock().await;
            rpc.close();
            while rpc.try_recv().is_ok() {}
        });
        let cleanup_shared = Arc::clone(&shared);
        let cleanup = tokio::spawn(async move {
            runtime_cancel.cancelled().await;
            cleanup_shared.close();
        });
        Ok(Self {
            shared,
            ingress,
            cleanup,
        })
    }

    pub(crate) fn acceptor(&self, run_id: &str) -> Arc<dyn GuestRpcAcceptor> {
        Arc::new(Acceptor {
            shared: Arc::clone(&self.shared),
            run_id: run_id.to_owned(),
        })
    }

    pub(crate) fn duplex_acceptor(&self, run_id: &str) -> Arc<dyn GuestDuplexAcceptor> {
        Arc::new(DuplexAcceptor {
            shared: Arc::clone(&self.shared),
            run_id: run_id.to_owned(),
        })
    }
}

impl Drop for GuestRpcEndpoint {
    fn drop(&mut self) {
        self.shared.close();
        self.ingress.abort();
        self.cleanup.abort();
    }
}

/// One ingress owns port 52001. Classify only the first byte of each connection:
/// 0xff cannot begin any valid bounded RPC request length. Preserve every legacy
/// byte for the original RPC decoder; idle duplex candidates hold no park fence.
async fn route_connections(
    shared: Arc<Shared>,
    rpc: mpsc::Sender<(UnixStream, u8)>,
    duplex: mpsc::Sender<UnixStream>,
) {
    let listener = shared
        .listener
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .cloned();
    let Some(listener) = listener else { return };
    let classifiers = Arc::new(Semaphore::new(MAX_CLASSIFIERS));
    loop {
        let result = tokio::select! {
            biased;
            () = shared.closed.cancelled() => break,
            result = listener.accept() => result,
        };
        let Ok((mut stream, _)) = result else { break };
        let Ok(permit) = Arc::clone(&classifiers).try_acquire_owned() else {
            continue;
        };
        let rpc = rpc.clone();
        let duplex = duplex.clone();
        let closed = shared.closed.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let first = tokio::select! {
                biased;
                () = closed.cancelled() => return,
                result = tokio::time::timeout(CLASSIFY_TIMEOUT, stream.read_u8()) => result,
            };
            let Ok(Ok(first)) = first else { return };
            if closed.is_cancelled() {
                return;
            }
            if first == PREFACE {
                // Reserve the single pending slot before acknowledging the Guest.
                // READY grants no assignment or operation reservation; a real
                // open still rechecks the epoch and sends ACTIVATE separately.
                if let Ok(slot) = duplex.try_reserve() {
                    let acknowledged = tokio::select! {
                        biased;
                        () = closed.cancelled() => false,
                        result = tokio::time::timeout(CLASSIFY_TIMEOUT, stream.write_all(&[READY])) =>
                            matches!(result, Ok(Ok(()))),
                    };
                    if acknowledged && !closed.is_cancelled() {
                        slot.send(stream);
                    }
                }
            } else {
                let _ = rpc.try_send((stream, first));
            }
        });
    }
    shared.close();
}

struct Acceptor {
    shared: Arc<Shared>,
    run_id: String,
}

#[async_trait]
impl GuestRpcAcceptor for Acceptor {
    async fn accept(&self) -> io::Result<AcceptedGuestRpc> {
        self.shared.ensure_running()?;
        let assignment_cancel = self
            .shared
            .context
            .coordinator
            .guest_rpc_assignment_cancellation(&self.run_id)?;
        let (stream, prefix) = tokio::select! {
            biased;
            () = self.shared.closed.cancelled() => return Err(unavailable()),
            () = assignment_cancel.cancelled() => return Err(unavailable()),
            result = async { self.shared.rpc.lock().await.recv().await } => result.ok_or_else(unavailable)?,
        };
        let guest = tokio::select! {
            biased;
            () = self.shared.closed.cancelled() => return Err(unavailable()),
            () = assignment_cancel.cancelled() => return Err(unavailable()),
            guest = self.shared.context.guest.lock() => guest.as_ref().cloned().ok_or_else(unavailable)?,
        };
        self.shared.ensure_running()?;
        let (reservation, cancelled) = self
            .shared
            .context
            .coordinator
            .reserve_guest_rpc_operation(&self.run_id, &guest)?;
        self.shared.ensure_running()?;
        if cancelled.is_cancelled() {
            return Err(unavailable());
        }
        Ok(AcceptedGuestRpc {
            sandbox_id: self.shared.context.sandbox_id.clone(),
            stream: Box::new(ReservedStream {
                stream,
                prefix: Some(prefix),
                _reservation: reservation,
                read_cancelled: Box::pin(cancelled.clone().cancelled_owned()),
                write_cancelled: Box::pin(cancelled.clone().cancelled_owned()),
            }),
            cancelled,
        })
    }
}

struct DuplexAcceptor {
    shared: Arc<Shared>,
    run_id: String,
}

#[async_trait]
impl GuestDuplexAcceptor for DuplexAcceptor {
    async fn accept(&self) -> io::Result<AcceptedGuestDuplex> {
        self.shared.ensure_running()?;
        let assignment_cancel = self
            .shared
            .context
            .coordinator
            .guest_rpc_assignment_cancellation(&self.run_id)?;
        let mut stream = tokio::select! {
            biased;
            () = self.shared.closed.cancelled() => return Err(unavailable()),
            () = assignment_cancel.cancelled() => return Err(unavailable()),
            result = tokio::time::timeout(DUPLEX_ACTIVATE_TIMEOUT, async {
                self.shared.duplex.lock().await.recv().await
            }) => result.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Guest duplex unavailable"))?
                .ok_or_else(unavailable)?,
        };
        let guest = tokio::select! {
            biased;
            () = self.shared.closed.cancelled() => return Err(unavailable()),
            () = assignment_cancel.cancelled() => return Err(unavailable()),
            result = tokio::time::timeout(DUPLEX_ACTIVATE_TIMEOUT, self.shared.context.guest.lock()) =>
                result.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Guest control unavailable"))?
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
        tokio::select! {
            biased;
            () = cancelled.cancelled() => return Err(unavailable()),
            () = self.shared.closed.cancelled() => return Err(unavailable()),
            result = tokio::time::timeout(DUPLEX_ACTIVATE_TIMEOUT, stream.write_all(&[ACTIVATE])) =>
                result.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Guest activation timed out"))??,
        }
        Ok(AcceptedGuestDuplex {
            sandbox_id: self.shared.context.sandbox_id.clone(),
            stream: Box::new(ReservedStream {
                stream,
                prefix: None,
                _reservation: reservation,
                read_cancelled: Box::pin(cancelled.clone().cancelled_owned()),
                write_cancelled: Box::pin(cancelled.clone().cancelled_owned()),
            }),
            cancelled,
        })
    }
}

struct ReservedStream {
    stream: UnixStream,
    prefix: Option<u8>,
    _reservation: ExternalOperationReservation,
    read_cancelled: Pin<Box<WaitForCancellationFutureOwned>>,
    write_cancelled: Pin<Box<WaitForCancellationFutureOwned>>,
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
        if buf.remaining() > 0
            && let Some(first) = self.prefix.take()
        {
            buf.put_slice(&[first]);
            return Poll::Ready(Ok(()));
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
        "guest RPC sandbox transport unavailable",
    )
}

#[cfg(test)]
mod guest_duplex_tests;
#[cfg(test)]
mod tests;
