use super::ensure_u32_count;
use crate::error::ProtocolError;

#[cfg(target_pointer_width = "64")]
#[test]
fn ensure_u32_count_rejects_overflow() {
    let count = usize::MAX;

    assert!(matches!(
        ensure_u32_count("env_count", count),
        Err(ProtocolError::PayloadCountTooLarge("env_count", value))
            if value == count
    ));
}
