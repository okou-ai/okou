use guest_contracts::agent_instructions::InstructionOperation;

use crate::frame::encode_into;
use crate::payloads::exec_operation::encode_exec_result_frame_into_with_prefix;
use crate::{
    DecodedExecResult, DecodedGuestStorageManifestRequest, ExecCapturedOutput,
    MSG_GUEST_AGENT_INSTRUCTIONS, MSG_GUEST_AGENT_INSTRUCTIONS_RESULT, ProtocolError,
    decode_exec_result, decode_guest_storage_manifest_request,
    encode_guest_storage_manifest_request,
};

/// Instruction stdout and stderr are each independently bounded.
pub const GUEST_AGENT_INSTRUCTIONS_OUTPUT_LIMIT_BYTES: usize = 64 * 1024;

/// Validated action and the existing bounded storage context envelope.
pub struct DecodedGuestAgentInstructionsRequest<'a> {
    /// Fixed Guest-owned action.
    pub operation: InstructionOperation,
    /// Run context and opaque instruction metadata in `manifest_json`.
    pub input: DecodedGuestStorageManifestRequest<'a>,
}

/// Encode one fixed action; invalid inputs leave the destination unchanged.
pub fn encode_guest_agent_instructions_request_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    operation: InstructionOperation,
    timeout_ms: u32,
    run_id: &str,
    runtime_dir: &str,
    metadata: &[u8],
) -> Result<(), ProtocolError> {
    validate_metadata(operation, metadata)?;
    let input = encode_guest_storage_manifest_request(timeout_ms, run_id, runtime_dir, metadata)?;
    let tag = match operation {
        InstructionOperation::Check => 0,
        InstructionOperation::Apply => 1,
    };
    encode_into(
        frame,
        MSG_GUEST_AGENT_INSTRUCTIONS,
        seq,
        1 + input.len(),
        |frame| {
            frame.push(tag);
            frame.extend_from_slice(&input);
        },
    )
}

/// Decode a bounded request without interpreting instruction contents.
pub fn decode_guest_agent_instructions_request(
    payload: &[u8],
) -> Result<DecodedGuestAgentInstructionsRequest<'_>, ProtocolError> {
    let (tag, input) = payload.split_first().ok_or(ProtocolError::InvalidPayload(
        "instruction operation missing",
    ))?;
    let operation = match tag {
        0 => InstructionOperation::Check,
        1 => InstructionOperation::Apply,
        _ => {
            return Err(ProtocolError::InvalidPayload(
                "unknown instruction operation",
            ));
        }
    };
    let input = decode_guest_storage_manifest_request(input)?;
    validate_metadata(operation, input.manifest_json)?;
    Ok(DecodedGuestAgentInstructionsRequest { operation, input })
}

fn validate_metadata(
    operation: InstructionOperation,
    metadata: &[u8],
) -> Result<(), ProtocolError> {
    if metadata.len() > operation.metadata_limit() {
        return Err(ProtocolError::PayloadTooLarge(
            "instruction metadata",
            metadata.len(),
        ));
    }
    // Instructions have no binary storage-file variant, even under 64 KiB.
    if metadata.starts_with(guest_contracts::storage_files::INPUT_MAGIC) {
        return Err(ProtocolError::InvalidPayload("binary instruction metadata"));
    }
    Ok(())
}

/// Encode a terminal result using the instruction-specific capture bound.
pub fn encode_guest_agent_instructions_result_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    result: DecodedExecResult<'_>,
) -> Result<(), ProtocolError> {
    validate_output(result.stdout)?;
    validate_output(result.stderr)?;
    encode_exec_result_frame_into_with_prefix::<MSG_GUEST_AGENT_INSTRUCTIONS_RESULT>(
        frame,
        seq,
        result,
        &[],
    )
}

/// Decode a terminal result, rejecting discarded or excessive capture.
pub fn decode_guest_agent_instructions_result(
    payload: &[u8],
) -> Result<DecodedExecResult<'_>, ProtocolError> {
    let result = decode_exec_result(payload)?;
    validate_output(result.stdout)?;
    validate_output(result.stderr)?;
    Ok(result)
}

