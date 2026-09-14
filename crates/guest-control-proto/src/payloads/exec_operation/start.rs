use crate::error::ProtocolError;
use crate::read::{
    checked_payload_len_add, ensure_payload_fits_message, ensure_u16_count, ensure_u16_len,
    ensure_u32_count, ensure_u32_len, expect_consumed, read_i32, read_slice, read_str, read_u8,
    read_u16, read_u32,
};
use crate::wire::EXEC_FLAG_SUDO;

use super::control::{EXEC_CONTROL_NONCE_LEN, ExecControlNonce};

pub(super) const EXEC_OUTPUT_POLICY_DISCARD: u8 = 0x00;
pub(super) const EXEC_OUTPUT_POLICY_CAPTURE: u8 = 0x01;
pub(super) const EXEC_OUTPUT_POLICY_STREAM: u8 = 0x02;
pub(super) const EXEC_OUTPUT_POLICY_CAPTURE_AND_STREAM: u8 = 0x03;

pub(super) const EXEC_LIFECYCLE_ONE_SHOT: u8 = 0x00;
pub(super) const EXEC_LIFECYCLE_SUPERVISED: u8 = 0x01;

pub(super) const EXEC_PROCESS_ROLE_WORKLOAD: u8 = 0x00;
pub(super) const EXEC_PROCESS_ROLE_AGENT: u8 = 0x01;
pub(super) const EXEC_PROCESS_ROLE_SESSION_HISTORY_IDENTITY_VERIFIER: u8 = 0x02;
pub(super) const EXEC_PROCESS_ROLE_CODEX_SESSION_CLEANUP: u8 = 0x03;

pub(super) const EXEC_TIMEOUT_DURATION: u8 = 0x00;
pub(super) const EXEC_TIMEOUT_NONE: u8 = 0x01;

pub(super) const EXEC_CONTROL_DISABLED: u8 = 0x00;
pub(super) const EXEC_CONTROL_ENABLED: u8 = 0x01;
pub(super) const EXEC_CONTROL_FLAG_SINK: u8 = 0x01;

pub(super) const EXEC_STDIN_NONE: u8 = 0x00;
pub(super) const EXEC_STDIN_BYTES: u8 = 0x01;

pub(super) const MAX_EXEC_ENV_VARS: usize = 4096;
pub(super) const MAX_EXEC_EXPECTED_EXIT_CODES: usize = 64;

/// Maximum bounded stdin payload accepted by an exec_start request.
pub const MAX_EXEC_STDIN_BYTES: usize = 64 * 1024;

/// Exec stdout/stderr handling policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecOutputPolicy {
    /// Drop this stream without retaining or emitting bytes.
    Discard,
    /// Retain at most `limit_bytes` bytes in the final exec result.
    ///
    /// A zero limit is valid and means captured output is intentionally empty.
    Capture {
        /// Maximum retained bytes for this stream.
        limit_bytes: u32,
    },
    /// Emit output chunks to the host up to `limit_bytes` total bytes.
    ///
    /// A zero stream limit is valid and means no chunks should be emitted.
    /// `chunk_limit_bytes` must be non-zero.
    Stream {
        /// Maximum emitted bytes for this stream.
        limit_bytes: u32,
        /// Maximum bytes per emitted output chunk.
        chunk_limit_bytes: u32,
    },
    /// Retain output in the final result and also emit output chunks.
    ///
    /// Zero capture or stream limits are valid. `chunk_limit_bytes` must be
    /// non-zero.
    CaptureAndStream {
        /// Maximum retained bytes for this stream in the final exec result.
        capture_limit_bytes: u32,
        /// Maximum emitted bytes for this stream.
        stream_limit_bytes: u32,
        /// Maximum bytes per emitted output chunk.
        chunk_limit_bytes: u32,
    },
}

/// Exec process lifecycle policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecLifecyclePolicy {
    /// Run a command to completion and report one terminal result.
    OneShot,
    /// Start a long-running process that will acknowledge its pid.
    Supervised,
}

/// Semantic role of a process started through the exec transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecProcessRole {
    /// Ordinary contained workload.
    Workload,
    /// Controlled guest Agent operation.
    Agent,
    /// Fixed one-shot session-history identity verifier.
    SessionHistoryIdentityVerifier,
    /// Fixed one-shot reused-Codex session cleanup helper.
    CodexSessionCleanup,
}

