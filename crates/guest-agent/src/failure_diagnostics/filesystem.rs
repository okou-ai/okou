//! Resolve selected terminal ENOSPC failures without writing a diagnostic file.

use super::base_failure_diagnostic_for_config;
use crate::env::GuestConfig;
use crate::filesystem::{self, FilesystemObservation};
use guest_contracts::diagnostics::{
    CliTerminationReason, FailureClass, FailureDiagnostic, FailureReason,
};

// Match Runner's available-byte diagnostic threshold. Cache admission reserves
// are deliberately larger and do not prove that a failed write exhausted space.
const FULL_AVAILABLE_BYTES: u64 = 1024 * 1024;

/// Refine an unclassified terminal ENOSPC from fresh rootfs/home observations.
///
/// The selected execution failure is the only text input: tool output and Agent
/// prose do not enter this boundary. The reason remains in memory even when the
/// filesystem cannot persist either diagnostic file before `/complete`.
pub fn refine_disk_full_failure_for_config(
    config: &GuestConfig,
    exit_code: i32,
    selected_failure_message: Option<&str>,
    diagnostic: &mut Option<FailureDiagnostic>,
) {
    let Some(reason) = resolve_disk_full_failure_reason(
        exit_code,
        selected_failure_message,
        diagnostic.as_ref(),
        filesystem::observe,
    ) else {
        return;
    };

    diagnostic
        .get_or_insert_with(|| base_failure_diagnostic_for_config(config, FailureClass::CliNonzero))
        .failure_reason = Some(reason);
}

fn resolve_disk_full_failure_reason(
    exit_code: i32,
    selected_failure_message: Option<&str>,
    diagnostic: Option<&FailureDiagnostic>,
    observe: impl FnOnce() -> (Option<FilesystemObservation>, Option<FilesystemObservation>),
) -> Option<FailureReason> {
    if exit_code == 0
        || diagnostic.is_some_and(|diagnostic| {
            diagnostic.failure_reason.is_some()
                || diagnostic
                    .cli_termination
                    .as_ref()
                    .is_some_and(|termination| {
                        matches!(
                            termination.reason,
                            CliTerminationReason::UserCancellation
                                | CliTerminationReason::ExecutionTimeout
                        )
                    })
        })
        || !selected_failure_message.is_some_and(explicit_enospc)
    {
        return None;
    }

    let (rootfs, home) = observe();
    if rootfs.is_some_and(exhausted) {
        Some(FailureReason::GuestRootFilesystemFull)
    } else if home.is_some_and(exhausted) {
        Some(FailureReason::GuestHomeFilesystemFull)
    } else {
        None
    }
}

fn explicit_enospc(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("no space left on device")
        || message.contains("os error 28")
        || message
            .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
            .any(|word| word == "enospc")
}

fn exhausted(observation: FilesystemObservation) -> bool {
    observation.available_bytes <= FULL_AVAILABLE_BYTES || observation.available_inodes == 0
}

#[cfg(test)]
mod tests;
