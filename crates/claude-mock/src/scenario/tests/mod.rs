use super::*;
use std::collections::HashSet;

#[test]
fn scenario_rules_have_unique_markers() {
    let mut markers = HashSet::new();
    for rule in SCENARIO_RULES {
        assert!(
            markers.insert(rule.marker),
            "duplicate marker {}",
            rule.marker
        );
    }
}

#[test]
fn classifies_all_scenario_rules() {
    let cases = [
        (
            "@active-input-smoke:2",
            MockScenario::ActiveInputSmoke {
                expected_follow_ups: 2,
            },
        ),
        (
            "@active-input-smoke-ready:2",
            MockScenario::ActiveInputSmokeReady {
                expected_follow_ups: 2,
            },
        ),
        (
            "@ECHO-HANG@\n{\"type\":\"result\"}",
            MockScenario::EchoJsonlAndHang("{\"type\":\"result\"}"),
        ),
        (
            "@ECHO@\n{\"type\":\"result\"}",
            MockScenario::EchoJsonl("{\"type\":\"result\"}"),
        ),
        (
            "@fail-no-newline:partial stderr",
            MockScenario::FailNoNewline("partial stderr"),
        ),
        ("@fail-invalid-utf8", MockScenario::FailInvalidUtf8),
        ("@fail-invalid-utf8-long", MockScenario::FailInvalidUtf8Long),
        ("@fail:boom", MockScenario::Fail("boom")),
        (
            "@stdout-over-limit-no-newline",
            MockScenario::StdoutOverLimit { newline: false },
        ),
        (
            "@stdout-over-limit-newline",
            MockScenario::StdoutOverLimit { newline: true },
        ),
        ("@stdout-invalid-utf8", MockScenario::StdoutInvalidUtf8),
        (
            "@stdout-record-boundaries",
            MockScenario::StdoutRecordBoundaries,
        ),
        (
            "@stuck-tool-closed-stdout-deaf",
            MockScenario::StuckTool {
                deaf: true,
                close_stdout: true,
            },
        ),
        (
            "@stuck-tool-deaf",
            MockScenario::StuckTool {
                deaf: true,
                close_stdout: false,
            },
        ),
        (
            "@stuck-tool",
            MockScenario::StuckTool {
                deaf: false,
                close_stdout: false,
            },
        ),
        ("@orphan-pipe", MockScenario::OrphanPipe),
        (
            "@hang-after-result-deaf",
            MockScenario::HangAfterResult { deaf: true },
        ),
        (
            "@hang-after-result-then-event",
            MockScenario::HangAfterResultThenEvent,
        ),
        (
            "@hang-after-result-periodic-events",
            MockScenario::HangAfterResultPeriodicEvents,
        ),
        (
            "@hang-after-error-result",
            MockScenario::HangAfterErrorResult,
        ),
        ("@exit-after-result", MockScenario::ExitAfterResult),
        (
            "@write-env-json:/tmp/env.json",
            MockScenario::WriteEnvJson("/tmp/env.json"),
        ),
        (
            "@append-prompt-transport:{\"expectedPrompt\":\"marker\"}",
            MockScenario::AppendPromptTransport("{\"expectedPrompt\":\"marker\"}"),
        ),
        (
            "@parallel-shell-tool-oom",
            MockScenario::ParallelShellToolOom,
        ),
        ("@guest-wide-tool-oom", MockScenario::GuestWideToolOom),
        (
            "@guest-wide-tool-oom-injected",
            MockScenario::GuestWideToolOomInjected,
        ),
        ("@runtime-only-oom", MockScenario::RuntimeOnlyOom),
        ("@managed-task-oom", MockScenario::ManagedTaskOom),
        ("@guest-wide-task-oom", MockScenario::GuestWideTaskOom),
        (
            "@guest-wide-task-oom-injected",
            MockScenario::GuestWideTaskOomInjected,
        ),
        (
            "@hang-after-result",
            MockScenario::HangAfterResult { deaf: false },
        ),
    ];

    assert_eq!(cases.len(), SCENARIO_RULES.len());
    for (prompt, expected) in cases {
        assert_eq!(MockScenario::from_prompt(prompt), expected);
    }
}

#[test]
fn keeps_overlap_markers_before_shorter_prefixes() {
    fn marker_position(marker: &str) -> usize {
        SCENARIO_RULES
            .iter()
            .position(|rule| rule.marker == marker)
            .unwrap_or_else(|| panic!("missing marker {marker}"))
    }

    assert!(
        marker_position(STUCK_TOOL_CLOSED_STDOUT_DEAF_MARKER)
            < marker_position(STUCK_TOOL_DEAF_MARKER)
    );
    assert!(marker_position(STUCK_TOOL_DEAF_MARKER) < marker_position(STUCK_TOOL_MARKER));
    assert!(
        marker_position(HANG_AFTER_RESULT_DEAF_MARKER) < marker_position(HANG_AFTER_RESULT_MARKER)
    );
    assert!(
        marker_position(HANG_AFTER_RESULT_THEN_EVENT_MARKER)
            < marker_position(HANG_AFTER_RESULT_MARKER)
    );
    assert!(
        marker_position(HANG_AFTER_RESULT_PERIODIC_EVENTS_MARKER)
            < marker_position(HANG_AFTER_RESULT_MARKER)
    );
}

