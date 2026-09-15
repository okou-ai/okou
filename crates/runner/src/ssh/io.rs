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

pub(super) type GuestIo = Box<dyn GuestRpcStream>;

/// Physical work remains bounded while an idle socket releases its old operation.
pub(super) struct HostLease {
    operation: Mutex<Option<Arc<OwnedSemaphorePermit>>>,
    _transport: OwnedSemaphorePermit,
}

impl HostLease {
    pub(super) fn new(
        operation: Arc<OwnedSemaphorePermit>,
        transport: OwnedSemaphorePermit,
    ) -> Arc<Self> {
        Arc::new(Self {
            operation: Mutex::new(Some(operation)),
            _transport: transport,
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
    stream: tokio::net::TcpStream,
    _lease: Arc<HostLease>,
}

pub(super) struct SocketGuard(std::net::TcpStream);

impl SshSocket {
    pub(super) fn new(
        stream: tokio::net::TcpStream,
        lease: Arc<HostLease>,
    ) -> io::Result<(Self, SocketGuard)> {
        let stream = stream.into_std()?;
        let guard = SocketGuard(stream.try_clone()?);
        let stream = tokio::net::TcpStream::from_std(stream)?;
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
        self.0.set_nodelay(true)
    }

    pub(super) fn close(&self) {
        let _ = self.0.shutdown(std::net::Shutdown::Both);
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
        Pin::new(&mut self.get_mut().stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for SshSocket {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().stream).poll_write(cx, bytes)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }
}
