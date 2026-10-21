//! Opt-in infrastructure for dependent real-socket protocol tests.

mod connection_scope;
pub mod request_gate;
pub use connection_scope::ConnectionScope;

use std::io;
use std::time::Duration;

use tokio::net::UnixStream;
use tokio::time::Instant;

use crate::GuestControlClient;

/// Run the production handshake and reader on a caller-owned connected socket.
/// This lets tests configure kernel backpressure before transferring ownership.
pub async fn from_stream(stream: UnixStream, timeout: Duration) -> io::Result<GuestControlClient> {
    let deadline = Instant::now().checked_add(timeout).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "guest connection timeout overflowed",
        )
    })?;
    GuestControlClient::from_stream(stream, deadline).await
}

/// Run the production handshake with explicit sandbox diagnostic attribution.
pub async fn from_stream_for_sandbox(
    stream: UnixStream,
    timeout: Duration,
    sandbox_id: &str,
) -> io::Result<GuestControlClient> {
    let deadline = Instant::now().checked_add(timeout).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "guest connection timeout overflowed",
        )
    })?;
    GuestControlClient::from_stream_for_sandbox(stream, deadline, sandbox_id).await
}
