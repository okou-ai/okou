use super::*;

fn exec_result(termination: ExecTermination) -> ExecResult {
    ExecResult {
        termination,
        guest_duration_ms: None,
        stdout: Vec::new(),
        stderr: Vec::new(),
        diagnostic: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    }
}

#[test]
fn helper_exec_success_requires_exited_zero() {
    assert!(helper_exec_succeeded(&exec_result(
        ExecTermination::Exited { exit_code: 0 },
    )));
    assert!(!helper_exec_succeeded(&exec_result(
        ExecTermination::Exited { exit_code: 1 },
    )));
    assert!(!helper_exec_succeeded(&exec_result(
        ExecTermination::TimedOut,
    )));
    assert!(!helper_exec_succeeded(&exec_result(
        ExecTermination::Cancelled,
    )));
    assert!(!helper_exec_succeeded(&exec_result(
        ExecTermination::StartFailed,
    )));
    assert!(!helper_exec_succeeded(&exec_result(
        ExecTermination::WaitFailed,
    )));
}

#[test]
fn exited_failure_keeps_exit_code_wording() {
    let result = exec_result(ExecTermination::Exited { exit_code: 2 });

    let message = format_helper_exec_failure("guest clock sync", &result);

    assert_eq!(message, "guest clock sync failed (exit code 2)");
}

#[test]
fn terminal_state_failures_include_structured_terminal_state() {
    for (termination, expected) in [
        (
            ExecTermination::TimedOut,
            "storage download failed (timed out)",
        ),
        (
            ExecTermination::Cancelled,
            "storage download failed (cancelled)",
        ),
        (
            ExecTermination::StartFailed,
            "storage download failed (start failed)",
        ),
        (
            ExecTermination::WaitFailed,
            "storage download failed (wait failed)",
        ),
    ] {
        let result = exec_result(termination);

        assert_eq!(
            format_helper_exec_failure("storage download", &result),
            expected
        );
    }
}

#[test]
fn failure_formatting_preserves_excerpts_and_truncation_markers() {
    let mut result = exec_result(ExecTermination::TimedOut);
    result.stdout = b"stdout clue".to_vec();
    result.stderr = b"stderr clue".to_vec();
    result.stderr_truncated = true;

    let message = format_helper_exec_failure("storage download", &result);

    assert!(message.contains("storage download failed (timed out"));
    assert!(message.contains("stderr (captured, sandbox-truncated): stderr clue"));
    assert!(message.contains("stdout (captured): stdout clue"));
}

#[test]
fn failure_formatting_includes_structured_diagnostic() {
    let mut result = exec_result(ExecTermination::WaitFailed);
    result.diagnostic = "wait failed inside provider".to_string();

    let message = format_helper_exec_failure("storage download", &result);

    assert!(message.contains("storage download failed (wait failed)"));
    assert!(message.contains("diagnostic (captured): wait failed inside provider"));
}

#[test]
fn command_output_redaction_handles_urls_before_excerpting() {
    let prefix = "archiveUrl=https://storage.example/archive.tar.gz?";
    let secret = "X-Amz-Signature=secret-value-that-must-not-leak";
    let padding_len =
        HELPER_EXEC_OUTPUT_EXCERPT_BYTES + "X-Amz-".len() - secret.len() - " done".len();
    let output = format!("{prefix}{secret}{} done", "a".repeat(padding_len));

    let excerpt = format_command_output_excerpt("stderr", output.as_bytes(), false).unwrap();

    assert!(excerpt.contains("archive.tar.gz?<redacted>"));
    assert!(!excerpt.contains("X-Amz-Signature"));
    assert!(!excerpt.contains("secret-value-that-must-not-leak"));
}

#[test]
fn command_output_redaction_preserves_whitespace_between_urls() {
    let excerpt = format_command_output_excerpt(
            "stderr",
            b"first=https://a.example/archive.tar.gz?token=secret\n\tsecond=http://b.example/logs?key=hidden third=https://c.example/blob?sig=private plain=http://d.example/no-query",
            false,
        )
        .unwrap();

    assert_eq!(
        excerpt,
        "stderr (captured): first=https://a.example/archive.tar.gz?<redacted>\n\tsecond=http://b.example/logs?<redacted> third=https://c.example/blob?<redacted> plain=http://d.example/no-query"
    );
}

#[test]
fn command_output_redaction_handles_case_insensitive_url_schemes() {
    let excerpt = format_command_output_excerpt(
        "stderr",
        b"first=HtTp://a.example/logs?token=secret second=hTtPs://b.example/archive?sig=hidden",
        false,
    )
    .unwrap();

    assert_eq!(
        excerpt,
        "stderr (captured): first=HtTp://a.example/logs?<redacted> second=hTtPs://b.example/archive?<redacted>"
    );
}

#[test]
fn termination_label_is_stable_for_logs() {
    assert_eq!(
        helper_exec_termination_label(&exec_result(ExecTermination::Exited { exit_code: 0 })),
        "exited"
    );
    assert_eq!(
        helper_exec_termination_label(&exec_result(ExecTermination::TimedOut)),
        "timed_out"
    );
    assert_eq!(
        helper_exec_termination_label(&exec_result(ExecTermination::Cancelled)),
        "cancelled"
    );
    assert_eq!(
        helper_exec_termination_label(&exec_result(ExecTermination::StartFailed)),
        "start_failed"
    );
    assert_eq!(
        helper_exec_termination_label(&exec_result(ExecTermination::WaitFailed)),
        "wait_failed"
    );
}
