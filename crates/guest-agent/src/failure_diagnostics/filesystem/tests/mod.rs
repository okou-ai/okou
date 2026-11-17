use super::*;
use guest_contracts::diagnostics::{AgentFramework, CliTerminationDiagnostic, PromptMetadata};

fn observation(available_bytes: u64, available_inodes: u64) -> FilesystemObservation {
    FilesystemObservation {
        used_bytes: 24 * 1024 * 1024 - available_bytes,
        total_bytes: 24 * 1024 * 1024,
        available_bytes,
        used_inodes: 1024 - available_inodes,
        total_inodes: 1024,
        available_inodes,
    }
}

fn diagnostic() -> FailureDiagnostic {
    FailureDiagnostic::new(
        FailureClass::CliNonzero,
        AgentFramework::Pi,
        PromptMetadata::from_prompt("continue"),
    )
}

#[test]
fn selected_terminal_enospc_uses_precise_independent_filesystem_evidence() {
    let healthy = observation(FULL_AVAILABLE_BYTES + 1, 100);
    let full_bytes = observation(0, 100);
    let low_bytes = observation(FULL_AVAILABLE_BYTES, 100);
    let full_inodes = observation(8 * 1024 * 1024, 0);

    for message in [
        "ENOSPC: no space left on device, write",
        "No space left on device (os error 28)",
        "write failed: ENOSPC",
    ] {
        for (rootfs, home, expected) in [
            (
                Some(healthy),
                Some(full_bytes),
                Some(FailureReason::GuestHomeFilesystemFull),
            ),
            (
                Some(healthy),
                Some(low_bytes),
                Some(FailureReason::GuestHomeFilesystemFull),
            ),
            (
                Some(healthy),
                Some(full_inodes),
                Some(FailureReason::GuestHomeFilesystemFull),
            ),
            (
                Some(full_bytes),
                Some(healthy),
                Some(FailureReason::GuestRootFilesystemFull),
            ),
            (
                Some(full_inodes),
                Some(healthy),
                Some(FailureReason::GuestRootFilesystemFull),
            ),
            (
                Some(full_bytes),
                Some(full_inodes),
                Some(FailureReason::GuestRootFilesystemFull),
            ),
            (
                None,
                Some(full_bytes),
                Some(FailureReason::GuestHomeFilesystemFull),
            ),
            (Some(healthy), Some(healthy), None),
            (Some(healthy), None, None),
            (None, None, None),
        ] {
            assert_eq!(
                resolve_disk_full_failure_reason(1, Some(message), None, || (rootfs, home)),
                expected,
                "message={message}, rootfs={rootfs:?}, home={home:?}"
            );
        }
    }
}

#[test]
fn only_an_unclassified_selected_terminal_enospc_failure_needs_a_probe() {
    let base = diagnostic();
    let known_provider = diagnostic().with_failure_reason(FailureReason::ProviderRateLimited);
    let timeout = diagnostic().with_failure_reason(FailureReason::ExecutionTimeout);
    let cancellation = diagnostic().with_cli_termination(CliTerminationDiagnostic::new(
        CliTerminationReason::UserCancellation,
    ));
    let timeout_without_reason = diagnostic().with_cli_termination(CliTerminationDiagnostic::new(
        CliTerminationReason::ExecutionTimeout,
    ));

    for (exit_code, message, diagnostic) in [
        (0, Some("tool failed with ENOSPC; recovered"), Some(&base)),
        (1, None, Some(&base)),
        (1, Some("provider stream interrupted"), Some(&base)),
        (1, Some("ENOSPC"), Some(&known_provider)),
        (124, Some("ENOSPC"), Some(&timeout)),
        (1, Some("ENOSPC"), Some(&cancellation)),
        (124, Some("ENOSPC"), Some(&timeout_without_reason)),
    ] {
        assert_eq!(
            resolve_disk_full_failure_reason(exit_code, message, diagnostic, || {
                panic!("this terminal outcome must not trigger a disk probe")
            }),
            None,
            "exit_code={exit_code}, message={message:?}, diagnostic={diagnostic:?}"
        );
    }
}
