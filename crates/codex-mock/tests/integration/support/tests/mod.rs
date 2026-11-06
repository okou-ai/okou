use super::*;

#[test]
fn output_with_timeout_drains_large_stdout_and_stderr() {
    let mut command = Command::new("sh");
    command.args([
        "-c",
        "head -c 262144 /dev/zero & head -c 262144 /dev/zero >&2 & wait",
    ]);

    let output = output_with_timeout_before_kill(
        command,
        &["large-output"],
        Duration::from_secs(2),
        Duration::from_secs(1),
        |_| {},
    )
    .unwrap();

    assert_eq!(output.stdout, vec![0; 262_144]);
    assert_eq!(output.stderr, vec![0; 262_144]);
}

#[test]
fn output_with_timeout_does_not_join_a_descendant_held_pipe() {
    let mut command = Command::new("sh");
    command.args(["-c", "sleep 1 &"]);
    let started = Instant::now();

    let error = output_with_timeout_before_kill(
        command,
        &["descendant-held-pipe"],
        Duration::from_millis(100),
        Duration::from_millis(30),
        |_| {},
    )
    .unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    assert_eq!(
        error.to_string(),
        "stdout did not close before the child output deadline"
    );
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "output deadline should bound reader completion"
    );
}
