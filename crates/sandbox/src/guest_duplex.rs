//! Private, assignment-bound opaque Guest transport (not Guest RPC or exec control).

use std::io;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::sync::CancellationToken;

/// A provider-owned byte stream. The reservation is retained until the stream is dropped.
pub trait GuestDuplexStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> GuestDuplexStream for T {}

/// Only the provider may supply this identity and cancellation epoch.
pub struct AcceptedGuestDuplex {
    pub sandbox_id: String,
    pub stream: Box<dyn GuestDuplexStream>,
    pub cancelled: CancellationToken,
}

/// Capability for an exact live assignment, never a path or sandbox ID from a client.
#[async_trait]
pub trait GuestDuplexAcceptor: Send + Sync {
    async fn accept(&self) -> io::Result<AcceptedGuestDuplex>;
}
