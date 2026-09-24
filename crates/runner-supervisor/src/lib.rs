//! High-level Runner start-loop resource orchestration.
//!
//! The executable builds concrete factories and configuration; this crate owns
//! idle and heartbeat policy above lifecycle, provider, and executor.

use std::sync::Arc;

use sandbox::SandboxFactory;

pub mod blank_pool;
pub mod heartbeat;
pub mod idle_lifecycle;

/// A factory constructed by the Runner composition root and shared with jobs.
pub type SharedFactory = Arc<Box<dyn SandboxFactory>>;
