// Each #[tokio::test] spins up an isolated single-thread runtime, so
// tokio::sync::Mutex cannot wake waiters across runtimes. A std Mutex
// serialises correctly (each runtime owns its own OS thread).
#![allow(clippy::await_holding_lock)]

#[macro_use]
pub(crate) mod support;

mod codex_session_cleanup;
mod complete;
mod events;
mod finalization;
mod guest_config;
mod heartbeat;
mod http_client;
mod metrics;
mod presigned_upload;
mod telemetry;