impl ExecProcessRole {
    /// Stable process-class label used by host and guest exec diagnostics.
    pub const fn process_class(self) -> &'static str {
        match self {
            Self::Workload => "contained_workload",
            Self::Agent => "controlled_agent",
            Self::SessionHistoryIdentityVerifier => "session_history_identity_verifier",
            Self::CodexSessionCleanup => "codex_session_cleanup",
        }
    }

    /// Stable operation-kind label used by host and guest exec diagnostics.
    ///
    /// Unsupported role/lifecycle combinations retain the `invalid` label.
    /// This classification does not validate the process contract; admission
    /// must still use [`validate_exec_process_contract`].
    pub const fn operation_kind(self, lifecycle: ExecLifecyclePolicy) -> &'static str {
        match (self, lifecycle) {
            (Self::Workload, ExecLifecyclePolicy::OneShot) => "exec",
            (Self::Workload, ExecLifecyclePolicy::Supervised) => "start_process",
            (Self::Agent, ExecLifecyclePolicy::Supervised) => "start_agent_process",
            (Self::Agent, ExecLifecyclePolicy::OneShot) => "invalid",
            (Self::SessionHistoryIdentityVerifier, ExecLifecyclePolicy::OneShot) => {
                "verify_session_history_identity"
            }
            (Self::SessionHistoryIdentityVerifier, ExecLifecyclePolicy::Supervised) => "invalid",
            (Self::CodexSessionCleanup, ExecLifecyclePolicy::OneShot) => "cleanup_codex_session",
            (Self::CodexSessionCleanup, ExecLifecyclePolicy::Supervised) => "invalid",
        }
    }
}

/// Exec timeout policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecTimeoutPolicy {
    /// Kill the operation after `timeout_ms`.
    Duration {
        /// Positive timeout in milliseconds.
        timeout_ms: u32,
    },
    /// Do not apply a protocol-level timeout.
    None,
}

/// Exec control channel policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecControlPolicy {
    /// Do not enable exec control messages for this operation.
    Disabled,
    /// Enable exec control messages using a per-operation nonce.
    Enabled {
        /// Per-operation nonce registered with the exec operation.
        control_nonce: ExecControlNonce,
        /// Whether the guest should expose a local sink for exec control.
        sink: bool,
    },
}

/// Parameters for encoding an exec_start payload with extended metadata.
///
/// # Process contract
///
/// The `lifecycle`, `role`, and `control` fields form one semantic contract. The
/// following combinations are accepted:
///
/// | Role | Lifecycle | Control | Meaning |
/// | --- | --- | --- | --- |
/// | [`ExecProcessRole::Workload`] | [`ExecLifecyclePolicy::OneShot`] | [`ExecControlPolicy::Disabled`] | One-shot contained workload |
/// | [`ExecProcessRole::Workload`] | [`ExecLifecyclePolicy::Supervised`] | [`ExecControlPolicy::Disabled`] | Ordinary supervised workload |
/// | [`ExecProcessRole::Workload`] | [`ExecLifecyclePolicy::Supervised`] | `Enabled { sink: false, .. }` | Controlled supervised workload without a guest sink |
/// | [`ExecProcessRole::Agent`] | [`ExecLifecyclePolicy::Supervised`] | `Enabled { sink: true, .. }` | Controlled Agent operation with a guest sink |
/// | [`ExecProcessRole::SessionHistoryIdentityVerifier`] | [`ExecLifecyclePolicy::OneShot`] | [`ExecControlPolicy::Disabled`] | Fixed one-shot live identity verifier |
/// | [`ExecProcessRole::CodexSessionCleanup`] | [`ExecLifecyclePolicy::OneShot`] | [`ExecControlPolicy::Disabled`] | Fixed one-shot reused-Codex cleanup helper |
///
/// An `Agent` therefore requires a supervised lifecycle and an enabled control
/// sink. A controlled `Workload` is supervised with an enabled control channel
/// but `sink: false`. Every other combination is rejected during both encoding
/// and decoding by [`validate_exec_process_contract`].
pub struct ExecStartEncodeRequest<'a> {
    /// Process lifecycle policy to encode.
    pub lifecycle: ExecLifecyclePolicy,
    /// Semantic process role to encode.
    pub role: ExecProcessRole,
    /// Protocol timeout policy to encode.
    pub timeout: ExecTimeoutPolicy,
    /// UTF-8 command string to execute.
    pub command: &'a str,
    /// Environment key/value pairs to encode.
    ///
    /// At most 4096 pairs are accepted.
    pub env: &'a [(&'a str, &'a str)],
    /// Whether the guest should run the command through sudo.
    pub sudo: bool,
    /// UTF-8 operation label encoded with a `u16` byte length.
    pub label: &'a str,
    /// Standard output handling policy.
    pub stdout: ExecOutputPolicy,
    /// Standard error handling policy.
    pub stderr: ExecOutputPolicy,
    /// Additional exit codes treated as expected by the caller.
    ///
    /// At most 64 exit codes are accepted.
    pub expected_exit_codes: &'a [i32],
    /// Exec control channel policy.
    pub control: ExecControlPolicy,
    /// Optional bounded stdin bytes.
    ///
    /// Present stdin is limited to [`MAX_EXEC_STDIN_BYTES`].
    pub stdin_bytes: Option<&'a [u8]>,
}

