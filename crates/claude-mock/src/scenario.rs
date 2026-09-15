use serde_json::Value;

const ACTIVE_INPUT_SMOKE_MARKER: &str = "@active-input-smoke:";
const ACTIVE_INPUT_SMOKE_READY_MARKER: &str = "@active-input-smoke-ready:";
const ECHO_HANG_MARKER: &str = "@ECHO-HANG@";
const ECHO_MARKER: &str = "@ECHO@";
const FAIL_NO_NEWLINE_MARKER: &str = "@fail-no-newline:";
const FAIL_INVALID_UTF8_MARKER: &str = "@fail-invalid-utf8";
const FAIL_INVALID_UTF8_LONG_MARKER: &str = "@fail-invalid-utf8-long";
const FAIL_MARKER: &str = "@fail:";
const STDOUT_OVER_LIMIT_NO_NEWLINE_MARKER: &str = "@stdout-over-limit-no-newline";
const STDOUT_OVER_LIMIT_NEWLINE_MARKER: &str = "@stdout-over-limit-newline";
const STDOUT_INVALID_UTF8_MARKER: &str = "@stdout-invalid-utf8";
const STDOUT_RECORD_BOUNDARIES_MARKER: &str = "@stdout-record-boundaries";
const STUCK_TOOL_CLOSED_STDOUT_DEAF_MARKER: &str = "@stuck-tool-closed-stdout-deaf";
const STUCK_TOOL_DEAF_MARKER: &str = "@stuck-tool-deaf";
const STUCK_TOOL_MARKER: &str = "@stuck-tool";
const ORPHAN_PIPE_MARKER: &str = "@orphan-pipe";
const HANG_AFTER_RESULT_DEAF_MARKER: &str = "@hang-after-result-deaf";
const HANG_AFTER_RESULT_THEN_EVENT_MARKER: &str = "@hang-after-result-then-event";
const HANG_AFTER_RESULT_PERIODIC_EVENTS_MARKER: &str = "@hang-after-result-periodic-events";
const HANG_AFTER_ERROR_RESULT_MARKER: &str = "@hang-after-error-result";
const EXIT_AFTER_RESULT_MARKER: &str = "@exit-after-result";
const WRITE_ENV_JSON_MARKER: &str = "@write-env-json:";
const APPEND_PROMPT_TRANSPORT_MARKER: &str = "@append-prompt-transport:";
const PARALLEL_SHELL_TOOL_OOM_MARKER: &str = "@parallel-shell-tool-oom";
const GUEST_WIDE_TOOL_OOM_MARKER: &str = "@guest-wide-tool-oom";
const RUNTIME_ONLY_OOM_MARKER: &str = "@runtime-only-oom";
const HANG_AFTER_RESULT_MARKER: &str = "@hang-after-result";

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum MockScenario<'a> {
    ActiveInputSmoke { expected_follow_ups: usize },
    ActiveInputSmokeReady { expected_follow_ups: usize },
    InvalidActiveInputSmokeCount(&'a str),
    InvalidActiveInputSmokeReadyCount(&'a str),
    EchoJsonl(&'a str),
    EchoJsonlAndHang(&'a str),
    FailNoNewline(&'a str),
    FailInvalidUtf8,
    FailInvalidUtf8Long,
    Fail(&'a str),
    StdoutOverLimit { newline: bool },
    StdoutInvalidUtf8,
    StdoutRecordBoundaries,
    StuckTool { deaf: bool, close_stdout: bool },
    OrphanPipe,
    HangAfterResult { deaf: bool },
    HangAfterResultThenEvent,
    HangAfterResultPeriodicEvents,
    HangAfterErrorResult,
    ExitAfterResult,
    WriteEnvJson(&'a str),
    AppendPromptTransport(&'a str),
    ParallelShellToolOom,
    GuestWideToolOom,
    RuntimeOnlyOom,
    Shell,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ScenarioMatchKind {
    Exact,
    Prefix,
    PrefixPayload,
    FirstLinePayload,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ScenarioKind {
    ActiveInputSmoke,
    ActiveInputSmokeReady,
    EchoJsonl,
    EchoJsonlAndHang,
    FailNoNewline,
    FailInvalidUtf8,
    FailInvalidUtf8Long,
    Fail,
    StdoutOverLimit { newline: bool },
    StdoutInvalidUtf8,
    StdoutRecordBoundaries,
    StuckTool { deaf: bool, close_stdout: bool },
    OrphanPipe,
    HangAfterResult { deaf: bool },
    HangAfterResultThenEvent,
    HangAfterResultPeriodicEvents,
    HangAfterErrorResult,
    ExitAfterResult,
    WriteEnvJson,
    AppendPromptTransport,
    ParallelShellToolOom,
    GuestWideToolOom,
    RuntimeOnlyOom,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ScenarioRule {
    marker: &'static str,
    match_kind: ScenarioMatchKind,
    scenario_kind: ScenarioKind,
}

enum ScenarioMatch<'a> {
    Marker,
    Payload(&'a str),
}

const SCENARIO_RULES: &[ScenarioRule] = &[
    ScenarioRule {
        marker: ACTIVE_INPUT_SMOKE_MARKER,
        match_kind: ScenarioMatchKind::PrefixPayload,
        scenario_kind: ScenarioKind::ActiveInputSmoke,
    },
    ScenarioRule {
        marker: ACTIVE_INPUT_SMOKE_READY_MARKER,
        match_kind: ScenarioMatchKind::PrefixPayload,
        scenario_kind: ScenarioKind::ActiveInputSmokeReady,
    },
    ScenarioRule {
        marker: ECHO_HANG_MARKER,
        match_kind: ScenarioMatchKind::FirstLinePayload,
        scenario_kind: ScenarioKind::EchoJsonlAndHang,
    },
    ScenarioRule {
        marker: ECHO_MARKER,
        match_kind: ScenarioMatchKind::FirstLinePayload,
        scenario_kind: ScenarioKind::EchoJsonl,
    },
    ScenarioRule {
        marker: FAIL_NO_NEWLINE_MARKER,
        match_kind: ScenarioMatchKind::PrefixPayload,
        scenario_kind: ScenarioKind::FailNoNewline,
    },
    ScenarioRule {
        marker: FAIL_INVALID_UTF8_MARKER,
        match_kind: ScenarioMatchKind::Exact,
        scenario_kind: ScenarioKind::FailInvalidUtf8,
    },
    ScenarioRule {
        marker: FAIL_INVALID_UTF8_LONG_MARKER,
        match_kind: ScenarioMatchKind::Exact,
        scenario_kind: ScenarioKind::FailInvalidUtf8Long,
    },
    ScenarioRule {
        marker: FAIL_MARKER,
        match_kind: ScenarioMatchKind::PrefixPayload,
        scenario_kind: ScenarioKind::Fail,
    },
    ScenarioRule {
        marker: STDOUT_OVER_LIMIT_NO_NEWLINE_MARKER,
        match_kind: ScenarioMatchKind::Exact,
        scenario_kind: ScenarioKind::StdoutOverLimit { newline: false },
    },
    ScenarioRule {
        marker: STDOUT_OVER_LIMIT_NEWLINE_MARKER,
        match_kind: ScenarioMatchKind::Exact,
        scenario_kind: ScenarioKind::StdoutOverLimit { newline: true },
    },
    ScenarioRule {
        marker: STDOUT_INVALID_UTF8_MARKER,
        match_kind: ScenarioMatchKind::Exact,
        scenario_kind: ScenarioKind::StdoutInvalidUtf8,
    },
    ScenarioRule {
        marker: STDOUT_RECORD_BOUNDARIES_MARKER,
        match_kind: ScenarioMatchKind::Exact,
        scenario_kind: ScenarioKind::StdoutRecordBoundaries,
    },
    ScenarioRule {
        marker: STUCK_TOOL_CLOSED_STDOUT_DEAF_MARKER,
        match_kind: ScenarioMatchKind::Prefix,
        scenario_kind: ScenarioKind::StuckTool {
            deaf: true,
            close_stdout: true,
        },
    },
    ScenarioRule {
        marker: STUCK_TOOL_DEAF_MARKER,
        match_kind: ScenarioMatchKind::Prefix,
        scenario_kind: ScenarioKind::StuckTool {
            deaf: true,
            close_stdout: false,
        },
    },
    ScenarioRule {
        marker: STUCK_TOOL_MARKER,
        match_kind: ScenarioMatchKind::Prefix,
        scenario_kind: ScenarioKind::StuckTool {
            deaf: false,
            close_stdout: false,
        },
    },
    ScenarioRule {
        marker: ORPHAN_PIPE_MARKER,
        match_kind: ScenarioMatchKind::Prefix,
        scenario_kind: ScenarioKind::OrphanPipe,
    },
    ScenarioRule {
        marker: HANG_AFTER_RESULT_DEAF_MARKER,
        match_kind: ScenarioMatchKind::Prefix,
        scenario_kind: ScenarioKind::HangAfterResult { deaf: true },
    },
    ScenarioRule {
        marker: HANG_AFTER_RESULT_THEN_EVENT_MARKER,
        match_kind: ScenarioMatchKind::Prefix,
        scenario_kind: ScenarioKind::HangAfterResultThenEvent,
    },
    ScenarioRule {
        marker: HANG_AFTER_RESULT_PERIODIC_EVENTS_MARKER,
        match_kind: ScenarioMatchKind::Prefix,
        scenario_kind: ScenarioKind::HangAfterResultPeriodicEvents,
    },
    ScenarioRule {
        marker: HANG_AFTER_ERROR_RESULT_MARKER,
        match_kind: ScenarioMatchKind::Prefix,
        scenario_kind: ScenarioKind::HangAfterErrorResult,
    },
    ScenarioRule {
        marker: EXIT_AFTER_RESULT_MARKER,
        match_kind: ScenarioMatchKind::Prefix,
        scenario_kind: ScenarioKind::ExitAfterResult,
    },
    ScenarioRule {
        marker: WRITE_ENV_JSON_MARKER,
        match_kind: ScenarioMatchKind::PrefixPayload,
        scenario_kind: ScenarioKind::WriteEnvJson,
    },
    ScenarioRule {
        marker: APPEND_PROMPT_TRANSPORT_MARKER,
        match_kind: ScenarioMatchKind::PrefixPayload,
        scenario_kind: ScenarioKind::AppendPromptTransport,
    },
    ScenarioRule {
        marker: PARALLEL_SHELL_TOOL_OOM_MARKER,
        match_kind: ScenarioMatchKind::Exact,
        scenario_kind: ScenarioKind::ParallelShellToolOom,
    },
    ScenarioRule {
        marker: GUEST_WIDE_TOOL_OOM_MARKER,
        match_kind: ScenarioMatchKind::Exact,
        scenario_kind: ScenarioKind::GuestWideToolOom,
    },
    ScenarioRule {
        marker: RUNTIME_ONLY_OOM_MARKER,
        match_kind: ScenarioMatchKind::Exact,
        scenario_kind: ScenarioKind::RuntimeOnlyOom,
    },
    ScenarioRule {
        marker: HANG_AFTER_RESULT_MARKER,
        match_kind: ScenarioMatchKind::Prefix,
        scenario_kind: ScenarioKind::HangAfterResult { deaf: false },
    },
];

impl ScenarioRule {
    fn parse<'a>(&self, prompt: &'a str) -> Option<MockScenario<'a>> {
        let scenario_match = match self.match_kind {
            ScenarioMatchKind::Exact if prompt == self.marker => ScenarioMatch::Marker,
            ScenarioMatchKind::Prefix if prompt.starts_with(self.marker) => ScenarioMatch::Marker,
            ScenarioMatchKind::PrefixPayload => {
                ScenarioMatch::Payload(prompt.strip_prefix(self.marker)?)
            }
            ScenarioMatchKind::FirstLinePayload => {
                ScenarioMatch::Payload(first_line_payload(prompt, self.marker)?)
            }
            _ => return None,
        };

        self.scenario_kind.to_mock_scenario(scenario_match)
    }
}

impl ScenarioKind {
    fn to_mock_scenario<'a>(self, scenario_match: ScenarioMatch<'a>) -> Option<MockScenario<'a>> {
        let scenario = match (self, scenario_match) {
            (Self::ActiveInputSmoke, ScenarioMatch::Payload(payload)) => {
                parse_active_input_smoke(payload, false)
            }
            (Self::ActiveInputSmokeReady, ScenarioMatch::Payload(payload)) => {
                parse_active_input_smoke(payload, true)
            }
            (Self::EchoJsonl, ScenarioMatch::Payload(payload)) => MockScenario::EchoJsonl(payload),
            (Self::EchoJsonlAndHang, ScenarioMatch::Payload(payload)) => {
                MockScenario::EchoJsonlAndHang(payload)
            }
            (Self::FailNoNewline, ScenarioMatch::Payload(msg)) => MockScenario::FailNoNewline(msg),
            (Self::Fail, ScenarioMatch::Payload(msg)) => MockScenario::Fail(msg),
            (Self::WriteEnvJson, ScenarioMatch::Payload(path)) => MockScenario::WriteEnvJson(path),
            (Self::AppendPromptTransport, ScenarioMatch::Payload(payload)) => {
                MockScenario::AppendPromptTransport(payload)
            }
            (Self::FailInvalidUtf8, ScenarioMatch::Marker) => MockScenario::FailInvalidUtf8,
            (Self::FailInvalidUtf8Long, ScenarioMatch::Marker) => MockScenario::FailInvalidUtf8Long,
            (Self::StdoutOverLimit { newline }, ScenarioMatch::Marker) => {
                MockScenario::StdoutOverLimit { newline }
            }
            (Self::StdoutInvalidUtf8, ScenarioMatch::Marker) => MockScenario::StdoutInvalidUtf8,
            (Self::StdoutRecordBoundaries, ScenarioMatch::Marker) => {
                MockScenario::StdoutRecordBoundaries
            }
            (Self::StuckTool { deaf, close_stdout }, ScenarioMatch::Marker) => {
                MockScenario::StuckTool { deaf, close_stdout }
            }
            (Self::OrphanPipe, ScenarioMatch::Marker) => MockScenario::OrphanPipe,
            (Self::HangAfterResult { deaf }, ScenarioMatch::Marker) => {
                MockScenario::HangAfterResult { deaf }
            }
            (Self::HangAfterResultThenEvent, ScenarioMatch::Marker) => {
                MockScenario::HangAfterResultThenEvent
            }
            (Self::HangAfterResultPeriodicEvents, ScenarioMatch::Marker) => {
                MockScenario::HangAfterResultPeriodicEvents
            }
            (Self::HangAfterErrorResult, ScenarioMatch::Marker) => {
                MockScenario::HangAfterErrorResult
            }
            (Self::ExitAfterResult, ScenarioMatch::Marker) => MockScenario::ExitAfterResult,
            (Self::ParallelShellToolOom, ScenarioMatch::Marker) => {
                MockScenario::ParallelShellToolOom
            }
            (Self::GuestWideToolOom, ScenarioMatch::Marker) => MockScenario::GuestWideToolOom,
            (Self::RuntimeOnlyOom, ScenarioMatch::Marker) => MockScenario::RuntimeOnlyOom,
            _ => return None,
        };

        Some(scenario)
    }
}

fn parse_active_input_smoke<'a>(
    payload: &'a str,
    ready_after_first_follow_up: bool,
) -> MockScenario<'a> {
    match payload.parse::<usize>() {
        Ok(expected_follow_ups) if expected_follow_ups > 0 => {
            if ready_after_first_follow_up {
                MockScenario::ActiveInputSmokeReady {
                    expected_follow_ups,
                }
            } else {
                MockScenario::ActiveInputSmoke {
                    expected_follow_ups,
                }
            }
        }
        _ if ready_after_first_follow_up => {
            MockScenario::InvalidActiveInputSmokeReadyCount(payload)
        }
        _ => MockScenario::InvalidActiveInputSmokeCount(payload),
    }
}

impl<'a> MockScenario<'a> {
    pub(crate) fn from_prompt(prompt: &'a str) -> Self {
        SCENARIO_RULES
            .iter()
            .find_map(|rule| rule.parse(prompt))
            .unwrap_or(Self::Shell)
    }
}

fn first_line_payload<'a>(prompt: &'a str, marker: &str) -> Option<&'a str> {
    let (first_line, payload) = prompt.split_once('\n').unwrap_or((prompt, ""));
    if first_line.trim_end_matches('\r') == marker {
        return Some(payload);
    }
    None
}

pub(crate) fn parse_echo_jsonl(payload: &str) -> Result<Vec<(String, Value)>, String> {
    let mut events = Vec::new();
    for (index, line) in payload.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let event = serde_json::from_str::<Value>(line)
            .map_err(|e| format!("invalid {ECHO_MARKER} JSONL line {}: {e}", index + 2))?;
        events.push((line.to_string(), event));
    }

    if events.is_empty() {
        return Err(format!(
            "{ECHO_MARKER} payload must contain at least one JSONL event"
        ));
    }

    Ok(events)
}

pub(crate) fn echo_session_id(events: &[(String, Value)]) -> Option<&str> {
    events.iter().find_map(|(_, event)| {
        let event_type = event.get("type").and_then(Value::as_str)?;
        let subtype = event.get("subtype").and_then(Value::as_str)?;
        if event_type != "system" || subtype != "init" {
            return None;
        }
        event.get("session_id").and_then(Value::as_str)
    })
}

#[cfg(test)]
mod tests {
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
            ("@runtime-only-oom", MockScenario::RuntimeOnlyOom),
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
            marker_position(HANG_AFTER_RESULT_DEAF_MARKER)
                < marker_position(HANG_AFTER_RESULT_MARKER)
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
            parse_echo_jsonl(r#"{"type":"system","subtype":"init","session_id":"preview-1"}"#)
                .unwrap();
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
}
