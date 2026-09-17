//! Host process discovery via `/proc` scanning.
//!
//! Shared by runner commands that need live host process facts, including
//! `doctor`, `kill`, `gc`, and orphan reaping.
//! Live runner identity is not inferred here; runner processes publish
//! registry entries through `live_runner_instances`.

mod ancestry;
mod discovery;
mod procfs;
mod types;

pub use self::ancestry::{is_orphan, process_has_ancestor};
pub(crate) use self::discovery::discover_all_with_status;
#[cfg(test)]
pub(crate) use self::discovery::parse_dnsmasq_cmdline;
#[cfg(test)]
pub(crate) use self::discovery::test_support as discovery_test_support;
pub use self::discovery::{discover_all, firecracker_process_exists_for_sandbox_id};
pub(crate) use self::discovery::{is_firecracker_cmdline, parse_workspace_cwd};
pub use self::procfs::read_service_unit;
pub(crate) use self::procfs::{
    ProcessStatRead, ProcfsProcessHandle, read_process_stat, read_process_stat_checked,
    read_process_stat_checked_blocking, read_process_stat_checked_from,
};
pub use self::types::{
    DiscoveredProcesses, DnsmasqProcessInfo, FirecrackerProcessInfo, MitmproxyProcessInfo,
    ProcessStat, ProcfsProcessGeneration,
};
pub(crate) use self::types::{ProcessDiscovery, process_stat_is_live};