/// Decoded exec_start payload.
///
/// Its `lifecycle`, `role`, and `control` fields satisfy the process contract
/// documented on [`ExecStartEncodeRequest`]. Decoding rejects every other
/// combination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedExecStart<'a> {
    /// Decoded process lifecycle policy.
    pub lifecycle: ExecLifecyclePolicy,
    /// Decoded semantic process role.
    pub role: ExecProcessRole,
    /// Decoded protocol timeout policy.
    pub timeout: ExecTimeoutPolicy,
    /// Command string borrowed from the decoded payload.
    pub command: &'a str,
    /// Decoded environment key/value pairs.
    ///
    /// The vector is allocated during decoding; keys and values borrow from the
    /// decoded payload.
    pub env: Vec<(&'a str, &'a str)>,
    /// Whether sudo execution was requested.
    pub sudo: bool,
    /// Operation label borrowed from the decoded payload.
    pub label: &'a str,
    /// Decoded standard output handling policy.
    pub stdout: ExecOutputPolicy,
    /// Decoded standard error handling policy.
    pub stderr: ExecOutputPolicy,
    /// Decoded additional expected exit codes.
    pub expected_exit_codes: Vec<i32>,
    /// Decoded exec control channel policy.
    pub control: ExecControlPolicy,
    /// Optional stdin bytes borrowed from the decoded payload.
    pub stdin_bytes: Option<&'a [u8]>,
}

fn validate_exec_output_chunk_limit(chunk_limit_bytes: u32) -> Result<(), ProtocolError> {
    if chunk_limit_bytes == 0 {
        return Err(ProtocolError::InvalidPayload(
            "exec output chunk limit must be non-zero",
        ));
    }
    Ok(())
}

fn exec_output_policy_encoded_len(policy: ExecOutputPolicy) -> Result<usize, ProtocolError> {
    match policy {
        ExecOutputPolicy::Discard => Ok(1),
        ExecOutputPolicy::Capture { .. } => Ok(5),
        ExecOutputPolicy::Stream {
            chunk_limit_bytes, ..
        } => {
            validate_exec_output_chunk_limit(chunk_limit_bytes)?;
            Ok(9)
        }
        ExecOutputPolicy::CaptureAndStream {
            chunk_limit_bytes, ..
        } => {
            validate_exec_output_chunk_limit(chunk_limit_bytes)?;
            Ok(13)
        }
    }
}

fn exec_timeout_policy_encoded_len(timeout: ExecTimeoutPolicy) -> usize {
    match timeout {
        ExecTimeoutPolicy::Duration { .. } => 1 + 4,
        ExecTimeoutPolicy::None => 1,
    }
}

fn exec_control_policy_encoded_len(control: ExecControlPolicy) -> usize {
    match control {
        ExecControlPolicy::Disabled => 1,
        ExecControlPolicy::Enabled { .. } => 1 + 1 + EXEC_CONTROL_NONCE_LEN,
    }
}

fn exec_stdin_policy_encoded_len(stdin_bytes: Option<&[u8]>) -> Result<usize, ProtocolError> {
    match stdin_bytes {
        None => Ok(1),
        Some(bytes) => {
            if bytes.len() > MAX_EXEC_STDIN_BYTES {
                return Err(ProtocolError::PayloadTooLarge("stdin_bytes", bytes.len()));
            }
            Ok(1 + 4 + bytes.len())
        }
    }
}

