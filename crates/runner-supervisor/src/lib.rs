//! High-level Runner start-loop resource orchestration.
//!
//! The executable builds concrete factories and configuration; this crate owns
//! idle, finalizing-successor admission, post-executor sandbox finalization, heartbeat, claimed-run completion, and orphan ownership policy above lifecycle,
//! provider, and executor.

use std::sync::Arc;

use sandbox::SandboxFactory;

pub mod blank_pool;
pub mod finalizing_admission;
pub mod heartbeat;
pub mod idle_lifecycle;
pub mod job_lifecycle;
pub mod orphan_reap;
pub mod ownership;
pub mod sandbox_finalization;

/// A factory constructed by the Runner composition root and shared with jobs.
pub type SharedFactory = Arc<Box<dyn SandboxFactory>>;
