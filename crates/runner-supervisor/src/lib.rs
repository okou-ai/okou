//! High-level Runner start-loop resource orchestration.
//!
//! The executable builds concrete factories and configuration; this crate owns
//! idle, pre-claim admission, finalizing-successor admission, claimed activation ownership,
//! post-executor sandbox finalization, heartbeat, claimed-run completion, and orphan policy
//! above lifecycle, provider, and executor.

use std::sync::Arc;

use sandbox::SandboxFactory;

pub mod blank_pool;
pub mod claimed_activation;
pub mod claimed_resource_activation;
pub mod finalizing_admission;
pub mod heartbeat;
pub mod idle_lifecycle;
pub mod job_lifecycle;
pub mod orphan_reap;
pub mod ownership;
pub mod pre_claim_admission;
pub mod sandbox_finalization;

/// A factory constructed by the Runner composition root and shared with jobs.
pub type SharedFactory = Arc<Box<dyn SandboxFactory>>;
