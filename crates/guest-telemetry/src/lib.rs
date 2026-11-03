//! Shared logging and telemetry utilities for guest-side VM tools.
//!
//! This crate provides:
//! - Structured guest logging macros
//! - Sandbox operation telemetry helpers

pub mod log;
pub mod telemetry;

#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
