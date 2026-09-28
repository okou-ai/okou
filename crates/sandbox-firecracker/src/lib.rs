//! Firecracker-backed implementation of the `sandbox` provider traits.
//!
//! This crate wires Firecracker microVMs, host networking, COW rootfs devices,
//! vsock control, and snapshot creation behind the provider-neutral traits from
//! the `sandbox` crate. Most runner code should target those traits; use this
//! crate directly when constructing the Firecracker provider or when a tool
//! needs Firecracker-specific controls.
//!
//! The main entry points are:
//!
//! - [`FirecrackerRuntime`], which manages shared host resources and creates
//!   sandbox factories for configured rootfs, kernel, and profile settings.
//! - [`FirecrackerSandbox`], the Firecracker-backed implementation of
//!   `sandbox::Sandbox` for a sandbox lifecycle.
//! - [`FirecrackerControl`], which exposes control-plane operations for a
//!   running sandbox.
//! - [`FirecrackerSnapshotProvider`], which creates snapshots compatible with
//!   this provider.
//! - [`NetnsPool`] and [`NetnsLease`], for code that must manage provider
//!   network resources directly.
//!
//! Lower-level helpers such as [`ApiClient`] and the exported path/config types
//! are public for runner integration and diagnostics, but they are not the
//! preferred abstraction for normal sandbox lifecycle code.

mod api;
mod balloon;
mod boot_config;
mod command;
mod config;
pub mod control;
mod cow_cleanup;
mod cow_pool;
mod duration;
mod exec_operation_result;
mod factory;
mod firecracker_process;
mod guest_dns_failure_diagnostics;
mod guest_dns_probe;
mod guest_dns_readiness;
mod guest_operations;
mod guest_rpc;
mod host_cpu_cgroup;
mod leaked_resources;
mod network;
mod park_coordinator;
mod paths;
mod prerequisites;
mod process;
mod process_log;
mod runtime;
mod runtime_dirs;
mod sandbox;
mod snapshot;
mod snapshot_mount_namespace;
mod workspace_drive_image;

pub use api::{ApiClient, ApiError, BalloonStatistics};
pub use config::{
    FirecrackerConfig, FirecrackerDeviceRateLimits, RateLimiterConfig, SnapshotConfig,
    TokenBucketConfig,
};
pub use control::FirecrackerControl;
pub use factory::{PREWARM_SCRIPT, config_hash};
pub use guest_dns_probe::{DNS_PROBE_RESOLVER_IPV4, DNS_READINESS_HOSTNAME, DNS_READINESS_IPV4};
pub use network::{
    NetnsInfo, NetnsLease, NetnsPool, NetnsPoolConfig, ParsedNetnsName, parse_netns_name,
};
pub use paths::{
    FactoryPaths, LockPaths, RuntimePaths, SandboxPaths, SnapshotOutputPaths, SockPaths,
};
pub use prerequisites::runtime_required_commands;
pub use runtime::{FirecrackerRuntime, FirecrackerRuntimeProvider};
pub use sandbox::FirecrackerSandbox;
pub use snapshot::{
    FirecrackerSnapshotProvider, SNAPSHOT_COMPLETE_MARKER_CONTENT, SnapshotError,
    SnapshotOutputValidation, create_snapshot, validate_snapshot_output,
};