#[test]
fn classifies_echo_jsonl_with_crlf_marker() {
    assert_eq!(
        MockScenario::from_prompt("@ECHO@\r\n{\"type\":\"result\"}"),
        MockScenario::EchoJsonl("{\"type\":\"result\"}")
    );
}

#[test]
fn does_not_classify_marker_with_extra_text_as_echo_jsonl() {
    assert_eq!(
        MockScenario::from_prompt("@ECHO@ please\n{\"type\":\"result\"}"),
        MockScenario::Shell
    );
}

#[test]
fn exact_markers_reject_suffixes() {
    assert_eq!(
        MockScenario::from_prompt("@fail-invalid-utf8-suffix"),
        MockScenario::Shell
    );
    assert_eq!(
        MockScenario::from_prompt("@fail-invalid-utf8-long-suffix"),
        MockScenario::Shell
    );
    assert_eq!(
        MockScenario::from_prompt("@stdout-over-limit-no-newline-suffix"),
        MockScenario::Shell
    );
    assert_eq!(
        MockScenario::from_prompt("@stdout-over-limit-newline-suffix"),
        MockScenario::Shell
    );
    assert_eq!(
        MockScenario::from_prompt("@stdout-invalid-utf8-suffix"),
        MockScenario::Shell
    );
    assert_eq!(
        MockScenario::from_prompt("@stdout-record-boundaries-suffix"),
        MockScenario::Shell
    );
    assert_eq!(
        MockScenario::from_prompt("@parallel-shell-tool-oom-suffix"),
        MockScenario::Shell
    );
}

#[test]
fn prefix_markers_accept_suffixes() {
    let cases = [
        (
            "@stuck-tool-closed-stdout-deaf with suffix",
            MockScenario::StuckTool {
                deaf: true,
                close_stdout: true,
            },
        ),
        (
            "@stuck-tool-deaf with suffix",
            MockScenario::StuckTool {
                deaf: true,
                close_stdout: false,
            },
        ),
        (
            "@stuck-tool with suffix",
            MockScenario::StuckTool {
                deaf: false,
                close_stdout: false,
            },
        ),
        ("@orphan-pipe with suffix", MockScenario::OrphanPipe),
        (
            "@hang-after-result-deaf with suffix",
            MockScenario::HangAfterResult { deaf: true },
        ),
        (
            "@exit-after-result with suffix",
            MockScenario::ExitAfterResult,
        ),
        (
            "@hang-after-result with suffix",
            MockScenario::HangAfterResult { deaf: false },
        ),
    ];

    for (prompt, expected) in cases {
        assert_eq!(MockScenario::from_prompt(prompt), expected);
    }
}

#[test]
fn payload_markers_keep_remainder_as_payload() {
    assert_eq!(
        MockScenario::from_prompt("@active-input-smoke:not-a-number"),
        MockScenario::InvalidActiveInputSmokeCount("not-a-number")
    );
    assert_eq!(
        MockScenario::from_prompt("@active-input-smoke:0"),
        MockScenario::InvalidActiveInputSmokeCount("0")
    );
    assert_eq!(
        MockScenario::from_prompt("@active-input-smoke-ready:not-a-number"),
        MockScenario::InvalidActiveInputSmokeReadyCount("not-a-number")
    );
    assert_eq!(
        MockScenario::from_prompt("@active-input-smoke-ready:0"),
        MockScenario::InvalidActiveInputSmokeReadyCount("0")
    );
    assert_eq!(
        MockScenario::from_prompt("@fail-no-newline:"),
        MockScenario::FailNoNewline("")
    );
    assert_eq!(
        MockScenario::from_prompt("@fail:message:with:colon"),
        MockScenario::Fail("message:with:colon")
    );
    assert_eq!(
        MockScenario::from_prompt("@write-env-json:/tmp/env:with:colon.json"),
        MockScenario::WriteEnvJson("/tmp/env:with:colon.json")
    );
}

#[test]
fn classifies_ordinary_prompt_as_shell() {
    assert_eq!(MockScenario::from_prompt("echo hello"), MockScenario::Shell);
}

#[test]
fn parses_echo_jsonl_non_empty_lines() {
    let events =
        parse_echo_jsonl(r#"{"type":"system","subtype":"init","session_id":"preview-1"}"#).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].1["type"], "system");
}

#[test]
fn rejects_invalid_echo_jsonl() {
    let err = parse_echo_jsonl(r#"{"type":"system""#).unwrap_err();
    assert!(err.contains("invalid @ECHO@ JSONL line 2"));
}

#[test]
fn rejects_empty_echo_jsonl_payload() {
    let err = parse_echo_jsonl("\n\n").unwrap_err();
    assert_eq!(err, "@ECHO@ payload must contain at least one JSONL event");
}
