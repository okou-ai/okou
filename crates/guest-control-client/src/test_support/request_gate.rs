//! Invocation-owned controls over one real Guest request and its terminal frame.
//!
//! Supply two already-connected streams, retain both returned producer owners,
//! and arm once before invoking the operation. Capture precedes dispatch; only
//! the actual peer's terminal frame establishes transport completion. Neither is
//! proof of helper execution, Guest readiness, data saving or safe reuse.
//!
//! Join the selected exchange before reconciliation while retaining the entire
//! connection until real peer teardown. Cancelled join borrows retain their
//! receiver/task. Dropping a producer never aborts it, but detachment is not a
//! positive join. Lost controllers release holds without aborting dispatched
//! work. No socket paths, production tracker state or timeouts are changed.

mod framing;
mod relay;
mod writing;

use std::fmt;
use std::io;
use std::sync::{Arc, Mutex};

use guest_control_proto::{
    MSG_ERROR, MSG_EXEC_RESULT, MSG_EXEC_START, MSG_GUEST_STATE_RESTORE,
    MSG_GUEST_STATE_RESTORE_RESULT, MSG_OPERATIONS_QUIESCED, MSG_QUIESCE_OPERATIONS,
};
use tokio::net::UnixStream;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// The production request/terminal authority selected by this invocation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequestKind {
    /// Fixed bundled state restore RPC, not generic exec.
    GuestStateRestore,
    /// Exec start/result, including fenced one-shot final preparation.
    /// Valid supervised/streaming intermediate frames continue normally.
    Exec,
    /// Guest admission fence; an error terminal may mean Busy, not readiness.
    Quiesce,
}

impl RequestKind {
    fn request_type(self) -> u8 {
        match self {
            Self::GuestStateRestore => MSG_GUEST_STATE_RESTORE,
            Self::Exec => MSG_EXEC_START,
            Self::Quiesce => MSG_QUIESCE_OPERATIONS,
        }
    }

    fn terminal_type(self, message_type: u8) -> bool {
        message_type == MSG_ERROR
            || message_type
                == match self {
                    Self::GuestStateRestore => MSG_GUEST_STATE_RESTORE_RESULT,
                    Self::Exec => MSG_EXEC_RESULT,
                    Self::Quiesce => MSG_OPERATIONS_QUIESCED,
                }
    }
}

/// One complete original bounded wire frame, shared without copying payloads.
#[derive(Clone, Eq, PartialEq)]
pub struct Frame {
    message_type: u8,
    sequence: u32,
    bytes: Arc<[u8]>,
}

impl Frame {
    /// Actual peer-supplied message type.
    pub fn message_type(&self) -> u8 {
        self.message_type
    }

    /// Actual peer-supplied sequence, never replaced by the relay.
    pub fn sequence(&self) -> u32 {
        self.sequence
    }

    /// Original length prefix, type, sequence and payload, forwarded unchanged.
    pub fn raw(&self) -> &[u8] {
        &self.bytes
    }
}

impl fmt::Debug for Frame {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Frame")
            .field("message_type", &self.message_type)
            .field("sequence", &self.sequence)
            .field("bytes", &self.bytes.len())
            .finish()
    }
}

/// Actual terminal transport and successful delivery, not operation success.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Exchange {
    /// Original selected request forwarded to the actual Guest peer.
    pub request: Frame,
    /// Original matching terminal, which may be MSG_ERROR.
    pub response: Frame,
}

/// A fixture-only fault at original response delivery, never a Guest failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResponseDisposition {
    /// Write the original terminal frame normally.
    Deliver,
    /// Unwind the relay only after the original terminal was written successfully.
    UnwindAfterDelivery,
}

enum ArmState {
    Waiting,
    Armed(RequestKind),
    Captured,
}

/// One-shot observation/release controls; losing these does not abort work.
pub struct Controls {
    arm: Arc<Mutex<ArmState>>,
    /// Complete selected request before any of its bytes reach the Guest.
    pub captured: oneshot::Receiver<Frame>,
    /// Forward the held original request. Losing this sender also forwards it.
    pub dispatch: oneshot::Sender<()>,
    /// Actual matching terminal before its bytes reach the original Host reader.
    pub response: oneshot::Receiver<Frame>,
    /// Deliver the held original terminal; losing this sender delivers normally.
    pub delivery: oneshot::Sender<ResponseDisposition>,
}

impl Controls {
    /// Select once, before invoking the intended public operation.
    pub fn arm(&mut self, kind: RequestKind) -> io::Result<()> {
        let mut state = self
            .arm
            .lock()
            .map_err(|_| io::Error::other("Guest request gate arm poisoned"))?;
        if !matches!(*state, ArmState::Waiting) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "Guest request gate is already armed or consumed",
            ));
        }
        *state = ArmState::Armed(kind);
        Ok(())
    }
}

/// Own the selected terminal/delivery result outside borrowed observations.
#[must_use = "join the exchange or retain it with unresolved native ownership"]
pub struct ExchangeProducer {
    result: Option<oneshot::Receiver<io::Result<Exchange>>>,
}

impl ExchangeProducer {
    /// Join once without consuming the receiver while Pending.
    pub async fn join(&mut self) -> io::Result<Exchange> {
        let result = self
            .result
            .as_mut()
            .ok_or_else(|| io::Error::other("Guest exchange already joined"))?
            .await;
        self.result = None;
        result.map_err(|_| io::Error::other("Guest relay ended without a joined exchange"))?
    }
}

/// Own the entire duplex transport independently of the selected exchange.
#[must_use = "join the connection or retain it with unresolved native ownership"]
pub struct ConnectionProducer {
    task: Option<JoinHandle<io::Result<()>>>,
}

impl ConnectionProducer {
    /// Join actual peer teardown; cancellation leaves the same task here.
    /// A relay panic is retained as the io::Error's JoinError source.
    pub async fn join(&mut self) -> io::Result<()> {
        let result = self
            .task
            .as_mut()
            .ok_or_else(|| io::Error::other("Guest connection already joined"))?
            .await;
        self.task = None;
        result.map_err(io::Error::other)?
    }
}

/// Relay a caller-owned Host/Guest connection; does not adopt any live socket.
///
/// Unrelated frames keep flowing at both holds. Host EOF does not close the
/// Guest stream: accepted real work is drained until its own terminal/peer end.
/// A Host framing/read failure before terminal delivery retains that work, while
/// both producer joins report the transport failure after draining it.
/// The owner must retain this connection and native capsule if teardown stalls.
pub fn gate_connection(
    host: UnixStream,
    guest: UnixStream,
) -> (Controls, ExchangeProducer, ConnectionProducer) {
    relay::start(host, guest)
}
