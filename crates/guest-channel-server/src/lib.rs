//! Native application peer over an already admitted private Guest stream.
//! The packaged composition owner starts [`run`] only after fork and activation.
//! This library grants no Run authority and never reconnects or replays work.

mod connection;
mod diagnostics;
mod filesystem;
mod io;

use std::{future::Future, pin::Pin, sync::Arc};

pub use api_contracts::generated::types::sandbox_channel::diagnostics::{Echo, Notice};
pub use connection::Peer;
pub use diagnostics::Diagnostics;
pub use filesystem::Filesystem;
pub use guest_contracts::sandbox_channel::{Categories, ChannelError, Operation, Params};
use serde_json::Value;

/// An owned, cancellation-safe service future. Physical work must retain its
/// own resources if it can outlive cancellation of this async observation.
pub type ServiceFuture<T> = Pin<Box<dyn Future<Output = Result<T, Error>> + Send>>;

/// Safe business failures; no exception, path or payload text is accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// Rejection by the shared schema/category/operation validator.
    Contract(ChannelError),
    /// A finite work, pending-call or writer budget is full.
    Busy,
    /// The owned ordinary-call/work deadline elapsed.
    TimedOut,
    /// The connection or service is unavailable.
    Unavailable,
    /// A path is outside the captured home boundary.
    OutsideHome,
    /// The requested directory no longer exists.
    NotFound,
    /// The requested entry is not a directory.
    NotDirectory,
    /// Links cannot be expanded.
    LinkNotExpandable,
    /// A mount boundary cannot be expanded.
    MountNotExpandable,
    /// The observed directory changed and requires refresh.
    DirectoryChanged,
    /// The owned cursor expired.
    CursorExpired,
    /// The requested entry is not a regular file.
    NotRegularFile,
    /// The observed file identity or content stamps changed.
    FileChanged,
    /// The connection-owned reader was released or expired.
    HandleExpired,
}

impl Error {
    /// Bounded wire code, independent of external exception text.
    pub const fn code(self) -> &'static str {
        match self {
            Self::Contract(error) => error.code(),
            Self::Busy => "busy",
            Self::TimedOut => "unavailable",
            Self::Unavailable => "unavailable",
            Self::OutsideHome => "outside_home",
            Self::NotFound => "not_found",
            Self::NotDirectory => "not_directory",
            Self::LinkNotExpandable => "link_not_expandable",
            Self::MountNotExpandable => "mount_not_expandable",
            Self::DirectoryChanged => "directory_changed",
            Self::CursorExpired => "cursor_expired",
            Self::NotRegularFile => "not_regular_file",
            Self::FileChanged => "file_changed",
            Self::HandleExpired => "handle_expired",
        }
    }
}
impl From<ChannelError> for Error {
    fn from(error: ChannelError) -> Self {
        Self::Contract(error)
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for Error {}

/// Redacted local event rejection. Events have no response or delivery promise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventError {
    /// Validated, bounded category name.
    pub category: String,
    /// Validated, bounded event name.
    pub event: String,
    /// Safe local failure.
    pub error: Error,
}

/// Complete installed Guest roles, immutable for this connection.
/// Advertise a category only when every Guest operation/event in it is served.
/// The peer validates params before dispatch and results before emission.
pub trait Service: Send + Sync + 'static {
    /// The complete installed role revisions, captured before ACTIVATED/hello.
    fn categories(&self) -> Categories;
    /// Execute a validated incoming operation without blocking the reader.
    fn request(&self, operation: Operation, params: Params, peer: Peer) -> ServiceFuture<Value>;
    /// Consume a validated one-way notice. Do not acknowledge or echo notices.
    fn notice(&self, notice: Notice, peer: Peer) -> ServiceFuture<()>;
    /// Synchronous redacted observation. A panicking observer is retired.
    fn event_error(&self, _error: EventError) {}
}

/// Run an admitted stream on a runtime created in its post-fork worker.
/// Returning means all connection tasks and the physical descriptor are retired.
pub fn run(stream: std::os::unix::net::UnixStream) -> std::io::Result<()> {
    run_service(stream, Arc::new(Diagnostics))
}

/// Run the complete diagnostics/fs roles using the Guest's fixed post-fork worker.
pub fn run_with_filesystem(
    stream: std::os::unix::net::UnixStream,
    filesystem: &Filesystem,
) -> std::io::Result<()> {
    run_service(stream, filesystem.service())
}

fn run_service(
    stream: std::os::unix::net::UnixStream,
    service: Arc<dyn Service>,
) -> std::io::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()?;
    runtime.block_on(async {
        let stream = io::FdStream::new(stream)?;
        serve(stream, service).await
    })
}

/// Serve one already admitted byte stream, including its ACTIVATED marker.
/// The caller owns admission and must retain its stream permit through return.
/// All IO is nonblocking and all spawned work is joined before return.
pub async fn serve<T>(stream: T, service: Arc<dyn Service>) -> std::io::Result<()>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    connection::serve(stream, service).await
}
