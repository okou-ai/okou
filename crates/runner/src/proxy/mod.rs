//! Runner-side mitmproxy process and addon protocol.
//!
//! This module owns the Rust side of the runner's transparent proxy. It
//! extracts the embedded Python addon into the runner's `mitm-addon`
//! directory, starts `mitmdump` with runner-specific options, publishes sandbox
//! metadata through the proxy registry, and coordinates crash notification,
//! restart, webhook delivery drain, JSONL log flush, and graceful stop behavior.
//!
//! The private Rust/Python boundary uses control I/O plus existing files/options:
//!
//! - `okou_proxy_registry_path` points the addon at the registry JSON written
//!   by [`ProxyRegistryHandle`].
//! - `okou_usage_state_id` identifies the currently running mitmdump/addon
//!   process. Restart rotates this value so stale addon state from an older
//!   child is rejected.
//! - `okou_control_socket_dir` selects the private launch directory containing
//!   `control.sock`. A bounded, correlated `proxy.status` exchange confirms
//!   initialized handlers for the active generation before the TCP probe.
//! - `delivery.flush` admits a coalesced background wake. `delivery.drain`
//!   observes bounded delivery progress; `delivery.status` reads pending work
//!   and known outcomes without I/O. Quiescence does not certify all delivery.
//! - `logs.flush` captures an accepted-write prefix for the original run/path
//!   and generation before upload. Processing includes failed append attempts;
//!   it does not certify persistence. Connections never own pending writes.
//! - `registry.apply` correlates published bytes with the actual registry/catalog
//!   view compiled by the addon. `registry.status` observes the last completed
//!   load without file I/O. Neither replaces request-time file enforcement.
//!
//! On supported Unix runner hosts, registry writes are target-path atomic so
//! the addon never consumes partial JSON. Control replies must match the active
//! generation and request id. Missing or invalid replies are unknown outcomes,
//! not authorization to replay mutations against a replacement.
//! Webhook delivery drain is a shutdown path for billing, usage, and timing
//! reports, while JSONL flush is a per-upload network-log path.
//!
//! `MitmProxy::new` exclusively locks the runner-local proxy runtime, removes
//! stale private launch directories after terminating their marked processes,
//! and prepares addon files, an empty registry, crash channel, and initial
//! usage state. `start` gives each `mitmdump` process group a private `TMPDIR`
//! and starts monitor tasks. Unexpected stdout close notifies the runner unless
//! the child is stopping gracefully. `begin_restart` transfers the old child
//! and fresh parameters to an independent recovery task and silences the old
//! monitor. Recovery reaps the old process tree and removes its private launch
//! directory before spawning; `complete_restart` stores the new child. Unknown
//! old-child cleanup failures stop recovery instead of starting another child.
//! Shutdown observes delivery through the control socket for at most 30 seconds,
//! then calls `stop`. Recovery and shutdown only
//! act on runner-owned private paths and marked processes; legacy shared
//! `/tmp/_MEI*` paths are deliberately left untouched.
//!
//! Addon-side details live in `crates/runner/mitm-addon/src/mitm_addon.py`
//! (mitmproxy hook orchestration),
//! `crates/runner/mitm-addon/src/runner_control.py` (independent control I/O),
//! `crates/runner/mitm-addon/src/runner_flush_lifecycle.py` (coalesced delivery
//! worker),
//! `crates/runner/mitm-addon/src/usage/counters.py` (in-memory delivery observations),
//! `crates/runner/mitm-addon/src/registry.py` (registry loading), and
//! `crates/runner/mitm-addon/src/jsonl_writer.py` (accepted-write flush
//! semantics).

mod control;
mod delivery;
mod log_flush;
mod managed_process;
mod process;
mod registry;
mod registry_application;
mod runtime;
mod stderr;

pub use log_flush::{MitmJsonlFlushHandle, MitmRunLogFlush};
pub(crate) use managed_process::ManagedMitmdump;
pub(crate) use process::MitmRestartError;
pub use process::{MitmProxy, ProxyConfig};
pub(crate) use registry::{
    ConnectorRuntimeFailCloseOutcome, ConnectorRuntimePublication, ConnectorRuntimeRegistryUpdate,
    CustomConnectorRuntimeRegistryState,
};
pub use registry::{ProxyRegistryHandle, SandboxRegistration};
