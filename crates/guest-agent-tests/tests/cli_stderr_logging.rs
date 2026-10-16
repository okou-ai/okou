//! CLI stderr logging must preserve diagnostics without leaking secrets.
//!
//! This test lives in its own binary to isolate process env, working directory,
//! and guest runtime path overrides used during setup.

use guest_agent_tests as common;

use base64::Engine;
use guest_agent::masker::SecretMasker;
use guest_contracts::cli_stderr_diagnostics::{
    CLI_STDERR_OMITTED_LONG_LINE, CLI_STDERR_RESULT_MAX_LINE_BYTES, CLI_STDERR_RESULT_MAX_LINES,
};
use std::time::Duration;

#[tokio::test]
async fn cli_failure_stderr_is_masked_in_result() -> Result<(), Box<dyn std::error::Error>> {
    let mock = common::build_and_locate_mock()?;
    let tmp = tempfile::tempdir()?;
    let secret = "super-secret-value";
    let multiline_secret = concat!(
        "-----BEGIN TEST KEY-----\n",
        "alpha-multiline-secret-fragment\n",
        "beta-multiline-secret-fragment\n",
        "-----END TEST KEY-----\n",
    );
    let short_unicode_multiline_secret = "密ab\n钥cd\n";
    let tail_only_secret = [
        "tail-boundary-start",
        "dropped-tail-fragment-zero",
        "retained-tail-fragment-one",
        "retained-tail-fragment-two",
        "retained-tail-fragment-three",
    ]
    .join("\n");
    let mut stderr_payload = (0..(CLI_STDERR_RESULT_MAX_LINES + 1))
        .map(|i| match i {
            10 => "tail-boundary-start".to_string(),
            11 => "dropped-tail-fragment-zero".to_string(),
            12 => "retained-tail-fragment-one".to_string(),
            13 => "retained-tail-fragment-two".to_string(),
            14 => "retained-tail-fragment-three".to_string(),
            42 => String::new(),
            _ => format!("line-{i}"),
        })
        .collect::<Vec<_>>()
        .join("\n");
    let exact_limit_line = format!(
        "exact-limit-{}",
        "x".repeat(CLI_STDERR_RESULT_MAX_LINE_BYTES - "exact-limit-".len())
    );
    let exact_limit_crlf_line = format!(
        "exact-crlf-{}",
        "x".repeat(CLI_STDERR_RESULT_MAX_LINE_BYTES - "exact-crlf-".len())
    );
    let overlong_secret_line = format!(
        "overlong-secret-prefix-{secret}-{}",
        "x".repeat(CLI_STDERR_RESULT_MAX_LINE_BYTES)
    );
    assert_eq!(exact_limit_line.len(), CLI_STDERR_RESULT_MAX_LINE_BYTES);
    assert_eq!(
        exact_limit_crlf_line.len(),
        CLI_STDERR_RESULT_MAX_LINE_BYTES
    );

    stderr_payload.push_str(&format!("\n{exact_limit_crlf_line}\r"));
    stderr_payload.push_str(&format!("\n{exact_limit_line}"));
    stderr_payload.push_str(&format!("\ncodex stderr includes {secret}"));
    stderr_payload.push_str(&format!("\n{overlong_secret_line}"));
    stderr_payload.push_str("\nafter-overlong-line");
    stderr_payload.push_str("\ncrlf multiline secret begins");
    stderr_payload.push_str("\n-----BEGIN TEST KEY-----\r");
    stderr_payload.push_str("\nalpha-multiline-secret-fragment\r");
    stderr_payload.push_str("\nbeta-multiline-secret-fragment\r");
    stderr_payload.push_str("\n-----END TEST KEY-----");
    stderr_payload.push_str("\nafter-multiline-secret");
    stderr_payload.push_str("\nshort unicode multiline fragments begin");
    stderr_payload.push_str("\n密ab");
    stderr_payload.push_str("\nnon-secret separator");
    stderr_payload.push_str("\n钥cd");
    stderr_payload.push_str("\nshort unicode multiline fragments end");

    unsafe {
        common::setup_env(&mock, tmp.path(), &format!("@fail:{stderr_payload}"), 3, 1)?;
    }

    let runtime = common::guest_runtime_from_process_env()?;

    let engine = base64::engine::general_purpose::STANDARD;
    let encoded_secret = engine.encode(secret);
    let encoded_multiline_secret = engine.encode(multiline_secret);
    let encoded_short_unicode_multiline_secret = engine.encode(short_unicode_multiline_secret);
    let encoded_tail_only_secret = engine.encode(&tail_only_secret);
    let masker = SecretMasker::from_raw(&format!(
        "{encoded_secret},{encoded_multiline_secret},{encoded_short_unicode_multiline_secret},{encoded_tail_only_secret}"
    ));
    let cli_result = tokio::time::timeout(
        Duration::from_secs(5),
        common::execute_cli_for_runtime(&runtime, &masker, common::spawn_dummy_heartbeat()),
    )
    .await
    .expect("execute_cli should return promptly")?;

    assert_eq!(cli_result.exit_code, 1);
    assert_eq!(cli_result.stderr_lines.len(), CLI_STDERR_RESULT_MAX_LINES);
    let stderr = cli_result.stderr_lines.join("\n");
    assert!(
        !cli_result.stderr_lines.iter().any(|line| line == "line-5"),
        "stderr result should drop old lines from the bounded tail, got: {stderr}"
    );
    assert!(
        !stderr.contains("tail-boundary-start") && !stderr.contains("dropped-tail-fragment-zero"),
        "stderr result should drop the first part of the tail-boundary secret, got: {stderr}"
    );
    assert!(
        cli_result.stderr_lines.iter().any(String::is_empty),
        "stderr result should preserve empty stderr lines, got: {stderr}"
    );
    assert!(
        cli_result
            .stderr_lines
            .iter()
            .any(|line| line == &exact_limit_crlf_line),
        "stderr result should strip trailing carriage returns, got: {stderr}"
    );
    assert!(
        !cli_result
            .stderr_lines
            .iter()
            .any(|line| line == &format!("{exact_limit_crlf_line}\r")),
        "stderr result should not keep trailing carriage returns, got: {stderr}"
    );
    assert!(
        stderr.contains("codex stderr includes ***"),
        "stderr result should keep masked diagnostic, got: {stderr}"
    );
    assert!(
        cli_result
            .stderr_lines
            .iter()
            .any(|line| line == &exact_limit_line),
        "stderr result should keep lines at the exact size limit, got: {stderr}"
    );
    assert!(
        stderr.contains(CLI_STDERR_OMITTED_LONG_LINE),
        "stderr result should omit overlong lines, got: {stderr}"
    );
    assert!(
        !stderr.contains("overlong-secret-prefix"),
        "stderr result should not expose omitted overlong line content, got: {stderr}"
    );
    assert!(
        stderr.contains("after-overlong-line"),
        "stderr result should recover after overlong lines, got: {stderr}"
    );
    assert!(
        !stderr.contains(secret),
        "stderr result leaked secret: {stderr}"
    );
    for leaked_fragment in [
        "alpha-multiline-secret-fragment",
        "beta-multiline-secret-fragment",
        "retained-tail-fragment-one",
        "retained-tail-fragment-two",
        "retained-tail-fragment-three",
        "密ab",
        "钥cd",
    ] {
        assert!(
            !stderr.contains(leaked_fragment),
            "stderr result leaked multiline secret fragment {leaked_fragment:?}: {stderr}"
        );
    }
    assert!(
        !stderr.contains(multiline_secret.trim_end_matches('\n')),
        "stderr result leaked multiline secret: {stderr}"
    );
    assert!(
        stderr.contains("crlf multiline secret begins"),
        "stderr result should preserve non-secret multiline context, got: {stderr}"
    );
    assert!(
        stderr.contains("after-multiline-secret"),
        "stderr result should preserve text after multiline secret, got: {stderr}"
    );

    Ok(())
}
