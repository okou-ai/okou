use std::time::Duration;

use super::*;

#[test]
fn duration_ms_saturates_large_duration() {
    assert_eq!(duration_ms(Duration::MAX), u64::MAX);
}
