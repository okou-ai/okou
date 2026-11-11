use super::*;

#[test]
fn journalctl_logs_status_allows_successful_exit() {
    use std::os::unix::process::ExitStatusExt;

    let status = ExitStatus::from_raw(0);

    assert!(journalctl_logs_status("vm0-runner-test.service", status).is_ok());
}

#[test]
fn journalctl_logs_status_rejects_failed_exit() {
    use std::os::unix::process::ExitStatusExt;

    let status = ExitStatus::from_raw(0x100);
    let err = journalctl_logs_status("vm0-runner-test.service", status).unwrap_err();

    assert!(
        matches!(err, HostError::Internal(message) if message.contains("journalctl for vm0-runner-test.service exited with"))
    );
}

#[test]
fn journalctl_logs_status_allows_sigpipe() {
    use std::os::unix::process::ExitStatusExt;

    let status = ExitStatus::from_raw(libc::SIGPIPE);

    assert!(journalctl_logs_status("vm0-runner-test.service", status).is_ok());
}
