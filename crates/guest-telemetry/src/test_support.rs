//! Clear-on-drop ownership for test-installed process-global log destinations.
//!
//! Callers must retain exclusive ownership using their existing test locks or
//! fixture lifetimes. These guards do not serialize callers, support nesting or
//! restore an earlier destination. Dropping a guard clears the current path;
//! operation records that already captured a sink can still finish on that sink.

use std::path::Path;

/// Clears the current system-log destination on drop.
#[must_use]
pub struct SystemLogOverrideGuard;

impl SystemLogOverrideGuard {
    /// Installs a destination and owns its cleanup until the guard is dropped.
    pub fn set(path: impl AsRef<Path>) -> Self {
        crate::log::set_system_log_file(path);
        Self
    }
}

impl Drop for SystemLogOverrideGuard {
    fn drop(&mut self) {
        crate::log::clear_system_log_file();
    }
}

/// Clears the current sandbox-operation destination on drop.
///
/// The unit value may also arm cleanup after an existing raw setter. Retain one
/// guard across subsequent setters rather than dropping/replacing it afterward.
#[must_use]
pub struct SandboxOpsOverrideGuard;

impl SandboxOpsOverrideGuard {
    /// Installs a destination and owns its cleanup until the guard is dropped.
    pub fn set(path: impl AsRef<Path>) -> Self {
        crate::telemetry::set_sandbox_ops_log_file(path);
        Self
    }
}

impl Drop for SandboxOpsOverrideGuard {
    fn drop(&mut self) {
        crate::telemetry::clear_sandbox_ops_log_file();
    }
}