fn append_exec_lifecycle(p: &mut Vec<u8>, lifecycle: ExecLifecyclePolicy) {
    p.push(match lifecycle {
        ExecLifecyclePolicy::OneShot => EXEC_LIFECYCLE_ONE_SHOT,
        ExecLifecyclePolicy::Supervised => EXEC_LIFECYCLE_SUPERVISED,
    });
}

fn append_exec_process_role(p: &mut Vec<u8>, role: ExecProcessRole) {
    p.push(match role {
        ExecProcessRole::Workload => EXEC_PROCESS_ROLE_WORKLOAD,
        ExecProcessRole::Agent => EXEC_PROCESS_ROLE_AGENT,
        ExecProcessRole::SessionHistoryIdentityVerifier => {
            EXEC_PROCESS_ROLE_SESSION_HISTORY_IDENTITY_VERIFIER
        }
        ExecProcessRole::CodexSessionCleanup => EXEC_PROCESS_ROLE_CODEX_SESSION_CLEANUP,
    });
}

fn append_exec_timeout_policy(p: &mut Vec<u8>, timeout: ExecTimeoutPolicy) {
    match timeout {
        ExecTimeoutPolicy::Duration { timeout_ms } => {
            p.push(EXEC_TIMEOUT_DURATION);
            p.extend_from_slice(&timeout_ms.to_be_bytes());
        }
        ExecTimeoutPolicy::None => p.push(EXEC_TIMEOUT_NONE),
    }
}

fn append_exec_control_policy(p: &mut Vec<u8>, control: ExecControlPolicy) {
    match control {
        ExecControlPolicy::Disabled => p.push(EXEC_CONTROL_DISABLED),
        ExecControlPolicy::Enabled {
            control_nonce,
            sink,
        } => {
            p.push(EXEC_CONTROL_ENABLED);
            p.push(if sink { EXEC_CONTROL_FLAG_SINK } else { 0 });
            p.extend_from_slice(&control_nonce);
        }
    }
}

fn append_exec_stdin_policy(p: &mut Vec<u8>, stdin_bytes: Option<&[u8]>) {
    match stdin_bytes {
        None => p.push(EXEC_STDIN_NONE),
        Some(bytes) => {
            p.push(EXEC_STDIN_BYTES);
            p.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
            p.extend_from_slice(bytes);
        }
    }
}

fn validate_exec_timeout_policy(timeout: ExecTimeoutPolicy) -> Result<(), ProtocolError> {
    if let ExecTimeoutPolicy::Duration { timeout_ms: 0 } = timeout {
        return Err(ProtocolError::InvalidPayload(
            "exec start timeout duration must be positive",
        ));
    }
    Ok(())
}

/// Validate the semantic role, lifecycle, and transport-control combination.
///
/// The accepted combinations are documented on [`ExecStartEncodeRequest`].
/// This same contract is enforced by the exec-start encoder and decoder.
pub fn validate_exec_process_contract(
    role: ExecProcessRole,
    lifecycle: ExecLifecyclePolicy,
    control: ExecControlPolicy,
) -> Result<(), ProtocolError> {
    match (role, lifecycle, control) {
        (ExecProcessRole::Workload, ExecLifecyclePolicy::OneShot, ExecControlPolicy::Disabled)
        | (
            ExecProcessRole::Workload,
            ExecLifecyclePolicy::Supervised,
            ExecControlPolicy::Disabled,
        )
        | (
            ExecProcessRole::Workload,
            ExecLifecyclePolicy::Supervised,
            ExecControlPolicy::Enabled { sink: false, .. },
        )
        | (
            ExecProcessRole::Agent,
            ExecLifecyclePolicy::Supervised,
            ExecControlPolicy::Enabled { sink: true, .. },
        )
        | (
            ExecProcessRole::SessionHistoryIdentityVerifier,
            ExecLifecyclePolicy::OneShot,
            ExecControlPolicy::Disabled,
        )
        | (
            ExecProcessRole::CodexSessionCleanup,
            ExecLifecyclePolicy::OneShot,
            ExecControlPolicy::Disabled,
        ) => Ok(()),
        _ => Err(ProtocolError::InvalidPayload(
            "exec start role, lifecycle, and control combination invalid",
        )),
    }
}

