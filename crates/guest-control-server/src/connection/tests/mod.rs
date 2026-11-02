use super::*;
use guest_control_proto::{MSG_PING, MSG_SHUTDOWN};

#[test]
fn retry_closed_failure_returns_connection_reset_when_exhausted() {
    let result = retry_or_fail(ReconnectFailure::Closed, MAX_RECONNECT_ATTEMPTS);

    assert!(result.is_err());
    if let Err(error) = result {
        assert_eq!(error.kind(), io::ErrorKind::ConnectionReset);
        assert_eq!(error.to_string(), "Max reconnect attempts reached");
    }
}

#[test]
fn retry_error_failure_returns_original_error_when_exhausted() {
    let result = retry_or_fail(
        ReconnectFailure::Error(io::Error::new(
            io::ErrorKind::TimedOut,
            "connection timed out",
        )),
        MAX_RECONNECT_ATTEMPTS,
    );

    assert!(result.is_err());
    if let Err(error) = result {
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert_eq!(error.to_string(), "connection timed out");
    }
}

#[test]
fn connection_stability_requires_duration_or_real_work() {
    assert!(!connection_is_stable(
        STABLE_CONNECTION_MIN_DURATION - Duration::from_millis(1),
        false
    ));
    assert!(connection_is_stable(STABLE_CONNECTION_MIN_DURATION, false));
    assert!(connection_is_stable(Duration::ZERO, true));
}

#[test]
fn liveness_and_shutdown_messages_do_not_count_as_real_host_work() {
    assert!(!is_real_host_work_message(MSG_PING));
    assert!(!is_real_host_work_message(MSG_SHUTDOWN));
}

#[test]
fn operation_messages_count_as_real_host_work() {
    for msg_type in [
        MSG_EXEC_START,
        MSG_EXEC_CANCEL,
        MSG_EXEC_CONTROL,
        MSG_WRITE_FILE,
        guest_control_proto::MSG_WRITE_FILE_STREAM_BEGIN,
        MSG_WRITE_FILES,
        MSG_WRITE_PRIVATE_FILES,
        MSG_GUEST_DNS_READINESS,
        MSG_GUEST_STORAGE_MANIFEST,
        MSG_QUIESCE_OPERATIONS,
        MSG_RESUME_OPERATIONS,
    ] {
        assert!(is_real_host_work_message(msg_type));
    }
}

#[test]
fn stable_connection_resets_reconnect_attempt_streak_before_counting_failure() {
    assert_eq!(next_reconnect_attempts(20, true), 1);
}

#[test]
fn unstable_connection_continues_reconnect_attempt_streak() {
    assert_eq!(next_reconnect_attempts(20, false), 21);
}
