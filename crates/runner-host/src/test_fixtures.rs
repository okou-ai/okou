//! Test-only host resource fixtures shared by Runner and its owner tests.

// The opt-in feature builds assertions into test binaries of dependent crates.
#![cfg_attr(
    feature = "test-support",
    allow(clippy::expect_used, clippy::panic, clippy::indexing_slicing)
)]

pub mod blocking_worker;
#[cfg(any(target_os = "linux", target_os = "android"))]
pub mod file_events;
pub mod ignored_child;