fn append_exec_output_policy(p: &mut Vec<u8>, policy: ExecOutputPolicy) {
    match policy {
        ExecOutputPolicy::Discard => p.push(EXEC_OUTPUT_POLICY_DISCARD),
        ExecOutputPolicy::Capture { limit_bytes } => {
            p.push(EXEC_OUTPUT_POLICY_CAPTURE);
            p.extend_from_slice(&limit_bytes.to_be_bytes());
        }
        ExecOutputPolicy::Stream {
            limit_bytes,
            chunk_limit_bytes,
        } => {
            p.push(EXEC_OUTPUT_POLICY_STREAM);
            p.extend_from_slice(&limit_bytes.to_be_bytes());
            p.extend_from_slice(&chunk_limit_bytes.to_be_bytes());
        }
        ExecOutputPolicy::CaptureAndStream {
            capture_limit_bytes,
            stream_limit_bytes,
            chunk_limit_bytes,
        } => {
            p.push(EXEC_OUTPUT_POLICY_CAPTURE_AND_STREAM);
            p.extend_from_slice(&capture_limit_bytes.to_be_bytes());
            p.extend_from_slice(&stream_limit_bytes.to_be_bytes());
            p.extend_from_slice(&chunk_limit_bytes.to_be_bytes());
        }
    }
}

/// Encode exec_start payload with no expected non-zero exits.
pub fn encode_exec_start(
    timeout_ms: u32,
    command: &str,
    env: &[(&str, &str)],
    sudo: bool,
    label: &str,
    stdout: ExecOutputPolicy,
    stderr: ExecOutputPolicy,
) -> Result<Vec<u8>, ProtocolError> {
    encode_exec_start_with_expected_exit_codes(ExecStartEncodeRequest {
        lifecycle: ExecLifecyclePolicy::OneShot,
        role: ExecProcessRole::Workload,
        timeout: ExecTimeoutPolicy::Duration { timeout_ms },
        command,
        env,
        sudo,
        label,
        stdout,
        stderr,
        expected_exit_codes: &[],
        control: ExecControlPolicy::Disabled,
        stdin_bytes: None,
    })
}