fn validate_output(output: ExecCapturedOutput<'_>) -> Result<(), ProtocolError> {
    match output {
        ExecCapturedOutput::Captured { bytes, .. }
            if bytes.len() <= GUEST_AGENT_INSTRUCTIONS_OUTPUT_LIMIT_BYTES =>
        {
            Ok(())
        }
        _ => Err(ProtocolError::InvalidPayload("invalid instruction capture")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_actions_round_trip_and_reject_invalid_envelopes() {
        for operation in [InstructionOperation::Check, InstructionOperation::Apply] {
            let metadata = vec![b' '; operation.metadata_limit()];
            let mut frame = Vec::new();
            encode_guest_agent_instructions_request_frame_into(
                &mut frame,
                7,
                operation,
                123,
                "run",
                "/run/agent",
                &metadata,
            )
            .unwrap();
            let message = crate::Decoder::new().decode(&frame).unwrap().remove(0);
            assert_eq!(message.msg_type, MSG_GUEST_AGENT_INSTRUCTIONS);
            let decoded = decode_guest_agent_instructions_request(&message.payload).unwrap();
            assert_eq!(decoded.operation, operation);
            assert_eq!(decoded.input.manifest_json, metadata);
            assert_eq!(decoded.input.timeout_ms, 123);
            assert_eq!(decoded.input.run_id, "run");
            assert_eq!(decoded.input.runtime_dir, "/run/agent");
            for cut in 0..message.payload.len().min(20) {
                assert!(decode_guest_agent_instructions_request(&message.payload[..cut]).is_err());
            }
            let mut invalid = message.payload.clone();
            invalid[0] = 2;
            assert!(decode_guest_agent_instructions_request(&invalid).is_err());
            invalid = message.payload.clone();
            invalid.push(0);
            assert!(decode_guest_agent_instructions_request(&invalid).is_err());
            let before = frame.clone();
            let oversized = vec![0; operation.metadata_limit() + 1];
            assert!(
                encode_guest_agent_instructions_request_frame_into(
                    &mut frame, 7, operation, 123, "run", "/run", &oversized
                )
                .is_err()
            );
            assert_eq!(frame, before);
        }
    }

    #[test]
    fn instruction_result_preserves_termination_and_enforces_capture_bounds() {
        let valid = vec![42; GUEST_AGENT_INSTRUCTIONS_OUTPUT_LIMIT_BYTES];
        let result = DecodedExecResult {
            termination: crate::ExecTermination::TimedOut,
            duration_ms: 37,
            stdout: ExecCapturedOutput::Captured {
                bytes: &valid,
                truncated: true,
            },
            stderr: ExecCapturedOutput::Captured {
                bytes: b"diagnostic",
                truncated: false,
            },
            diagnostic: "owned cleanup complete",
        };
        let mut frame = Vec::new();
        encode_guest_agent_instructions_result_frame_into(&mut frame, 9, result).unwrap();
        let message = crate::Decoder::new().decode(&frame).unwrap().remove(0);
        assert_eq!(message.msg_type, MSG_GUEST_AGENT_INSTRUCTIONS_RESULT);
        let decoded = decode_guest_agent_instructions_result(&message.payload).unwrap();
        assert_eq!(decoded.termination, result.termination);
        assert_eq!(decoded.duration_ms, 37);
        assert_eq!(decoded.stdout, result.stdout);
        let oversized = vec![0; GUEST_AGENT_INSTRUCTIONS_OUTPUT_LIMIT_BYTES + 1];
        let payload = crate::encode_exec_result(
            result.termination,
            37,
            ExecCapturedOutput::Captured {
                bytes: &oversized,
                truncated: false,
            },
            result.stderr,
            "",
        )
        .unwrap();
        assert!(decode_guest_agent_instructions_result(&payload).is_err());
        let invalid = DecodedExecResult {
            stdout: ExecCapturedOutput::Discarded,
            ..result
        };
        assert!(encode_guest_agent_instructions_result_frame_into(&mut frame, 9, invalid).is_err());
    }
}
