//! Sandbox-owned dedicated guest listener. There is no production method handler.

use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use guest_control_client::GuestControlClient;
use sandbox::{AcceptedGuestRpc, GuestRpcAcceptor};
use tokio::net::UnixListener;
use tokio_util::sync::CancellationToken;

use crate::guest_endpoint_operations::{EndpointOperations, ReservedStream};
use crate::park_coordinator::ParkCoordinator;
use crate::runtime_dirs::set_private_runtime_socket_mode;
use crate::sandbox::SandboxState;

pub(crate) struct GuestRpcContext {
    pub(crate) sandbox_id: String,
    pub(crate) state: Arc<AtomicU8>,
    pub(crate) guest: Arc<tokio::sync::Mutex<Option<Arc<GuestControlClient>>>>,
    pub(crate) coordinator: ParkCoordinator,
}

struct Shared {
    listener: Mutex<Option<Arc<UnixListener>>>,
    active: EndpointOperations,
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
        self.active.cancel();
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
        let shared = Arc::new(Shared {
            listener: Mutex::new(Some(Arc::new(listener))),
            active: EndpointOperations::default(),
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

    pub(crate) fn acceptor(&self, run_id: &str) -> Arc<dyn GuestRpcAcceptor> {
        Arc::new(Acceptor {
            shared: Arc::clone(&self.shared),
            run_id: run_id.to_owned(),
        })
    }
}

impl Drop for GuestRpcEndpoint {
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
impl GuestRpcAcceptor for Acceptor {
    async fn accept(&self) -> io::Result<AcceptedGuestRpc> {
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
        let (stream, _) = tokio::select! {
            biased;
            () = self.shared.closed.cancelled() => return Err(unavailable()),
            () = assignment_cancel.cancelled() => return Err(unavailable()),
            result = listener.accept() => result?,
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
        let operation = Arc::new(cancelled);
        self.shared.active.track(&operation, &self.shared.closed);
        if operation.is_cancelled() || self.shared.ensure_running().is_err() {
            return Err(unavailable());
        }
        Ok(AcceptedGuestRpc {
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
        "guest RPC sandbox transport unavailable",
    )
}

#[cfg(test)]
mod tests;
