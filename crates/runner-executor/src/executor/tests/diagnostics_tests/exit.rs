use guest_contracts::diagnostics::{
    AgentFramework, CliObservedExitDiagnostic, CliObservedExitKind, CliTerminationDiagnostic,
    CliTerminationReason, CliTerminationSignal, FailureClass, FailureDetailSource,
    FailureDiagnostic, PromptMetadata,
};
use sandbox::{ExecTermination, ProcessExit};

use super::super::super::diagnostics::{
    should_collect_agent_abnormal_exit_diagnostics,
    should_collect_unattributed_sigkill_resource_diagnostics,
    should_log_agent_bootstrap_abnormal_exit_diagnostics,
};

#[test]
fn bootstrap_abnormal_exit_diagnostics_allow_captured_stderr_without_resource_probe() {
    let exit = ProcessExit::new(1, 126, Vec::new(), b"permission denied".to_vec());
    let stderr = "permission denied";

    assert!(should_log_agent_bootstrap_abnormal_exit_diagnostics(
        false, &exit, None, None
    ));
    assert!(!should_collect_agent_abnormal_exit_diagnostics(
        false, &exit, stderr, None, None
    ));

    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("/help"),
    );
    assert!(!should_log_agent_bootstrap_abnormal_exit_diagnostics(
        false,
        &exit,
        Some(&diagnostic),
        None
    ));
    assert!(!should_log_agent_bootstrap_abnormal_exit_diagnostics(
        false,
        &exit,
        None,
        Some("guest error")
    ));

    let successful_exit = ProcessExit::new(1, 0, Vec::new(), Vec::new());
    assert!(!should_log_agent_bootstrap_abnormal_exit_diagnostics(
        false,
        &successful_exit,
        None,
        None
    ));
    let timed_out_exit = ProcessExit {
        termination: ExecTermination::TimedOut,
        ..ProcessExit::new(1, 0, Vec::new(), Vec::new())
    };
    assert!(!should_log_agent_bootstrap_abnormal_exit_diagnostics(
        false,
        &timed_out_exit,
        None,
        None
    ));
}

#[test]
fn explicit_enospc_collects_resources_even_with_structured_failure() {
    let exit = ProcessExit::new(1, 1, Vec::new(), Vec::new());
    let diagnostic = fallback_cli_nonzero_diagnostic(1);

    assert!(should_collect_agent_abnormal_exit_diagnostics(
        false,
        &exit,
        "",
        Some(&diagnostic),
        Some("thread store initialization failed: No space left on device (os error 28)"),
    ));
}

#[test]
fn unrelated_structured_failure_does_not_collect_resources() {
    let exit = ProcessExit::new(1, 1, Vec::new(), Vec::new());
    let diagnostic = fallback_cli_nonzero_diagnostic(1);

    assert!(!should_collect_agent_abnormal_exit_diagnostics(
        false,
        &exit,
        "",
        Some(&diagnostic),
        Some("authentication failed"),
    ));
}

fn fallback_cli_nonzero_diagnostic(exit_code: i32) -> FailureDiagnostic {
    FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("/help"),
    )
    .with_cli_exit_code(exit_code)
    .with_failure_detail_source(FailureDetailSource::FallbackExitCode)
}

#[test]
fn unattributed_sigkill_resource_diagnostics_match_observed_sigkill() {
    let exit = ProcessExit::new(1, 137, Vec::new(), Vec::new());
    let diagnostic = fallback_cli_nonzero_diagnostic(137)
        .with_cli_observed_exit(CliObservedExitDiagnostic::from_signal(libc::SIGKILL));

    assert!(should_collect_unattributed_sigkill_resource_diagnostics(
        false,
        &exit,
        Some(&diagnostic)
    ));
}

#[test]
fn unattributed_sigkill_resource_diagnostics_do_not_match_explicit_exit_137() {
    let exit = ProcessExit::new(1, 137, Vec::new(), Vec::new());
    let diagnostic = fallback_cli_nonzero_diagnostic(137)
        .with_cli_observed_exit(CliObservedExitDiagnostic::from_exit_code(137));

    assert!(!should_collect_unattributed_sigkill_resource_diagnostics(
        false,
        &exit,
        Some(&diagnostic)
    ));
}

#[test]
fn unattributed_sigkill_resource_diagnostics_require_observed_sigkill() {
    let exit = ProcessExit::new(1, 137, Vec::new(), Vec::new());
    let diagnostic = fallback_cli_nonzero_diagnostic(137);

    assert!(!should_collect_unattributed_sigkill_resource_diagnostics(
        false,
        &exit,
        Some(&diagnostic)
    ));
}

