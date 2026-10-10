//! High-level Runner runtime orchestration above the existing domain owners.
//!
//! The executable registers signals early, validates configuration, holds image
//! and base-directory locks, and supplies concrete factory plans and resources.
//! This crate owns the retained reactor, ordered factory startup/teardown, job
//! dispatch, independent maintenance, lifecycle signal consumption, and adjacent
//! idle/admission/finalization/heartbeat/orphan policies.

use std::sync::Arc;

use sandbox::SandboxFactory;

// Private domain-module imports used by the orchestration implementation. These
// resolve to the original single owners; they introduce no wrapper code or
// dependency on the executable.
#[cfg(test)]
use runner_executor::pre_spawn_admission;
#[cfg(test)]
use runner_executor::test_fixtures;
use runner_executor::{executor, telemetry};
use runner_host::idle_prune_control;
use runner_lifecycle::{
    guest_timezone, idle_pool, lifecycle, prefetch, resource_budget, status, workspace_image_cache,
};
#[cfg(test)]
use runner_lifecycle::{idle_reuse_preparation, restored_session_identity, workspace_promotion};
#[cfg(test)]
use runner_network::network_log_manager;
use runner_network::{dns, kmsg_log, network_log_drain, network_logs, proxy};
use runner_provider::http;
#[cfg(test)]
use runner_storage::storage_cache;
use runner_storage::storage_fingerprints;

pub mod blank_pool;
pub mod claimed_activation;
pub mod claimed_resource_activation;
mod duration;
pub mod finalizing_admission;
pub mod heartbeat;
pub mod host_memory;
pub mod idle_lifecycle;
pub mod job_lifecycle;
mod network_log_http_adapter;
pub mod orphan_reap;
pub mod ownership;
pub mod pre_claim_admission;
#[cfg(test)]
mod provider_test_support;
pub mod reactor;
pub mod sandbox_finalization;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

/// A factory owned by the reactor and shared with jobs and idle sandboxes.
pub type SharedFactory = Arc<Box<dyn SandboxFactory>>;