/// Encode exec_start payload.
///
/// See the crate-level wire-format documentation for the full `exec_start`
/// payload schema.
///
/// Duration timeout policies require a positive `timeout_ms`; use the explicit
/// no-timeout policy for unbounded operation lifetimes.
pub fn encode_exec_start_with_expected_exit_codes(
    request: ExecStartEncodeRequest<'_>,
) -> Result<Vec<u8>, ProtocolError> {
    let cmd = request.command.as_bytes();
    let label_bytes = request.label.as_bytes();
    let cmd_len = ensure_u32_len("command", cmd.len())?;
    let env_count = ensure_u32_count("env_count", request.env.len())?;
    if request.env.len() > MAX_EXEC_ENV_VARS {
        return Err(ProtocolError::PayloadCountTooLarge(
            "env_count",
            request.env.len(),
        ));
    }
    let label_len = ensure_u16_len("label", label_bytes.len())?;
    let expected_exit_count =
        ensure_u16_count("expected_exit_count", request.expected_exit_codes.len())?;
    if request.expected_exit_codes.len() > MAX_EXEC_EXPECTED_EXIT_CODES {
        return Err(ProtocolError::PayloadCountTooLarge(
            "expected_exit_count",
            request.expected_exit_codes.len(),
        ));
    }

    let stdout_policy_len = exec_output_policy_encoded_len(request.stdout)?;
    let stderr_policy_len = exec_output_policy_encoded_len(request.stderr)?;
    let timeout_policy_len = exec_timeout_policy_encoded_len(request.timeout);
    let control_policy_len = exec_control_policy_encoded_len(request.control);
    let stdin_policy_len = exec_stdin_policy_encoded_len(request.stdin_bytes)?;
    validate_exec_timeout_policy(request.timeout)?;
    validate_exec_process_contract(request.role, request.lifecycle, request.control)?;

    let mut payload_len = 1 + 1 + timeout_policy_len + 1 + 4;
    payload_len = checked_payload_len_add(payload_len, cmd.len())?;
    payload_len = checked_payload_len_add(payload_len, 4)?;
    for (key, val) in request.env {
        let key_bytes = key.as_bytes();
        let val_bytes = val.as_bytes();
        ensure_u32_len("env key", key_bytes.len())?;
        ensure_u32_len("env value", val_bytes.len())?;
        payload_len = checked_payload_len_add(payload_len, 8)?;
        payload_len = checked_payload_len_add(payload_len, key_bytes.len())?;
        payload_len = checked_payload_len_add(payload_len, val_bytes.len())?;
    }
    payload_len = checked_payload_len_add(payload_len, 2)?;
    payload_len = checked_payload_len_add(payload_len, label_bytes.len())?;
    payload_len = checked_payload_len_add(payload_len, stdout_policy_len)?;
    payload_len = checked_payload_len_add(payload_len, stderr_policy_len)?;
    payload_len = checked_payload_len_add(payload_len, 2)?;
    payload_len = checked_payload_len_add(payload_len, request.expected_exit_codes.len() * 4)?;
    payload_len = checked_payload_len_add(payload_len, control_policy_len)?;
    payload_len = checked_payload_len_add(payload_len, stdin_policy_len)?;
    ensure_payload_fits_message(payload_len)?;

    let mut p = Vec::with_capacity(payload_len);
    append_exec_lifecycle(&mut p, request.lifecycle);
    append_exec_process_role(&mut p, request.role);
    append_exec_timeout_policy(&mut p, request.timeout);
    p.push(if request.sudo { EXEC_FLAG_SUDO } else { 0 });
    p.extend_from_slice(&cmd_len.to_be_bytes());
    p.extend_from_slice(cmd);
    p.extend_from_slice(&env_count.to_be_bytes());
    for (key, val) in request.env {
        let key_bytes = key.as_bytes();
        let val_bytes = val.as_bytes();
        p.extend_from_slice(&(key_bytes.len() as u32).to_be_bytes());
        p.extend_from_slice(key_bytes);
        p.extend_from_slice(&(val_bytes.len() as u32).to_be_bytes());
        p.extend_from_slice(val_bytes);
    }
    p.extend_from_slice(&label_len.to_be_bytes());
    p.extend_from_slice(label_bytes);
    append_exec_output_policy(&mut p, request.stdout);
    append_exec_output_policy(&mut p, request.stderr);
    p.extend_from_slice(&expected_exit_count.to_be_bytes());
    for exit_code in request.expected_exit_codes {
        p.extend_from_slice(&exit_code.to_be_bytes());
    }
    append_exec_control_policy(&mut p, request.control);
    append_exec_stdin_policy(&mut p, request.stdin_bytes);
    debug_assert_eq!(p.len(), payload_len);
    Ok(p)
}

fn decode_exec_output_policy(
    payload: &[u8],
    offset: &mut usize,
) -> Result<ExecOutputPolicy, ProtocolError> {
    let tag = read_u8(payload, offset, "exec output policy tag truncated")?;
    match tag {
        EXEC_OUTPUT_POLICY_DISCARD => Ok(ExecOutputPolicy::Discard),
        EXEC_OUTPUT_POLICY_CAPTURE => {
            let limit_bytes = read_u32(payload, offset, "exec capture policy limit truncated")?;
            Ok(ExecOutputPolicy::Capture { limit_bytes })
        }
        EXEC_OUTPUT_POLICY_STREAM => {
            let limit_bytes = read_u32(payload, offset, "exec stream policy limit truncated")?;
            let chunk_limit_bytes =
                read_u32(payload, offset, "exec stream policy chunk limit truncated")?;
            validate_exec_output_chunk_limit(chunk_limit_bytes)?;
            Ok(ExecOutputPolicy::Stream {
                limit_bytes,
                chunk_limit_bytes,
            })
        }
        EXEC_OUTPUT_POLICY_CAPTURE_AND_STREAM => {
            let capture_limit_bytes = read_u32(
                payload,
                offset,
                "exec capture-and-stream capture limit truncated",
            )?;
            let stream_limit_bytes = read_u32(
                payload,
                offset,
                "exec capture-and-stream stream limit truncated",
            )?;
            let chunk_limit_bytes = read_u32(
                payload,
                offset,
                "exec capture-and-stream chunk limit truncated",
            )?;
            validate_exec_output_chunk_limit(chunk_limit_bytes)?;
            Ok(ExecOutputPolicy::CaptureAndStream {
                capture_limit_bytes,
                stream_limit_bytes,
                chunk_limit_bytes,
            })
        }
        _ => Err(ProtocolError::InvalidPayload(
            "invalid exec output policy tag",
        )),
    }
}

