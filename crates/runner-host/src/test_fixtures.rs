//! Test-only host resource fixtures shared by Runner and its owner tests.

// The opt-in feature builds assertions into test binaries of dependent crates.
#![cfg_attr(
    feature = "test-support",
    allow(clippy::expect_used, clippy::panic, clippy::indexing_slicing)
)]

pub mod blocking_worker;
pub mod ignored_child;
