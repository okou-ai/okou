//! Job provider trait and implementations.
//!
//! JobProvider owns shared reporting/control; LocalJobSource owns independent
//! filesystem acquisition. Complete HTTP publications enter the same executor.

mod api;
mod api_ably_supervisor;
mod api_cancellation_reconciliation;
mod builtin_firewall_catalog;
mod connector_runtime_sync;
mod local;
mod worker_join;

pub use api::ApiClient;
pub use api::decode_execution_publication;
pub use api::{ApiProvider, ApiProviderConfig, BuiltinFirewallCatalogCachePaths};
pub use connector_runtime_sync::{ConnectorRuntimeSyncHandle, ConnectorRuntimeSyncRegistration};
pub use local::LocalProvider;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::active_input::ActiveInputSource;
use crate::error::ProviderResult;
use runner_types::ids::RunId;
use runner_types::types::{CompleteRequest, ExecutionContext, HeartbeatState};

/// Consumer-owned handler for non-provider messages received on the shared
/// Runner Ably subscription.
pub trait AblySideMessageHandler: Send + Sync {
    /// Return `true` when the message was recognized and consumed.
    fn handle(&self, message: &ably_subscriber::Message) -> bool;
}

/// When terminal reporting may release a caller relative to finalization.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompletionReportTiming {
    ConcurrentWithFinalization,
    AfterFinalization,
}

/// Independent local submission, carrying no remote acquisition protocol.
#[derive(Clone, Debug)]
pub struct JobCandidate {
    run_id: RunId,
    profile_name: String,
    local_job_path: Option<PathBuf>,
    reuse_key: Option<String>,
}

impl JobCandidate {
    pub fn new(run_id: RunId, profile_name: String) -> Self {
        Self {
            run_id,
            profile_name,
            local_job_path: None,
            reuse_key: None,
        }
    }
    pub fn local(run_id: RunId, profile_name: String, job_path: PathBuf) -> Self {
        Self {
            local_job_path: Some(job_path),
            ..Self::new(run_id, profile_name)
        }
    }
    pub fn run_id(&self) -> RunId {
        self.run_id
    }
    pub fn profile_name(&self) -> &str {
        &self.profile_name
    }
    pub fn local_job_path(&self) -> Option<&Path> {
        self.local_job_path.as_deref()
    }
    pub fn reuse_key(&self) -> Option<&str> {
        self.reuse_key.as_deref()
    }
    pub fn with_reuse_key(mut self, reuse_key: Option<String>) -> Self {
        self.reuse_key = reuse_key.filter(|key| !key.is_empty());
        self
    }
}

/// Execution input and Run-scoped reporting authority transferred to the executor.
pub struct ClaimedJob {
    context: ExecutionContext,
    completion_auth: CompletionAuth,
    active_input_source: Option<ActiveInputSource>,
    supplied: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ClaimedJobRunIdMismatch {
    pub expected_run_id: RunId,
    pub context_run_id: RunId,
}

impl ClaimedJob {
    /// Full context supplied by the control plane, with normal Run auth but no Claim observation.
    pub fn supplied(
        context: ExecutionContext,
        active_input_source: Option<ActiveInputSource>,
    ) -> Self {
        let completion_auth =
            CompletionAuth::sandbox_token(context.run_id, context.sandbox_token.clone());
        Self {
            context,
            completion_auth,
            active_input_source,
            supplied: true,
        }
    }

    fn validate_run_id(
        expected_run_id: RunId,
        context: &ExecutionContext,
    ) -> Result<(), ClaimedJobRunIdMismatch> {
        if context.run_id == expected_run_id {
            Ok(())
        } else {
            Err(ClaimedJobRunIdMismatch {
                expected_run_id,
                context_run_id: context.run_id,
            })
        }
    }

    #[cfg(test)]
    pub fn local(
        expected_run_id: RunId,
        context: ExecutionContext,
    ) -> Result<Self, ClaimedJobRunIdMismatch> {
        Self::local_with_active_input_source(expected_run_id, context, None)
    }

