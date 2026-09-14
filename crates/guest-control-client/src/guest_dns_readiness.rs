use std::io;
use std::time::Duration;

use guest_control_proto::{
    GuestDnsReadinessTermination, MSG_ERROR, MSG_GUEST_DNS_READINESS_RESULT,
    decode_guest_dns_readiness_result, encode_guest_dns_readiness_request_frame_into,
};

use crate::{
    FrameWriteObserver, GuestControlClient,
    normal_request_on_shared_with_write_observer_frame_builder,
};

const TERMINAL_MSG_TYPES: &[u8] = &[MSG_ERROR, MSG_GUEST_DNS_READINESS_RESULT];

/// Owned result of the fixed guest DNS readiness process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuestDnsReadinessResult {
    /// Terminal process state.
    pub termination: GuestDnsReadinessTermination,
    /// Guest-observed operation duration in milliseconds.
    pub duration_ms: u32,
    /// Retained resolver stdout bytes.
    pub answer: Vec<u8>,
    /// Whether resolver stdout or stderr exceeded its retained byte bound, or
    /// output-drain completion could not be confirmed.
    ///
    /// Completion is unproven when either drain's completion notification is not
    /// received before the drain deadline or either drain worker's result cannot
    /// be obtained. Retained output may therefore be incomplete even when `answer`
    /// is short or empty. This flag does not report every cancellation or read
    /// failure.
    pub output_truncated: bool,
    /// Bounded process or internal diagnostic.
    pub diagnostic: String,
}

impl GuestControlClient {
    /// Run the fixed guest DNS readiness resolver command.
    ///
    /// The guest chooses the executable, resolver options, identity, and output
    /// bounds. The caller supplies only the lookup hostname and positive child
    /// timeout. `request_timeout` covers host request encoding/write and the
    /// terminal result wait.
    ///
    /// This is a tracked normal operation. Cancelling or timing out the request
    /// after its write boundary makes the connection non-parkable until it is
    /// closed; guest connection teardown cancels and reaps the child.
    pub async fn guest_dns_readiness(
        &self,
        hostname: &str,
        process_timeout_ms: u32,
        request_timeout: Duration,
    ) -> io::Result<GuestDnsReadinessResult> {
        let response = normal_request_on_shared_with_write_observer_frame_builder(
            &self.shared,
            TERMINAL_MSG_TYPES,
            request_timeout,
            FrameWriteObserver::noop(),
            |seq, frame| {
                encode_guest_dns_readiness_request_frame_into(
                    frame,
                    seq,
                    process_timeout_ms,
                    hostname,
                )
                .map_err(protocol_invalid_input)
            },
        )
        .await?;

        if response.msg_type == MSG_ERROR {
            let message = guest_control_proto::decode_error(&response.payload)
                .map_err(protocol_invalid_data)?;
            return Err(io::Error::other(message.to_owned()));
        }
        if response.msg_type != MSG_GUEST_DNS_READINESS_RESULT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "unexpected guest DNS readiness response type: 0x{:02X}",
                    response.msg_type
                ),
            ));
        }

        let decoded =
            decode_guest_dns_readiness_result(&response.payload).map_err(protocol_invalid_data)?;
        Ok(GuestDnsReadinessResult {
            termination: decoded.termination,
            duration_ms: decoded.duration_ms,
            answer: decoded.answer.to_vec(),
            output_truncated: decoded.output_truncated,
            diagnostic: decoded.diagnostic.to_owned(),
        })
    }
}

fn protocol_invalid_input(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, error.to_string())
}

fn protocol_invalid_data(error: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}
