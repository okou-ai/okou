//! Dedicated, private Guest-initiated vsock endpoint for opaque duplex frames.
//! Its listener and admission queue are independent of one-shot Guest RPC.

use std::io;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use guest_contracts::private_duplex::{ACTIVATE, READY};
use sandbox::{AcceptedGuestDuplex, GuestDuplexAcceptor};
use tokio::io::AsyncWriteExt;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::guest_endpoint_operations::{EndpointOperations, GuestEndpointContext, ReservedStream};
use crate::runtime_dirs::set_private_runtime_socket_mode;
use crate::sandbox::SandboxState;

const ATTACH_TIMEOUT: Duration = Duration::from_secs(2);
const INGRESS_ACK_TIMEOUT: Duration = Duration::from_secs(2);

struct Shared {
    listener: Mutex<Option<Arc<UnixListener>>>,
    pending: tokio::sync::Mutex<mpsc::Receiver<UnixStream>>,
    active: EndpointOperations,
    path: PathBuf,
    closed: CancellationToken,
    context: GuestEndpointContext,
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
        self.active.cancel();
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

/// Sole close/unlink owner; old acceptors cannot extend a listener epoch.
pub(crate) struct Endpoint {
    shared: Arc<Shared>,
    ingress: tokio::task::JoinHandle<()>,
    // Must finish after close, including when an old acceptor retains Shared.
    _drain: tokio::task::JoinHandle<()>,
    cleanup: tokio::task::JoinHandle<()>,
}

impl Endpoint {
    pub(crate) fn bind(
        path: PathBuf,
        context: GuestEndpointContext,
        runtime_cancel: CancellationToken,
    ) -> io::Result<Self> {
        // The parent is the validated private 0700 sandbox vsock directory.
        // Never remove an existing entry: another bind owner may hold it.
        let listener = UnixListener::bind(&path)?;
        let (pending_tx, pending_rx) = mpsc::channel(1);
        let shared = Arc::new(Shared {
            listener: Mutex::new(Some(Arc::new(listener))),
            pending: tokio::sync::Mutex::new(pending_rx),
            active: EndpointOperations::default(),
            path,
            closed: CancellationToken::new(),
            context,
        });
        if let Err(error) = set_private_runtime_socket_mode(&shared.path) {
            shared.close();
            return Err(error);
        }
        let ingress = tokio::spawn(accept_candidates(Arc::clone(&shared), pending_tx));
        // A retained old acceptor can keep Shared alive across park. Drain its
        // acknowledged idle socket immediately when the endpoint closes.
        let drain_shared = Arc::clone(&shared);
        let drain = tokio::spawn(async move {
            drain_shared.closed.cancelled().await;
            let mut pending = drain_shared.pending.lock().await;
            pending.close();
            while pending.try_recv().is_ok() {}
        });
        let cleanup_shared = Arc::clone(&shared);
        let cleanup = tokio::spawn(async move {
            runtime_cancel.cancelled().await;
            cleanup_shared.close();
        });
        Ok(Self {
            shared,
            ingress,
            _drain: drain,
            cleanup,
        })
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
        self.ingress.abort();
        self.cleanup.abort();
        // Do not abort drain: it closes an idle socket even when a stale
        // acceptor keeps the receiver alive after this Endpoint is dropped.
    }
}

/// One pending connector at most. READY only acknowledges queue capacity;
/// exact-run authority is checked later, immediately before ACTIVATE.
async fn accept_candidates(shared: Arc<Shared>, pending: mpsc::Sender<UnixStream>) {
    let listener = shared
        .listener
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .cloned();
    let Some(listener) = listener else { return };
    loop {
        let accepted = tokio::select! {
            biased;
            () = shared.closed.cancelled() => break,
            result = listener.accept() => result,
        };
        let Ok((mut stream, _)) = accepted else { break };
        let Ok(slot) = pending.try_reserve() else {
            continue;
        };
        let acknowledged = tokio::select! {
            biased;
            () = shared.closed.cancelled() => false,
            result = tokio::time::timeout(INGRESS_ACK_TIMEOUT, stream.write_all(&[READY])) =>
                matches!(result, Ok(Ok(()))),
        };
        if acknowledged && !shared.closed.is_cancelled() {
            slot.send(stream);
        }
    }
    shared.close();
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
            .guest_assignment_cancellation(&self.run_id)?;
        let mut stream = tokio::select! {
            biased;
            () = self.shared.closed.cancelled() => return Err(unavailable()),
            () = assignment_cancel.cancelled() => return Err(unavailable()),
            result = tokio::time::timeout(ATTACH_TIMEOUT, async {
                self.shared.pending.lock().await.recv().await
            }) => result.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Guest duplex unavailable"))?
                .ok_or_else(unavailable)?,
        };
        let guest = tokio::select! {
            biased;
            () = self.shared.closed.cancelled() => return Err(unavailable()),
            () = assignment_cancel.cancelled() => return Err(unavailable()),
            result = tokio::time::timeout(ATTACH_TIMEOUT, self.shared.context.guest.lock()) =>
                result.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Guest control unavailable"))?
                    .as_ref().cloned().ok_or_else(unavailable)?,
        };
        self.shared.ensure_running()?;
        let (reservation, cancelled) = self
            .shared
            .context
            .coordinator
            .reserve_guest_operation(&self.run_id, &guest)?;
        let operation = Arc::new(cancelled);
        self.shared.active.track(&operation, &self.shared.closed);
        if operation.is_cancelled() || self.shared.ensure_running().is_err() {
            return Err(unavailable());
        }
        tokio::select! {
            biased;
            () = operation.cancelled() => return Err(unavailable()),
            () = self.shared.closed.cancelled() => return Err(unavailable()),
            result = tokio::time::timeout(ATTACH_TIMEOUT, stream.write_all(&[ACTIVATE])) =>
                result.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Guest activation timed out"))??,
        }
        Ok(AcceptedGuestDuplex {
            sandbox_id: self.shared.context.sandbox_id.clone(),
            stream: Box::new(ReservedStream::new(
                stream,
                reservation,
                Arc::clone(&operation),
            )),
            cancelled: operation.as_ref().clone(),
        })
    }
}

fn unavailable() -> io::Error {
    io::Error::new(
        io::ErrorKind::NotConnected,
        "guest duplex transport unavailable",
    )
}

#[cfg(test)]
mod tests;
