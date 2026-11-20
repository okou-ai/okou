mod agent_ready;
mod control;
mod output;
mod result;
mod start;
mod started_cancel;

pub use super::process_termination::ExecTermination;

pub use agent_ready::{ExecAgentReadyTiming, decode_exec_agent_ready, encode_exec_agent_ready};
pub use control::{
    DecodedExecControl, DecodedExecControlResult, EXEC_CONTROL_MAX_PAYLOAD_BYTES,
    EXEC_CONTROL_NONCE_LEN, ExecControlNonce, ExecControlStatus, decode_exec_control,
    decode_exec_control_result, encode_exec_control, encode_exec_control_frame_into,
    encode_exec_control_result, validate_exec_control,
};
pub use output::{
    DecodedExecOutput, ExecOutputStream, decode_exec_output, encode_exec_output,
    encode_exec_output_frame_into,
};
pub(crate) use result::encode_exec_result_frame_into_with_prefix;
pub(crate) use result::encode_exec_result_frame_into_with_type;
pub use result::{
    DecodedExecResult, ExecCapturedOutput, decode_exec_result, encode_exec_result,
    encode_exec_result_frame_into,
};
pub use start::{
    DecodedExecStart, ExecControlPolicy, ExecLifecyclePolicy, ExecOutputPolicy, ExecProcessRole,
    ExecStartEncodeRequest, ExecStreamLimits, ExecTimeoutPolicy, MAX_EXEC_STDIN_BYTES,
    decode_exec_start, encode_exec_start, encode_exec_start_with_expected_exit_codes,
    validate_exec_process_contract,
};
pub use started_cancel::{
    DecodedExecStarted, decode_exec_cancel, decode_exec_started, encode_exec_cancel,
    encode_exec_started,
};

#[cfg(test)]
use super::process_termination::TERMINATION_CANCELLED as EXEC_TERMINATION_CANCELLED;
#[cfg(test)]
use crate::error::ProtocolError;
#[cfg(test)]
use start::{
    EXEC_LIFECYCLE_ONE_SHOT, EXEC_OUTPUT_POLICY_CAPTURE, EXEC_OUTPUT_POLICY_DISCARD,
    EXEC_PROCESS_ROLE_AGENT, EXEC_PROCESS_ROLE_WORKLOAD, EXEC_TIMEOUT_DURATION, MAX_EXEC_ENV_VARS,
    MAX_EXEC_EXPECTED_EXIT_CODES,
};

#[cfg(test)]
mod tests;
