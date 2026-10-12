mod exec_agent_ready;
mod exec_control;
mod exec_control_properties;
mod exec_control_result;
mod exec_output;
mod exec_result;
mod exec_result_properties;
mod exec_start;
mod exec_start_properties;
mod exec_started_cancel;
mod shared;

use crate::error::ProtocolError;

use super::ExecControlNonce;

const NONCE: ExecControlNonce = *b"0123456789abcdef";

fn assert_invalid_payload(err: ProtocolError, expected: &'static str) {
    assert!(matches!(err, ProtocolError::InvalidPayload(msg) if msg == expected));
}
