pub(crate) mod empty;
pub(crate) mod error;
pub(crate) mod exec_operation;
pub(crate) mod file_write_status;
pub(crate) mod guest_agent_instructions;
pub(crate) mod guest_dns_readiness;
pub(crate) mod guest_state_restore;
pub(crate) mod guest_storage_manifest;
pub(crate) mod home_drive_mount;
pub(crate) mod memory_snapshot;
pub(crate) mod process_termination;
pub(crate) mod write_file;

use crate::{ExecCapturedOutput, ProtocolError};

fn validate_bounded_capture(
    output: ExecCapturedOutput<'_>,
    limit: usize,
    field: &'static str,
    discarded_diagnostic: &'static str,
) -> Result<(), ProtocolError> {
    match output {
        ExecCapturedOutput::Captured { bytes, .. } if bytes.len() <= limit => Ok(()),
        ExecCapturedOutput::Captured { bytes, .. } => {
            Err(ProtocolError::PayloadTooLarge(field, bytes.len()))
        }
        ExecCapturedOutput::Discarded => Err(ProtocolError::InvalidPayload(discarded_diagnostic)),
    }
}

fn truncate_utf8_to_u16_bytes(value: &str) -> (&[u8], u16) {
    let end = value.floor_char_boundary(value.len().min(u16::MAX as usize));
    let (prefix, _) = value.split_at(end);
    (prefix.as_bytes(), end as u16)
}
