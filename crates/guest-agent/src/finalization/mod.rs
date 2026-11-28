//! Prepare published file outputs and completion payload for atomic acknowledgement.

mod artifact;

use crate::env;
use crate::error::AgentError;
use crate::http::HttpClient;
use crate::run_context::GuestRuntime;
use crate::session_metadata::CapturedSessionMetadata;
use api_contracts::generated::types::runners::storage::ArtifactEntryMissingRootPolicy;
use api_contracts::generated::types::webhooks::agent::complete;
use guest_telemetry::log_info;
use guest_telemetry::telemetry::record_sandbox_op;
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
        }
    }
}

/// Output metadata and local state awaiting atomic completion acknowledgement.
pub struct PreparedFinalization {
    request: complete::RequestCompletion,
    memory_published: bool,
    mode: FinalizationMode,
    total_started_at: Instant,
}

impl PreparedFinalization {
    /// Whether preparation committed a nonempty Memory version distinct from its parent.
    pub fn memory_published(&self) -> bool {
        self.memory_published
    }

    pub(crate) fn request(&self) -> &complete::RequestCompletion {
        &self.request
    }

    pub(crate) fn acknowledge(self, api_elapsed: Duration) {
        record_sandbox_op("completion_api_call", api_elapsed, true, None);
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
        memory_published: prepared.memory_published,
        mode,
        total_started_at,
    })
}

struct PreparedFinalizationParts {
    request: complete::RequestCompletion,
    memory_published: bool,
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

    let storage_outputs =
        artifact::snapshot_artifact_entries(http, inputs.run_id, inputs.artifact_entries).await?;

    let cli_agent_type = inputs.framework.agent_type();
    let cli_agent_session_id = inputs.session_metadata.cli_agent_session_id().to_string();
    let request = complete::RequestCompletion {
        cli_agent_type: cli_agent_type.to_string(),
        cli_agent_session_id,
        cli_agent_session_history_disposition:
            complete::RequestCompletionCliAgentSessionHistoryDisposition::NativeOnly,
        storage_outputs: storage_outputs.outputs,
        volume_versions_snapshot: None,
    };
    Ok(PreparedFinalizationParts {
        request,
        memory_published: storage_outputs.memory_published,
    })
}

#[cfg(test)]
mod tests;
