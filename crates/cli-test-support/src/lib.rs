#![cfg(feature = "test-support")]

//! Shared CLI fixtures compiled independently of their integration executables.
//!
//! Enable `test-support` only in development dependencies or an explicit fixture
//! build. Default builds expose no fixture API and activate no dependencies.
//! Guest runtime adapters and process-global setup remain with their test owners.

pub mod command;
pub mod delivery_image;
pub mod http;
pub mod json_fixture;
pub mod mock_build;
pub mod process_session;
pub mod readiness;
