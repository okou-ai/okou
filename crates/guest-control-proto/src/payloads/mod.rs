pub(crate) mod empty;
pub(crate) mod error;
pub(crate) mod exec_operation;
pub(crate) mod file_write_status;
pub(crate) mod guest_dns_readiness;
pub(crate) mod guest_state_restore;
pub(crate) mod guest_storage_manifest;
pub(crate) mod home_drive_mount;
pub(crate) mod memory_snapshot;
pub(crate) mod process_termination;
pub(crate) mod write_file;

fn truncate_utf8_to_u16_bytes(value: &str) -> (&[u8], u16) {
    let mut end = value.len().min(u16::MAX as usize);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    let (prefix, _) = value.split_at(end);
    (prefix.as_bytes(), end as u16)
}
