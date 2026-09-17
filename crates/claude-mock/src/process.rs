mod fixtures;
mod shell_execution;
mod stream_json_input;

use crate::args::ParsedArgs;
use crate::scenario::MockScenario;
use guest_contracts::guest_binary::TOOL_EXEC_PATH;
use guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV;
use std::ffi::OsStr;
use std::io::BufReader;
use std::process::{Command, ExitCode};

fn bash_tool_command() -> Command {
    let canonical = std::env::var_os(CANONICAL_TOOL_CGROUP_PROCS_ENV);
    let binary = bash_tool_binary(canonical.as_deref());
    Command::new(binary)
}

fn bash_tool_binary(canonical: Option<&OsStr>) -> &'static str {
    if canonical.is_some() {
        TOOL_EXEC_PATH
    } else {
        "bash"
    }
}

pub(crate) fn run(parsed: ParsedArgs) -> ExitCode {
    if parsed.input_format == "stream-json" {
        return run_stream_json_input(parsed);
    }

    run_prompt_scenario(&parsed.prompt, &parsed.output_format)
}

fn run_stream_json_input(parsed: ParsedArgs) -> ExitCode {
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let first_frame = match stream_json_input::read_initial_user_frame(&mut reader) {
        Ok(Some(frame)) => frame,
        Ok(None) => {
            eprintln!("stream-json stdin did not contain a user message");
            return ExitCode::from(1);
        }
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(1);
        }
    };

    match MockScenario::from_prompt(first_frame.content()) {
        MockScenario::ActiveInputSmoke {
            expected_follow_ups,
        } => stream_json_input::run_active_input_smoke_scenario(
            &parsed.output_format,
            parsed.replay_user_messages,
            first_frame,
            &mut reader,
            expected_follow_ups,
            false,
        ),
        MockScenario::ActiveInputSmokeReady {
            expected_follow_ups,
        } => stream_json_input::run_active_input_smoke_scenario(
            &parsed.output_format,
            parsed.replay_user_messages,
            first_frame,
            &mut reader,
            expected_follow_ups,
            true,
        ),
        MockScenario::InvalidActiveInputSmokeCount(count) => {
            eprintln!(
                "{}",
                stream_json_input::invalid_count_message("@active-input-smoke", count)
            );
            ExitCode::from(1)
        }
        MockScenario::InvalidActiveInputSmokeReadyCount(count) => {
            let message =
                stream_json_input::invalid_count_message("@active-input-smoke-ready", count);
            eprintln!("{message}");
            ExitCode::from(1)
        }
        scenario => run_scenario(scenario, first_frame.content(), &parsed.output_format),
    }
}

fn run_prompt_scenario(prompt: &str, output_format: &str) -> ExitCode {
    run_scenario(MockScenario::from_prompt(prompt), prompt, output_format)
}

fn run_scenario(scenario: MockScenario<'_>, prompt: &str, output_format: &str) -> ExitCode {
    match scenario {
        MockScenario::ActiveInputSmoke { .. } | MockScenario::ActiveInputSmokeReady { .. } => {
            eprintln!("@active-input-smoke requires --input-format stream-json");
            ExitCode::from(1)
        }
        MockScenario::InvalidActiveInputSmokeCount(count) => {
            eprintln!(
                "{}",
                stream_json_input::invalid_count_message("@active-input-smoke", count)
            );
            ExitCode::from(1)
        }
        MockScenario::InvalidActiveInputSmokeReadyCount(count) => {
            let message =
                stream_json_input::invalid_count_message("@active-input-smoke-ready", count);
            eprintln!("{message}");
            ExitCode::from(1)
        }
        MockScenario::EchoJsonl(payload) => fixtures::run_echo_jsonl_mode(payload, false),
        MockScenario::EchoJsonlAndHang(payload) => fixtures::run_echo_jsonl_mode(payload, true),
        MockScenario::FailNoNewline(msg) => fixtures::run_fail_no_newline(msg),
        MockScenario::FailInvalidUtf8 => fixtures::run_fail_invalid_utf8(),
        MockScenario::FailInvalidUtf8Long => fixtures::run_fail_invalid_utf8_long(),
        MockScenario::Fail(msg) => fixtures::run_fail(msg),
        MockScenario::StdoutOverLimit { newline } => {
            fixtures::run_stdout_over_limit_scenario(output_format, newline)
        }
        MockScenario::StdoutInvalidUtf8 => {
            fixtures::run_stdout_invalid_utf8_scenario(output_format)
        }
        MockScenario::StdoutRecordBoundaries => {
            fixtures::run_stdout_record_boundaries_scenario(output_format)
        }
        MockScenario::StuckTool { deaf, close_stdout } => {
            fixtures::run_stuck_tool_scenario(output_format, deaf, close_stdout)
        }
        MockScenario::OrphanPipe => fixtures::run_orphan_pipe_scenario(output_format),
        MockScenario::HangAfterResult { deaf } => {
            fixtures::run_hang_after_result_scenario(output_format, deaf)
        }
        MockScenario::HangAfterResultThenEvent => {
            fixtures::run_hang_after_result_then_event_scenario(output_format)
        }
        MockScenario::HangAfterResultPeriodicEvents => {
            fixtures::run_hang_after_result_periodic_events_scenario(output_format)
        }
        MockScenario::HangAfterErrorResult => {
            fixtures::run_hang_after_error_result_scenario(output_format)
        }
        MockScenario::ExitAfterResult => fixtures::run_exit_after_result_scenario(output_format),
        MockScenario::WriteEnvJson(path) => {
            fixtures::run_write_env_json_scenario(output_format, path)
        }
        MockScenario::AppendPromptTransport(payload) => {
            fixtures::run_append_prompt_transport_scenario(output_format, payload)
        }
        MockScenario::ParallelShellToolOom => {
            fixtures::run_parallel_shell_tool_oom_scenario(output_format, false)
        }
        MockScenario::GuestWideToolOom => {
            fixtures::run_parallel_shell_tool_oom_scenario(output_format, true)
        }
        MockScenario::RuntimeOnlyOom => fixtures::run_runtime_only_oom_scenario(output_format),
        MockScenario::Shell => shell_execution::run(prompt, output_format),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_tool_endpoint_presence_selects_the_managed_launcher() {
        let endpoint = OsStr::new("endpoint");
        let empty = OsStr::new("");

        assert_eq!(bash_tool_binary(None), "bash");
        assert_eq!(bash_tool_binary(Some(endpoint)), TOOL_EXEC_PATH);
        assert_eq!(bash_tool_binary(Some(empty)), TOOL_EXEC_PATH);
    }
}
