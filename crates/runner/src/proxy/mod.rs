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
//! - `usage-flush-request` is written by Rust before shutdown drain. The addon
//!   acknowledges in `usage-pending` with the matching usage state, flush
//!   request id, and pending flow/buffer/report counters.
//! - `jsonl-flush-request` is written by Rust for one network log path before
//!   upload. The addon acknowledges in `jsonl-flush-state` after accepted
//!   writes for that path are visible.
//!
//! On supported Unix runner hosts, registry writes are target-path atomic so
//! the addon never consumes partial JSON. Flush acknowledgements must match the
//! active usage state and request id; missing, stale, invalid, or mismatched
//! addon state is treated as "not ready" until the bounded wait times out.
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
//! Shutdown writes a usage flush request, signals the addon, waits
//! boundedly for `usage-pending`, then calls `stop`. Recovery and shutdown only
//! act on runner-owned private paths and marked processes; legacy shared
//! `/tmp/_MEI*` paths are deliberately left untouched.
//!
//! Addon-side details live in `crates/runner/mitm-addon/src/mitm_addon.py`
//! (mitmproxy hook orchestration),
//! `crates/runner/mitm-addon/src/runner_control.py` (independent control I/O),
//! `crates/runner/mitm-addon/src/runner_flush_lifecycle.py` (SIGUSR1 usage
//! worker and JSONL marker watcher),
//! `crates/runner/mitm-addon/src/usage/counters.py` (`usage-pending`),
//! `crates/runner/mitm-addon/src/registry.py` (registry loading), and
//! `crates/runner/mitm-addon/src/jsonl_writer.py` (accepted-write flush
//! semantics).

mod control;
mod flush;
mod managed_process;
mod process;
mod registry;
mod runtime;
mod stderr;

pub use flush::{
    MitmJsonlFlushHandle, USAGE_FLUSH_TIMEOUT, wait_usage_flush_requesting,
    write_usage_flush_request,
};
pub(crate) use managed_process::ManagedMitmdump;
pub(crate) use process::MitmRestartError;
pub use process::{MitmProxy, ProxyConfig};
pub(crate) use registry::{
    ConnectorRuntimeFailCloseOutcome, ConnectorRuntimeRegistryUpdate,
    CustomConnectorRuntimeRegistryState,
};
pub use registry::{ProxyRegistryHandle, SandboxRegistration};