fn decode_exec_lifecycle(
    payload: &[u8],
    offset: &mut usize,
) -> Result<ExecLifecyclePolicy, ProtocolError> {
    match read_u8(payload, offset, "exec start lifecycle truncated")? {
        EXEC_LIFECYCLE_ONE_SHOT => Ok(ExecLifecyclePolicy::OneShot),
        EXEC_LIFECYCLE_SUPERVISED => Ok(ExecLifecyclePolicy::Supervised),
        _ => Err(ProtocolError::InvalidPayload(
            "exec start lifecycle invalid",
        )),
    }
}

fn decode_exec_process_role(
    payload: &[u8],
    offset: &mut usize,
) -> Result<ExecProcessRole, ProtocolError> {
    match read_u8(payload, offset, "exec start process role truncated")? {
        EXEC_PROCESS_ROLE_WORKLOAD => Ok(ExecProcessRole::Workload),
        EXEC_PROCESS_ROLE_AGENT => Ok(ExecProcessRole::Agent),
        EXEC_PROCESS_ROLE_SESSION_HISTORY_IDENTITY_VERIFIER => {
            Ok(ExecProcessRole::SessionHistoryIdentityVerifier)
        }
        EXEC_PROCESS_ROLE_CODEX_SESSION_CLEANUP => Ok(ExecProcessRole::CodexSessionCleanup),
        _ => Err(ProtocolError::InvalidPayload(
            "exec start process role invalid",
        )),
    }
}

fn decode_exec_timeout_policy(
    payload: &[u8],
    offset: &mut usize,
) -> Result<ExecTimeoutPolicy, ProtocolError> {
    match read_u8(payload, offset, "exec start timeout policy truncated")? {
        EXEC_TIMEOUT_DURATION => {
            let timeout_ms = read_u32(payload, offset, "exec start timeout truncated")?;
            if timeout_ms == 0 {
                return Err(ProtocolError::InvalidPayload(
                    "exec start timeout duration must be positive",
                ));
            }
            Ok(ExecTimeoutPolicy::Duration { timeout_ms })
        }
        EXEC_TIMEOUT_NONE => Ok(ExecTimeoutPolicy::None),
        _ => Err(ProtocolError::InvalidPayload(
            "exec start timeout policy invalid",
        )),
    }
}

fn decode_exec_control_policy(
    payload: &[u8],
    offset: &mut usize,
) -> Result<ExecControlPolicy, ProtocolError> {
    match read_u8(payload, offset, "exec start control policy truncated")? {
        EXEC_CONTROL_DISABLED => Ok(ExecControlPolicy::Disabled),
        EXEC_CONTROL_ENABLED => {
            let flags = read_u8(payload, offset, "exec start control flags truncated")?;
            if flags & !EXEC_CONTROL_FLAG_SINK != 0 {
                return Err(ProtocolError::InvalidPayload(
                    "exec start control unknown flags",
                ));
            }
            let nonce_bytes = read_slice(
                payload,
                offset,
                EXEC_CONTROL_NONCE_LEN,
                "exec start control nonce truncated",
            )?;
            let control_nonce: ExecControlNonce = nonce_bytes
                .try_into()
                .map_err(|_| ProtocolError::InvalidPayload("exec start control nonce invalid"))?;
            Ok(ExecControlPolicy::Enabled {
                control_nonce,
                sink: flags & EXEC_CONTROL_FLAG_SINK != 0,
            })
        }
        _ => Err(ProtocolError::InvalidPayload(
            "exec start control policy invalid",
        )),
    }
}

fn decode_exec_stdin_policy<'a>(
    payload: &'a [u8],
    offset: &mut usize,
) -> Result<Option<&'a [u8]>, ProtocolError> {
    match read_u8(payload, offset, "exec start stdin policy truncated")? {
        EXEC_STDIN_NONE => Ok(None),
        EXEC_STDIN_BYTES => {
            let len = read_u32(payload, offset, "exec start stdin_len truncated")? as usize;
            if len > MAX_EXEC_STDIN_BYTES {
                return Err(ProtocolError::InvalidPayload("exec start stdin too large"));
            }
            let bytes = read_slice(payload, offset, len, "exec start stdin truncated")?;
            Ok(Some(bytes))
        }
        _ => Err(ProtocolError::InvalidPayload(
            "exec start stdin policy invalid",
        )),
    }
}

