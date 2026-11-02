//! Prepare native history and published file outputs, then reconcile local history after completion acknowledgement.

mod artifact;
mod session_history;

use crate::env;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::run_context::GuestRuntime;
use crate::session_history_identity::build_final_session_history_identity;
use crate::session_metadata::CapturedSessionMetadata;
use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;
use api_contracts::generated::types::webhooks::agent::complete;
use guest_telemetry::log_info;
use guest_telemetry::telemetry::record_sandbox_op;
use std::borrow::Cow;
use std::time::{Duration, Instant};

const LOG_TAG: &str = "sandbox:guest-agent";

#[derive(Clone, Copy, PartialEq, Eq)]
enum FinalizationMode {
    Success,
    Recovery,
}

impl FinalizationMode {
    fn total_op(self) -> &'static str {
        match self {
            Self::Success => "finalization_total",
            Self::Recovery => "recovery_finalization_total",
        }
    }

    fn log_label(self) -> &'static str {
        match self {
            Self::Success => "completion",
            Self::Recovery => "recovery finalization",
        }
    }
}

struct FinalizationInputs<'a> {
    run_id: &'a str,
    framework: env::Framework,
    artifact_entries: &'a [env::ArtifactEnv],
    session_metadata: &'a CapturedSessionMetadata,
    final_session_history_identity_file: Cow<'a, str>,
}

impl<'a> FinalizationInputs<'a> {
    fn from_runtime(
        runtime: &'a GuestRuntime,
        session_metadata: &'a CapturedSessionMetadata,
    ) -> Self {
        Self {
            run_id: &runtime.config.run_id,
            framework: runtime.config.framework,
            artifact_entries: &runtime.config.artifacts,
            session_metadata,
            final_session_history_identity_file: Cow::Borrowed(
                runtime.paths.final_session_history_identity_file(),
            ),
        }
    }
}

/// Native history and output metadata and local state awaiting atomic completion acknowledgement.
pub struct PreparedFinalization {
    request: complete::RequestCompletion,
    mode: FinalizationMode,
    retained_history: Option<session_history::RetainedSessionHistory>,
    framework: env::Framework,
    final_session_history_identity_file: String,
    total_started_at: Instant,
}

impl PreparedFinalization {
    pub(crate) fn request(&self) -> &complete::RequestCompletion {
        &self.request
    }

    pub(crate) fn acknowledge(self, api_elapsed: Duration) {
        record_sandbox_op("completion_api_call", api_elapsed, true, None);
        if let Some(history) = self.retained_history {
            session_history::write_final_session_history_identity(
                build_final_session_history_identity(
                    self.framework,
                    &history.cli_agent_session_id,
                    &history.history_hash,
                    history.history_size,
                    &history.history_source,
                ),
                &self.final_session_history_identity_file,
            );
        }
        log_info!(LOG_TAG, "{} persisted successfully", self.mode.log_label());
        record_sandbox_op(
            self.mode.total_op(),
            self.total_started_at.elapsed(),
            true,
            None,
        );
    }

    pub(crate) fn record_persistence_failure(self, api_elapsed: Duration) {
        record_sandbox_op("completion_api_call", api_elapsed, false, None);
        record_sandbox_op(
            self.mode.total_op(),
            self.total_started_at.elapsed(),
            false,
            None,
        );
    }
}

/// Prepare finalization after a successful run using the explicit runtime snapshot.
pub async fn prepare_finalization_for_runtime(
    runtime: &GuestRuntime,
    session_metadata: &CapturedSessionMetadata,
) -> Result<PreparedFinalization, AgentError> {
    let inputs = FinalizationInputs::from_runtime(runtime, session_metadata);
    prepare_finalization_with_inputs(&runtime.http, &inputs).await
}

/// Prepare best-effort recovery finalization using the explicit runtime snapshot.
pub async fn prepare_recovery_finalization_for_runtime(
    runtime: &GuestRuntime,
    session_metadata: &CapturedSessionMetadata,
) -> Result<PreparedFinalization, AgentError> {
    let inputs = FinalizationInputs::from_runtime(runtime, session_metadata);
    prepare_recovery_finalization_with_inputs(&runtime.http, &inputs).await
}

async fn prepare_finalization_with_inputs(
    http: &HttpClient,
    inputs: &FinalizationInputs<'_>,
) -> Result<PreparedFinalization, AgentError> {
    prepare_finalization_for_mode(http, FinalizationMode::Success, inputs).await
}

async fn prepare_recovery_finalization_with_inputs(
    http: &HttpClient,
    inputs: &FinalizationInputs<'_>,
) -> Result<PreparedFinalization, AgentError> {
    prepare_finalization_for_mode(http, FinalizationMode::Recovery, inputs).await
}

async fn prepare_finalization_for_mode(
    http: &HttpClient,
    mode: FinalizationMode,
    inputs: &FinalizationInputs<'_>,
) -> Result<PreparedFinalization, AgentError> {
    let total_started_at = Instant::now();
    let result = prepare_finalization_impl(http, mode, inputs).await;
    if result.is_err() {
        record_sandbox_op(mode.total_op(), total_started_at.elapsed(), false, None);
    }
    result.map(|prepared| PreparedFinalization {
        request: prepared.request,
        mode,
        retained_history: prepared.retained_history,
        framework: inputs.framework,
        final_session_history_identity_file: inputs.final_session_history_identity_file.to_string(),
        total_started_at,
    })
}

struct PreparedFinalizationParts {
    request: complete::RequestCompletion,
    retained_history: Option<session_history::RetainedSessionHistory>,
}

fn completion_missing_root_policy(
    policy: ArtifactEntryMissingRootPolicy,
) -> complete::RequestCompletionStorageOutputMissingRootPolicy {
    match policy {
        ArtifactEntryMissingRootPolicy::Fail => {
            complete::RequestCompletionStorageOutputMissingRootPolicy::Fail
        }
        ArtifactEntryMissingRootPolicy::PreserveParentVersion => {
            complete::RequestCompletionStorageOutputMissingRootPolicy::PreserveParentVersion
        }
    }
}

async fn prepare_finalization_impl(
    http: &HttpClient,
    mode: FinalizationMode,
    inputs: &FinalizationInputs<'_>,
) -> Result<PreparedFinalizationParts, AgentError> {
    log_info!(LOG_TAG, "Preparing {}...", mode.log_label());

    // Local history evidence and artifact snapshots are independent prerequisites
    // of the final combined completion, so run them concurrently. The history
    // path performs bounded blocking local preparation; the
    // artifact path performs blocking file preparation before VAS work. Wait
    // for both results even after one fails so a started blocking operation is
    // not detached from the finalization future.
    let (storage_outputs, finalization_history) = tokio::join!(
        artifact::snapshot_artifact_entries(http, inputs.run_id, inputs.artifact_entries,),
        session_history::prepare_retained_session_history(inputs.session_metadata),
    );
    let finalization_history = finalization_history?;
    let storage_outputs = storage_outputs?;

    let cli_agent_type = inputs.framework.agent_type();
    let cli_agent_session_id = inputs.session_metadata.cli_agent_session_id().to_string();
    let retained_history = finalization_history;
    let request = complete::RequestCompletion {
        cli_agent_type: cli_agent_type.to_string(),
        cli_agent_session_id,
        cli_agent_session_history_disposition:
            complete::RequestCompletionCliAgentSessionHistoryDisposition::NativeOnly,
        storage_outputs,
        volume_versions_snapshot: None,
    };
    Ok(PreparedFinalizationParts {
        request,
        retained_history,
    })
}

#[cfg(test)]
mod tests;
