pub(super) fn assert_successful_action_once(ops: &[(String, bool, Option<String>)], action: &str) {
    let matches = ops.iter().filter(|op| op.0 == action && op.1).count();
    assert_eq!(
        matches, 1,
        "expected exactly one successful {action} telemetry, got: {ops:?}"
    );
}

pub(super) fn assert_failed_action_error_once(
    ops: &[(String, bool, Option<String>)],
    action: &str,
    error: &str,
) {
    let matches = ops
        .iter()
        .filter(|op| op.0 == action && !op.1 && op.2.as_deref() == Some(error))
        .count();
    assert_eq!(
        matches, 1,
        "expected exactly one failed {action} telemetry with {error:?}, got: {ops:?}"
    );
}

pub(super) fn assert_no_action(ops: &[(String, bool, Option<String>)], action: &str) {
    assert!(
        ops.iter().all(|op| op.0 != action),
        "expected no {action} telemetry, got: {ops:?}"
    );
}