/// Decode exec_start payload into a [`DecodedExecStart`] struct.
pub fn decode_exec_start(payload: &[u8]) -> Result<DecodedExecStart<'_>, ProtocolError> {
    let mut offset = 0;
    let lifecycle = decode_exec_lifecycle(payload, &mut offset)?;
    let role = decode_exec_process_role(payload, &mut offset)?;
    let timeout = decode_exec_timeout_policy(payload, &mut offset)?;
    let flags = read_u8(payload, &mut offset, "exec start flags truncated")?;
    if flags & !EXEC_FLAG_SUDO != 0 {
        return Err(ProtocolError::InvalidPayload("exec start unknown flags"));
    }
    let cmd_len = read_u32(payload, &mut offset, "exec start command_len truncated")? as usize;
    let command = read_str(
        payload,
        &mut offset,
        cmd_len,
        "exec start command truncated",
        "invalid UTF-8 in command",
    )?;
    let env_count = read_u32(payload, &mut offset, "exec start env_count truncated")?;
    if env_count as usize > MAX_EXEC_ENV_VARS {
        return Err(ProtocolError::InvalidPayload(
            "exec start env_count too large",
        ));
    }
    let min_env_bytes = (env_count as usize)
        .checked_mul(8)
        .ok_or(ProtocolError::InvalidPayload("exec start env truncated"))?;
    let remaining_for_env = payload.len().saturating_sub(offset).saturating_sub(4);
    if min_env_bytes > remaining_for_env {
        return Err(ProtocolError::InvalidPayload("exec start env truncated"));
    }
    let mut env = Vec::with_capacity(env_count as usize);
    for _ in 0..env_count {
        let key_len = read_u32(payload, &mut offset, "exec start env key_len truncated")? as usize;
        let key = read_str(
            payload,
            &mut offset,
            key_len,
            "exec start env key truncated",
            "invalid UTF-8 in env key",
        )?;
        let val_len = read_u32(payload, &mut offset, "exec start env val_len truncated")? as usize;
        let val = read_str(
            payload,
            &mut offset,
            val_len,
            "exec start env value truncated",
            "invalid UTF-8 in env value",
        )?;
        env.push((key, val));
    }
    let label_len = read_u16(payload, &mut offset, "exec start label_len truncated")? as usize;
    let label = read_str(
        payload,
        &mut offset,
        label_len,
        "exec start label truncated",
        "invalid UTF-8 in label",
    )?;
    let stdout = decode_exec_output_policy(payload, &mut offset)?;
    let stderr = decode_exec_output_policy(payload, &mut offset)?;
    let expected_exit_count = read_u16(
        payload,
        &mut offset,
        "exec start expected_exit_count truncated",
    )?;
    if expected_exit_count as usize > MAX_EXEC_EXPECTED_EXIT_CODES {
        return Err(ProtocolError::InvalidPayload(
            "exec start expected_exit_count too large",
        ));
    }
    let expected_exit_bytes =
        (expected_exit_count as usize)
            .checked_mul(4)
            .ok_or(ProtocolError::InvalidPayload(
                "exec start expected exits truncated",
            ))?;
    if payload.len().saturating_sub(offset) < expected_exit_bytes {
        return Err(ProtocolError::InvalidPayload(
            "exec start expected exits truncated",
        ));
    }
    let mut expected_exit_codes = Vec::with_capacity(expected_exit_count as usize);
    for _ in 0..expected_exit_count {
        expected_exit_codes.push(read_i32(
            payload,
            &mut offset,
            "exec start expected exit truncated",
        )?);
    }
    let control = decode_exec_control_policy(payload, &mut offset)?;
    let stdin_bytes = decode_exec_stdin_policy(payload, &mut offset)?;
    expect_consumed(payload, offset, "exec start trailing bytes")?;
    validate_exec_process_contract(role, lifecycle, control)?;
    Ok(DecodedExecStart {
        lifecycle,
        role,
        timeout,
        command,
        env,
        sudo: (flags & EXEC_FLAG_SUDO) != 0,
        label,
        stdout,
        stderr,
        expected_exit_codes,
        control,
        stdin_bytes,
    })
}
