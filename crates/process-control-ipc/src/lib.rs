#![deny(missing_docs)]

//! Local process-control IPC channel for a guest operation control sink.
//!
//! This crate defines the local, blocking protocol used after `guest-control-server`
//! exposes an operation-control endpoint and `guest-agent` connects back to it.
//! The control and companion placement channels use Linux abstract Unix stream
//! sockets, so endpoint names are not filesystem paths. Root-owned placement
//! descriptors move with `SCM_RIGHTS` and are never inherited through the
//! sandbox-user launch chain.
//!
//! The endpoint is bootstrapped through [`CANONICAL_BOOTSTRAP_ENV`].
//! `guest-control-server` creates the endpoint name with [`endpoint_name`], binds it with
//! [`bind_abstract_listener`], accepts a single control sink connection, and
//! then drives request/response exchange. `guest-agent` resolves the endpoint
//! name from the environment, connects with [`connect_abstract`], sends a hello
//! frame, then reads requests and writes responses.
//!
//! Two companion placement endpoints are derived from the same operation-local
//! control name. The one-shot runtime endpoint transfers a root-opened
//! `workload/runtime/cgroup.procs` descriptor to Guest Agent, which confirms
//! after validating and adopting it. The tool endpoint serves repeated
//! authenticated Bash-launcher connections: root creates a
//! unique tool cgroup, transfers its write-only `cgroup.procs` descriptor, and
//! acknowledges only after the launcher confirms and root revalidates exact
//! placement. User shell code does not run before that acknowledgement.
//!
//! ## Frame format
//!
//! Every frame uses this envelope:
//!
//! ```text
//! [4B body_len][1B version][1B kind][payload]
//! ```
//!
//! All integer fields are big-endian. `body_len` is the byte length of
//! `[version][kind][payload]`; it does not include the 4-byte `body_len` field.
//! The current version byte is `1`.
//!
//! Frame kinds:
//!
//! | Kind | Name     | Payload |
//! |------|----------|---------|
//! | 0x01 | hello    | empty |
//! | 0x02 | request  | `[2B message_id_len][message_id][4B payload_len][payload]` |
//! | 0x03 | response | `[2B message_id_len][message_id][1B status][2B diagnostic_len][diagnostic]` |
//!
//! Response status values:
//!
//! | Status | Name     | Meaning |
//! |--------|----------|---------|
//! | 0x00   | accepted | sink handled the request |
//! | 0x01   | rejected | sink understood the request but declined it |
//! | 0x02   | error    | sink failed while processing the request |
//! | 0x03   | queue-full | sink is temporarily full; caller may retry |
//!
//! ## Expected sequence
//!
//! ```text
//! guest-control-server: bind_abstract_listener -> accept_with_timeout -> read_hello
//! guest-agent:                         connect_abstract     -> write_hello
//! guest-control-server: write_request
//! guest-agent: read_request -> write_response
//! guest-control-server: read_response
//! ```
//!
//! The request and response exchange can repeat on the connected stream until
//! either endpoint closes it. Message ids are non-empty UTF-8 strings. Request
//! payloads are bounded by [`MAX_CONTROL_PAYLOAD_BYTES`], and response
//! diagnostics are bounded by [`MAX_DIAGNOSTIC_BYTES`].

mod codec;
/// Separate, additive version-one managed-task channel; legacy tool IPC is unchanged.
pub mod managed_task;
mod transport;

pub use codec::{
    read_hello, read_request, read_response, write_hello, write_request, write_response,
};
pub use transport::{
    accept_with_timeout, bind_abstract_listener, connect_abstract, connect_abstract_with_timeout,
    endpoint_name, read_tool_placement_ack, read_tool_placement_confirmation,
    read_workload_placement_confirmation, receive_tool_placement, receive_workload_placement,
    send_tool_placement, send_workload_placement, write_tool_placement_ack,
    write_tool_placement_confirmation, write_workload_placement_confirmation,
};

/// Environment variable carrying the operation-control abstract socket name.
///
/// `guest-control-server` sets this value to the output of [`endpoint_name`] when it
/// starts a guest operation that supports a local control sink. `guest-agent`
/// reads it during startup and connects to that abstract socket. Child agent
/// CLI processes must not inherit this variable.
pub const CANONICAL_BOOTSTRAP_ENV: &str = "OKOU_PROCESS_CONTROL_ENDPOINT";

/// Maximum request payload size carried by a local control request frame.
///
/// [`write_request`] returns `InvalidInput` when a request payload exceeds this
/// limit. [`read_request`] returns `InvalidData` when an incoming request frame
/// declares a payload larger than this limit.
pub const MAX_CONTROL_PAYLOAD_BYTES: usize = 1024 * 1024;

/// Maximum diagnostic string size carried by a local control response frame.
///
/// [`write_response`] returns `InvalidInput` when a response diagnostic exceeds
/// this limit. [`read_response`] returns `InvalidData` when an incoming response
/// frame declares a diagnostic larger than this limit.
pub const MAX_DIAGNOSTIC_BYTES: usize = 8 * 1024;

/// Request forwarded from `guest-control-server` to the connected control sink.
///
/// The request payload is opaque to this crate. This crate only frames it,
/// enforces the payload size limit, and preserves the message id used to match
/// the response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlRequest {
    /// Non-empty UTF-8 message id used to correlate the response.
    ///
    /// On the wire this is encoded as `[2B message_id_len][message_id]`.
    pub message_id: String,

    /// Opaque request payload bytes.
    ///
    /// On the wire this is encoded after the message id as
    /// `[4B payload_len][payload]`.
    pub payload: Vec<u8>,
}

/// Response returned by the connected control sink.
///
/// `guest-control-server` maps this local response into the outer host/guest
/// control-result protocol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlResponse {
    /// Message id copied from the corresponding [`ControlRequest`].
    pub message_id: String,

    /// Local sink outcome.
    pub status: ControlResponseStatus,

    /// Optional diagnostic text for rejected or failed requests.
    ///
    /// The diagnostic may be empty and is bounded by [`MAX_DIAGNOSTIC_BYTES`].
    pub diagnostic: String,
}

/// Local control sink response status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlResponseStatus {
    /// The control sink accepted and handled the request.
    ///
    /// `guest-control-server` maps this to the outer delivered status.
    Accepted,

    /// The control sink understood the request but declined it as an
    /// application-level outcome.
    ///
    /// `guest-control-server` maps this to the outer rejected status without treating
    /// the sink connection as broken.
    Rejected,

    /// The control sink is temporarily full and the caller may retry later.
    ///
    /// `guest-control-server` maps this to the outer queue-full status without treating
    /// the sink connection as broken.
    QueueFull,

    /// The control sink failed while processing the request.
    ///
    /// `guest-control-server` maps this to the outer sink-error status. This status is
    /// distinct from local transport or frame parsing errors, which are
    /// returned as `io::Error` by the read/write helpers.
    Error,
}
