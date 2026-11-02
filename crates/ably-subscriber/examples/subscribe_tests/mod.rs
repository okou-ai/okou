use std::process::Command;

use super::init_tracing;

#[test]
fn tracing_diagnostics_are_separate_from_json_message_output() {
    const CHILD_ENV: &str = "ABLY_SUBSCRIBE_OUTPUT_TEST_CHILD";
    let message = serde_json::json!({"message": "ok"});

    if std::env::var_os(CHILD_ENV).is_some() {
        init_tracing().expect("initialize example tracing");
        tracing::info!(target: "subscribe_output_test", "info diagnostic");
        tracing::debug!(target: "subscribe_output_test", "debug diagnostic");
        println!("{message}");
        return;
    }

    // Each child uses the production initializer and real process streams,
    // isolating both the global subscriber and RUST_LOG from other tests.
    for (rust_log, expect_info, expect_debug, expect_warning) in [
        (None, true, false, false),
        (Some("debug"), true, true, false),
        (Some("off"), false, false, false),
        (Some("subscribe_output_test=debug"), true, true, false),
        (Some("other_target=debug"), false, false, false),
        (Some(""), false, false, false),
        (Some("subscribe_output_test=invalid"), false, false, true),
    ] {
        let mut command = Command::new(std::env::current_exe().expect("test executable"));
        command
            .args([
                "--exact",
                "subscribe_tests::tracing_diagnostics_are_separate_from_json_message_output",
                "--nocapture",
                "--quiet",
            ])
            .env(CHILD_ENV, "1")
            .env_remove("RUST_LOG");
        if let Some(rust_log) = rust_log {
            command.env("RUST_LOG", rust_log);
        }

        let output = command.output().expect("run example output probe");
        let stdout = String::from_utf8(output.stdout).expect("stdout is UTF-8");
        let stderr = String::from_utf8(output.stderr).expect("stderr is UTF-8");
        assert!(output.status.success(), "RUST_LOG={rust_log:?}: {stderr}");
        assert!(!stdout.contains("diagnostic"), "{stdout}");
        assert!(!stdout.contains("Ignoring `RUST_LOG"), "{stdout}");

        // The test harness also writes progress to stdout; parse the actual
        // payload line and check diagnostics against the entire stream.
        let payload = stdout
            .lines()
            .find(|line| line.starts_with('{'))
            .expect("JSON message on stdout");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(payload).expect("parse message JSON"),
            message,
        );
        assert_eq!(
            stderr.contains("info diagnostic"),
            expect_info,
            "RUST_LOG={rust_log:?}: {stderr}",
        );
        assert_eq!(
            stderr.contains("debug diagnostic"),
            expect_debug,
            "RUST_LOG={rust_log:?}: {stderr}",
        );
        assert_eq!(
            stderr.contains("Ignoring `RUST_LOG"),
            expect_warning,
            "RUST_LOG={rust_log:?}: {stderr}",
        );
    }
}
