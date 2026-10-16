//! Host work retains capacity independently of guest I/O and its park reservation.

use sandbox::GuestRpcStream;
use std::{
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    sync::OwnedSemaphorePermit,
};
use tokio_util::sync::{CancellationToken, DropGuard};

pub(super) type GuestIo = Box<dyn GuestRpcStream>;

/// Physical work remains bounded while an idle socket releases its old operation.
pub(super) struct HostLease {
    operation: Mutex<Option<Arc<OwnedSemaphorePermit>>>,
    _transport: OwnedSemaphorePermit,
    pub(super) closed: CancellationToken,
    // Last field: signal only after operation/physical permits have been released.
    _completion: DropGuard,
}

impl HostLease {
    pub(super) fn new(
        operation: Arc<OwnedSemaphorePermit>,
        transport: OwnedSemaphorePermit,
    ) -> Arc<Self> {
        let closed = CancellationToken::new();
        Arc::new(Self {
            operation: Mutex::new(Some(operation)),
            _transport: transport,
            _completion: closed.clone().drop_guard(),
            closed,
        })
    }

    pub(super) fn idle(&self) {
        self.operation
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
    }

    pub(super) fn activate(
        &self,
        operation: Arc<OwnedSemaphorePermit>,
    ) -> Result<(), super::FailureReason> {
        let mut current = self.operation.lock().unwrap_or_else(|p| p.into_inner());
        if current.is_some() {
            return Err(super::FailureReason::Protocol);
        }
        *current = Some(operation);
        Ok(())
    }
}

pub(super) struct SshSocket {
    stream: Carrier,
    _lease: Arc<HostLease>,
}

pub(super) enum Carrier {
    Public(tokio::net::TcpStream),
    Native {
        stream: crate::tailscale::Stream,
        _node: Arc<crate::tailscale::Node>,
    },
}

pub(super) enum SocketGuard {
    Public(std::net::TcpStream),
    Native(tokio_util::sync::CancellationToken),
}

impl SshSocket {
    pub(super) fn new(stream: Carrier, lease: Arc<HostLease>) -> io::Result<(Self, SocketGuard)> {
        let (stream, guard) = match stream {
            Carrier::Public(stream) => {
                let stream = stream.into_std()?;
                let guard = SocketGuard::Public(stream.try_clone()?);
                (
                    Carrier::Public(tokio::net::TcpStream::from_std(stream)?),
                    guard,
                )
            }
            Carrier::Native { stream, _node } => {
                let guard = SocketGuard::Native(stream.cancelled());
                (Carrier::Native { stream, _node }, guard)
            }
        };
        Ok((
            Self {
                stream,
                _lease: lease,
            },
            guard,
        ))
    }
}

impl SocketGuard {
    pub(super) fn enable_nodelay(&self) -> io::Result<()> {
        match self {
            Self::Public(stream) => stream.set_nodelay(true),
            Self::Native(_) => Ok(()),
        }
    }

    pub(super) fn close(&self) {
        match self {
            Self::Public(stream) => {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
            Self::Native(cancelled) => cancelled.cancel(),
        }
    }
}

impl Drop for SocketGuard {
    fn drop(&mut self) {
        self.close();
    }
}

impl AsyncRead for SshSocket {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match &mut self.get_mut().stream {
            Carrier::Public(stream) => Pin::new(stream).poll_read(cx, buf),
            Carrier::Native { stream, .. } => Pin::new(stream).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for SshSocket {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        match &mut self.get_mut().stream {
            Carrier::Public(stream) => Pin::new(stream).poll_write(cx, bytes),
            Carrier::Native { stream, .. } => Pin::new(stream).poll_write(cx, bytes),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut self.get_mut().stream {
            Carrier::Public(stream) => Pin::new(stream).poll_flush(cx),
            Carrier::Native { stream, .. } => Pin::new(stream).poll_flush(cx),
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut self.get_mut().stream {
            Carrier::Public(stream) => Pin::new(stream).poll_shutdown(cx),
            Carrier::Native { stream, .. } => Pin::new(stream).poll_shutdown(cx),
        }
    }
}
