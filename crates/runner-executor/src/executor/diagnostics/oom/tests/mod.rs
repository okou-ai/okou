use super::*;

const OOM_RECORD: &str = "[42.000000] oom-kill:task=firecracker,pid=42";

#[tokio::test]
async fn timed_out_command_is_not_oom_evidence() {
    let mut command = Command::new("sleep");
    command.arg("60");

    assert!(
        !check_host_oom_command(
            42,
            HostOomEvidenceSince::from_micros(0),
            command,
            Duration::ZERO,
        )
        .await
    );
}

#[tokio::test]
async fn unsuccessful_command_is_not_oom_evidence() {
    let mut command = Command::new("sh");
    command.args(["-c", "printf '%s' \"$1\"; exit 1", "sh", OOM_RECORD]);

    assert!(
        !check_host_oom_command(
            42,
            HostOomEvidenceSince::from_micros(42_000_000),
            command,
            Duration::from_secs(2),
        )
        .await
    );
}

#[tokio::test]
async fn successful_command_captures_stdout_for_oom_detection() {
    let mut command = Command::new("printf");
    command.args(["%s", OOM_RECORD]);

    assert!(
        check_host_oom_command(
            42,
            HostOomEvidenceSince::from_micros(42_000_000),
            command,
            Duration::from_secs(2),
        )
        .await
    );
}
