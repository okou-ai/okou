use serde_json::Value;

const ACTIVE_INPUT_SMOKE_MARKER: &str = "@active-input-smoke:";
const ACTIVE_INPUT_SMOKE_READY_MARKER: &str = "@active-input-smoke-ready:";
const ECHO_HANG_MARKER: &str = "@ECHO-HANG@";
const ECHO_MARKER: &str = "@ECHO@";
const ECHO_FILE_MARKER: &str = "@ECHO-FILE@";
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
const GUEST_WIDE_TOOL_OOM_INJECTED_MARKER: &str = "@guest-wide-tool-oom-injected";
const MANAGED_TASK_OOM_MARKER: &str = "@managed-task-oom";
const GUEST_WIDE_TASK_OOM_MARKER: &str = "@guest-wide-task-oom";
const GUEST_WIDE_TASK_OOM_INJECTED_MARKER: &str = "@guest-wide-task-oom-injected";
const RUNTIME_ONLY_OOM_MARKER: &str = "@runtime-only-oom";
const HANG_AFTER_RESULT_MARKER: &str = "@hang-after-result";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MockScenario<'a> {
    ActiveInputSmoke { expected_follow_ups: usize },
    ActiveInputSmokeReady { expected_follow_ups: usize },
    InvalidActiveInputSmokeCount(&'a str),
    InvalidActiveInputSmokeReadyCount(&'a str),
    EchoJsonl(&'a str),
    EchoJsonlAndHang(&'a str),
    EchoJsonlFile(&'a str),
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
    GuestWideToolOomInjected,
    ManagedTaskOom,
    GuestWideTaskOom,
    GuestWideTaskOomInjected,
    RuntimeOnlyOom,
    Shell,
}

enum ScenarioMatcher {
    Exact(MockScenario<'static>),
    Prefix(MockScenario<'static>),
    PrefixPayload(for<'a> fn(&'a str) -> MockScenario<'a>),
    FirstLinePayload(for<'a> fn(&'a str) -> MockScenario<'a>),
}

struct ScenarioRule {
    marker: &'static str,
    matcher: ScenarioMatcher,
}

const SCENARIO_RULES: &[ScenarioRule] = &[
    ScenarioRule {
        marker: ACTIVE_INPUT_SMOKE_MARKER,
        matcher: ScenarioMatcher::PrefixPayload(|payload| parse_active_input_smoke(payload, false)),
    },
    ScenarioRule {
        marker: ACTIVE_INPUT_SMOKE_READY_MARKER,
        matcher: ScenarioMatcher::PrefixPayload(|payload| parse_active_input_smoke(payload, true)),
    },
    ScenarioRule {
        marker: ECHO_HANG_MARKER,
        matcher: ScenarioMatcher::FirstLinePayload(|payload| {
            MockScenario::EchoJsonlAndHang(payload)
        }),
    },
    ScenarioRule {
        marker: ECHO_MARKER,
        matcher: ScenarioMatcher::FirstLinePayload(|payload| MockScenario::EchoJsonl(payload)),
    },
    ScenarioRule {
        marker: ECHO_FILE_MARKER,
        matcher: ScenarioMatcher::FirstLinePayload(|path| MockScenario::EchoJsonlFile(path)),
    },
    ScenarioRule {
        marker: FAIL_NO_NEWLINE_MARKER,
        matcher: ScenarioMatcher::PrefixPayload(|msg| MockScenario::FailNoNewline(msg)),
    },
    ScenarioRule {
        marker: FAIL_INVALID_UTF8_MARKER,
        matcher: ScenarioMatcher::Exact(MockScenario::FailInvalidUtf8),
    },
    ScenarioRule {
        marker: FAIL_INVALID_UTF8_LONG_MARKER,
        matcher: ScenarioMatcher::Exact(MockScenario::FailInvalidUtf8Long),
    },
    ScenarioRule {
        marker: FAIL_MARKER,
        matcher: ScenarioMatcher::PrefixPayload(|msg| MockScenario::Fail(msg)),
    },
    ScenarioRule {
        marker: STDOUT_OVER_LIMIT_NO_NEWLINE_MARKER,
        matcher: ScenarioMatcher::Exact(MockScenario::StdoutOverLimit { newline: false }),
    },
    ScenarioRule {
        marker: STDOUT_OVER_LIMIT_NEWLINE_MARKER,
        matcher: ScenarioMatcher::Exact(MockScenario::StdoutOverLimit { newline: true }),
    },
    ScenarioRule {
        marker: STDOUT_INVALID_UTF8_MARKER,
        matcher: ScenarioMatcher::Exact(MockScenario::StdoutInvalidUtf8),
    },
    ScenarioRule {
        marker: STDOUT_RECORD_BOUNDARIES_MARKER,
        matcher: ScenarioMatcher::Exact(MockScenario::StdoutRecordBoundaries),
    },
    ScenarioRule {
        marker: STUCK_TOOL_CLOSED_STDOUT_DEAF_MARKER,
        matcher: ScenarioMatcher::Prefix(MockScenario::StuckTool {
            deaf: true,
            close_stdout: true,
        }),
    },
    ScenarioRule {
        marker: STUCK_TOOL_DEAF_MARKER,
        matcher: ScenarioMatcher::Prefix(MockScenario::StuckTool {
            deaf: true,
            close_stdout: false,
        }),
    },
    ScenarioRule {
        marker: STUCK_TOOL_MARKER,
        matcher: ScenarioMatcher::Prefix(MockScenario::StuckTool {
            deaf: false,
            close_stdout: false,
        }),
    },
    ScenarioRule {
        marker: ORPHAN_PIPE_MARKER,
        matcher: ScenarioMatcher::Prefix(MockScenario::OrphanPipe),
    },
    ScenarioRule {
        marker: HANG_AFTER_RESULT_DEAF_MARKER,
        matcher: ScenarioMatcher::Prefix(MockScenario::HangAfterResult { deaf: true }),
    },
    ScenarioRule {
        marker: HANG_AFTER_RESULT_THEN_EVENT_MARKER,
        matcher: ScenarioMatcher::Prefix(MockScenario::HangAfterResultThenEvent),
    },
    ScenarioRule {
        marker: HANG_AFTER_RESULT_PERIODIC_EVENTS_MARKER,
        matcher: ScenarioMatcher::Prefix(MockScenario::HangAfterResultPeriodicEvents),
    },
    ScenarioRule {
        marker: HANG_AFTER_ERROR_RESULT_MARKER,
        matcher: ScenarioMatcher::Prefix(MockScenario::HangAfterErrorResult),
    },
    ScenarioRule {
        marker: EXIT_AFTER_RESULT_MARKER,
        matcher: ScenarioMatcher::Prefix(MockScenario::ExitAfterResult),
    },
    ScenarioRule {
        marker: WRITE_ENV_JSON_MARKER,
        matcher: ScenarioMatcher::PrefixPayload(|path| MockScenario::WriteEnvJson(path)),
    },
    ScenarioRule {
        marker: APPEND_PROMPT_TRANSPORT_MARKER,
        matcher: ScenarioMatcher::PrefixPayload(|payload| {
            MockScenario::AppendPromptTransport(payload)
        }),
    },
    ScenarioRule {
        marker: PARALLEL_SHELL_TOOL_OOM_MARKER,
        matcher: ScenarioMatcher::Exact(MockScenario::ParallelShellToolOom),
    },
    ScenarioRule {
        marker: GUEST_WIDE_TOOL_OOM_MARKER,
        matcher: ScenarioMatcher::Exact(MockScenario::GuestWideToolOom),
    },
    ScenarioRule {
        marker: GUEST_WIDE_TOOL_OOM_INJECTED_MARKER,
        matcher: ScenarioMatcher::Exact(MockScenario::GuestWideToolOomInjected),
    },
    ScenarioRule {
        marker: MANAGED_TASK_OOM_MARKER,
        matcher: ScenarioMatcher::Exact(MockScenario::ManagedTaskOom),
    },
    ScenarioRule {
        marker: GUEST_WIDE_TASK_OOM_MARKER,
        matcher: ScenarioMatcher::Exact(MockScenario::GuestWideTaskOom),
    },
    ScenarioRule {
        marker: GUEST_WIDE_TASK_OOM_INJECTED_MARKER,
        matcher: ScenarioMatcher::Exact(MockScenario::GuestWideTaskOomInjected),
    },
    ScenarioRule {
        marker: RUNTIME_ONLY_OOM_MARKER,
        matcher: ScenarioMatcher::Exact(MockScenario::RuntimeOnlyOom),
    },
    ScenarioRule {
        marker: HANG_AFTER_RESULT_MARKER,
        matcher: ScenarioMatcher::Prefix(MockScenario::HangAfterResult { deaf: false }),
    },
];

impl ScenarioRule {
    fn parse<'a>(&self, prompt: &'a str) -> Option<MockScenario<'a>> {
        match &self.matcher {
            ScenarioMatcher::Exact(scenario) => (prompt == self.marker).then_some(*scenario),
            ScenarioMatcher::Prefix(scenario) => {
                prompt.starts_with(self.marker).then_some(*scenario)
            }
            ScenarioMatcher::PrefixPayload(construct) => {
                Some(construct(prompt.strip_prefix(self.marker)?))
            }
            ScenarioMatcher::FirstLinePayload(construct) => {
                Some(construct(first_line_payload(prompt, self.marker)?))
            }
        }
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
mod tests;
