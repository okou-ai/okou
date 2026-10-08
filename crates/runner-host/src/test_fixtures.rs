//! Test-only host subprocess fixtures shared by Runner and lifecycle tests.

// The opt-in feature builds assertions into test binaries of dependent crates.
#![cfg_attr(
    feature = "test-support",
    allow(clippy::expect_used, clippy::panic, clippy::indexing_slicing)
)]

pub mod ignored_child;
