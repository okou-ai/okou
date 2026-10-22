#![deny(missing_docs)]

//! Domain-neutral raw HTTP transport fixtures for Rust tests.
//!
//! Enable the non-default `test-support` feature in development dependencies or
//! an opt-in test-support build. Default builds expose no fixture API and do not
//! depend on Tokio.

/// Scripted loopback HTTP servers, request capture and bounded task cleanup.
#[cfg(any(test, feature = "test-support"))]
pub mod raw_http;

/// Timer phases that resume real time before scheduling transport work.
#[cfg(any(test, feature = "test-support"))]
pub mod clock;
