use std::fmt;
use std::io;
use std::sync::Arc;

use sandbox::{CancelledOperationOwner, OperationCancellationContext};
use uuid::Uuid;

/// First observed origin of transport invalidation, independent of Run status.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionCloseReason {
    PeerClosed,
    ReadError(io::ErrorKind),
    ProtocolError,
    DispatchError(io::ErrorKind),
    ClientDropped,
    FrameWriteAbandoned,
    FrameWriteError(io::ErrorKind),
    FileTransferAbandoned,
    FileTransferError(io::ErrorKind),
    ExecWaitTimeout,
    StartCancelWriteTimeout,
    UnclassifiedPoison,
}

impl ConnectionCloseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PeerClosed => "peer_closed",
            Self::ReadError(_) => "read_error",
            Self::ProtocolError => "protocol_error",
            Self::DispatchError(_) => "dispatch_error",
            Self::ClientDropped => "client_dropped",
            Self::FrameWriteAbandoned => "frame_write_abandoned",
            Self::FrameWriteError(_) => "frame_write_error",
            Self::FileTransferAbandoned => "file_transfer_abandoned",
            Self::FileTransferError(_) => "file_transfer_error",
            Self::ExecWaitTimeout => "exec_wait_timeout",
            Self::StartCancelWriteTimeout => "start_cancel_write_timeout",
            Self::UnclassifiedPoison => "unclassified_poison",
        }
    }

    pub fn error_kind(self) -> Option<io::ErrorKind> {
        match self {
            Self::ReadError(kind)
            | Self::DispatchError(kind)
            | Self::FrameWriteError(kind)
            | Self::FileTransferError(kind) => Some(kind),
            _ => None,
        }
    }
}

/// Immutable facts recorded by the first Connected-to-Closed transition.
#[derive(Debug)]
pub struct ConnectionCloseInfo {
    connection_id: Uuid,
    sandbox_id: Option<String>,
    reason: ConnectionCloseReason,
    cancelled_owner: Option<CancelledOperationOwner>,
}

impl ConnectionCloseInfo {
    pub(super) fn new(
        connection_id: Uuid,
        sandbox_id: Option<&str>,
        reason: ConnectionCloseReason,
        owner: Option<&OperationCancellationContext>,
    ) -> Self {
        // Only an unfinished future, abandoned by its actual owner, can supply
        // expected-cancellation evidence. Errors and unwind remain conservative.
        let cancelled_owner = matches!(
            reason,
            ConnectionCloseReason::FrameWriteAbandoned
                | ConnectionCloseReason::FileTransferAbandoned
        )
        .then(|| owner.and_then(OperationCancellationContext::cancelled_owner))
        .flatten()
        .filter(|owner| !std::thread::panicking() && sandbox_id == Some(owner.sandbox_id()));
        Self {
            connection_id,
            sandbox_id: sandbox_id.map(str::to_owned),
            reason,
            cancelled_owner,
        }
    }

    pub fn connection_id(&self) -> Uuid {
        self.connection_id
    }

    pub fn sandbox_id(&self) -> Option<&str> {
        self.sandbox_id.as_deref()
    }

    pub fn reason(&self) -> ConnectionCloseReason {
        self.reason
    }

    pub fn cancelled_owner(&self) -> Option<&CancelledOperationOwner> {
        self.cancelled_owner.as_ref()
    }
}

/// Initial request registration rejected an already-closed transport.
///
/// This marker is never produced from a later response-channel or write failure.
/// A shutdown caller can distinguish a non-admitted request without interpreting
/// error text or inspecting transport state after its request failed.
#[derive(Debug)]
pub struct ConnectionClosedAtAdmission {
    close: Arc<ConnectionCloseInfo>,
}

impl ConnectionClosedAtAdmission {
    pub(super) fn into_io_error(close: Arc<ConnectionCloseInfo>) -> io::Error {
        io::Error::new(io::ErrorKind::ConnectionReset, Self { close })
    }

    pub fn from_error(error: &io::Error) -> Option<&Self> {
        error.get_ref()?.downcast_ref()
    }

    pub fn close_info(&self) -> &ConnectionCloseInfo {
        &self.close
    }
}

impl fmt::Display for ConnectionClosedAtAdmission {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("connection closed")
    }
}

impl std::error::Error for ConnectionClosedAtAdmission {}