#[test]
fn unattributed_sigkill_resource_diagnostics_require_fallback_detail_source() {
    let exit = ProcessExit::new(1, 137, Vec::new(), Vec::new());
    let diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("/help"),
    )
    .with_cli_exit_code(137)
    .with_cli_observed_exit(CliObservedExitDiagnostic::from_signal(libc::SIGKILL));

    assert!(!should_collect_unattributed_sigkill_resource_diagnostics(
        false,
        &exit,
        Some(&diagnostic)
    ));
}

#[test]
fn unattributed_sigkill_resource_diagnostics_require_matching_exit_code() {
    let exit = ProcessExit::new(1, 1, Vec::new(), Vec::new());
    let diagnostic = fallback_cli_nonzero_diagnostic(137)
        .with_cli_observed_exit(CliObservedExitDiagnostic::from_signal(libc::SIGKILL));

    assert!(!should_collect_unattributed_sigkill_resource_diagnostics(
        false,
        &exit,
        Some(&diagnostic)
    ));
}

#[test]
fn unattributed_sigkill_resource_diagnostics_require_standard_sigkill_mapping() {
    let exit = ProcessExit::new(1, 99, Vec::new(), Vec::new());
    let mut observed_exit = CliObservedExitDiagnostic::from_signal(libc::SIGKILL);
    observed_exit.mapped_exit_code = 99;
    let diagnostic = fallback_cli_nonzero_diagnostic(99).with_cli_observed_exit(observed_exit);

    assert!(!should_collect_unattributed_sigkill_resource_diagnostics(
        false,
        &exit,
        Some(&diagnostic)
    ));
}

#[test]
fn unattributed_sigkill_resource_diagnostics_require_signal_exit_shape() {
    let exit = ProcessExit::new(1, 137, Vec::new(), Vec::new());
    let diagnostic =
        fallback_cli_nonzero_diagnostic(137).with_cli_observed_exit(CliObservedExitDiagnostic {
            kind: CliObservedExitKind::Signal,
            exit_code: Some(137),
            signal_number: Some(libc::SIGKILL),
            signal_name: Some("sigkill".to_string()),
            mapped_exit_code: 137,
        });

    assert!(!should_collect_unattributed_sigkill_resource_diagnostics(
        false,
        &exit,
        Some(&diagnostic)
    ));
}

#[test]
fn unattributed_sigkill_resource_diagnostics_require_unattributed_fallback_failure() {
    let exit = ProcessExit::new(1, 137, Vec::new(), Vec::new());
    let exit_with_process_diagnostic = ProcessExit {
        diagnostic: "wait failed inside provider".to_string(),
        ..ProcessExit::new(1, 137, Vec::new(), Vec::new())
    };
    let observed_sigkill_diagnostic = fallback_cli_nonzero_diagnostic(137)
        .with_cli_observed_exit(CliObservedExitDiagnostic::from_signal(libc::SIGKILL));
    let termination = CliTerminationDiagnostic::new(CliTerminationReason::StuckToolWatchdog)
        .record_signal(CliTerminationSignal::Sigkill, Some(42), Some(1_000))
        .with_observed_exit_code(137);
    let attributed_diagnostic = observed_sigkill_diagnostic
        .clone()
        .with_cli_termination(termination);
    let specific_diagnostic = FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("/help"),
    )
    .with_cli_exit_code(137)
    .with_cli_observed_exit(CliObservedExitDiagnostic::from_signal(libc::SIGKILL))
    .with_failure_detail_source(FailureDetailSource::ClaudeResult);
    let non_cli_diagnostic = FailureDiagnostic::new(
        FailureClass::CheckpointFailed,
        AgentFramework::ClaudeCode,
        PromptMetadata::from_prompt("/help"),
    )
    .with_cli_exit_code(137)
    .with_cli_observed_exit(CliObservedExitDiagnostic::from_signal(libc::SIGKILL))
    .with_failure_detail_source(FailureDetailSource::FallbackExitCode);
    let timed_out_exit = ProcessExit {
        termination: ExecTermination::TimedOut,
        ..ProcessExit::new(1, 137, Vec::new(), Vec::new())
    };

    assert!(!should_collect_unattributed_sigkill_resource_diagnostics(
        false,
        &exit,
        Some(&attributed_diagnostic)
    ));
    assert!(!should_collect_unattributed_sigkill_resource_diagnostics(
        false,
        &exit,
        Some(&specific_diagnostic)
    ));
    assert!(!should_collect_unattributed_sigkill_resource_diagnostics(
        false,
        &exit,
        Some(&non_cli_diagnostic)
    ));
    assert!(!should_collect_unattributed_sigkill_resource_diagnostics(
        false,
        &exit_with_process_diagnostic,
        Some(&observed_sigkill_diagnostic)
    ));
    assert!(!should_collect_unattributed_sigkill_resource_diagnostics(
        false,
        &timed_out_exit,
        Some(&observed_sigkill_diagnostic)
    ));
    assert!(!should_collect_unattributed_sigkill_resource_diagnostics(
        true,
        &exit,
        Some(&observed_sigkill_diagnostic)
    ));
}