    pub fn local_with_active_input_source(
        expected_run_id: RunId,
        context: ExecutionContext,
        active_input_source: Option<ActiveInputSource>,
    ) -> Result<Self, ClaimedJobRunIdMismatch> {
        Self::validate_run_id(expected_run_id, &context)?;
        Ok(Self {
            context,
            completion_auth: CompletionAuth::local(),
            active_input_source,
            supplied: false,
        })
    }

    pub fn into_parts(self) -> (ExecutionContext, CompletionAuth, Option<ActiveInputSource>) {
        (self.context, self.completion_auth, self.active_input_source)
    }

    pub fn context(&self) -> &ExecutionContext {
        &self.context
    }

    /// Complete input was delivered directly, rather than acquired through discovery.
    pub fn is_supplied(&self) -> bool {
        self.supplied
    }

    #[cfg(test)]
    pub fn active_input_source(&self) -> Option<&ActiveInputSource> {
        self.active_input_source.as_ref()
    }
}

/// Auth material needed by a provider to report terminal completion.
pub struct CompletionAuth {
    kind: CompletionAuthKind,
}

enum CompletionAuthKind {
    Sandbox { run_id: RunId, token: String },
    Local,
}

#[derive(Debug)]
pub enum CompletionAuthError {
    NotSandbox,
    RunIdMismatch { auth_run_id: RunId },
}

impl CompletionAuth {
    pub fn sandbox_token(run_id: RunId, token: String) -> Self {
        Self {
            kind: CompletionAuthKind::Sandbox { run_id, token },
        }
    }

    pub fn local() -> Self {
        Self {
            kind: CompletionAuthKind::Local,
        }
    }

    pub fn into_sandbox_token(self, expected_run_id: RunId) -> Result<String, CompletionAuthError> {
        match self.kind {
            CompletionAuthKind::Sandbox { run_id, token } if run_id == expected_run_id => Ok(token),
            CompletionAuthKind::Sandbox { run_id, .. } => Err(CompletionAuthError::RunIdMismatch {
                auth_run_id: run_id,
            }),
            CompletionAuthKind::Local => Err(CompletionAuthError::NotSandbox),
        }
    }
}

/// Filesystem job discovery and atomic local ownership acquisition.
/// Remote work never implements this capability or fetches execution input here.
#[async_trait::async_trait]
pub trait LocalJobSource: Send + Sync {
    /// Side-effect-free wait; Reactor retains this future across maintenance ticks.
    async fn discover(&self) -> Option<JobCandidate>;
    /// Atomic local claim. Accepted admission tasks retain this future until
    /// ownership transfers to execution or explicit completion/rollback.
    async fn claim(&self, candidate: JobCandidate) -> Option<ClaimedJob>;
}

/// Shared readiness, execution reporting and control lifecycle.
#[async_trait::async_trait]
pub trait JobProvider: Send + Sync {
    /// Only independent local providers expose filesystem acquisition.
    fn local_source(self: Arc<Self>) -> Option<Arc<dyn LocalJobSource>> {
        None
    }
    async fn prepare_startup_readiness(&self) -> ProviderResult<()> {
        Ok(())
    }
    /// Attach controls/reporting to full input already owned by the receiver.
    async fn bind_supplied(&self, _context: ExecutionContext) -> ProviderResult<ClaimedJob> {
        Err(crate::ProviderError::Config(
            "provider does not support direct dispatch".into(),
        ))
    }
    fn completion_report_timing(&self) -> CompletionReportTiming {
        CompletionReportTiming::AfterFinalization
    }
    async fn complete(&self, request: CompleteRequest, completion_auth: CompletionAuth);
    /// Lifecycle callers retain heartbeat delivery through startup/drain ordering.
    async fn heartbeat(&self, state: &HeartbeatState) -> ProviderResult<()>;
    /// Stop owned control workers after the local discovery future is dropped.
    /// Final heartbeat and concurrent executor completion remain valid afterwards.
    async fn shutdown(&self);
}

#[cfg(test)]
mod tests;
