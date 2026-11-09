//! Shared logging and telemetry utilities for guest-side VM tools.
//!
//! This crate provides:
//! - Structured guest logging macros
//! - Sandbox operation telemetry helpers

pub mod log;
pub mod telemetry;

/// Shared read-only admission for Guest storage publication.
pub mod storage_eligibility;

/// Connection-owned readiness resources for fixed Guest storage helpers.
#[cfg(target_os = "linux")]
pub mod storage_notifications;

#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
