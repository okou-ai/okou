//! Validated runner systemd identities, host queries, and selected unit configuration.
//!
//! Command lifecycle policy and unit generation/publication remain in Runner.

mod diagnostic;
mod systemctl;
mod target;
mod unit_config;

#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

pub use diagnostic::status_field_preview;
pub use systemctl::{
    BoundedSystemctlOutcome, BoundedSystemctlQuery, CleanupUnitActiveState, ServiceUnitState,
    SystemdReloadState, SystemdUnitEnablement, cleanup_unit_active_state_bounded,
    get_service_restart_policy, has_service_main_process, has_service_main_process_bounded,
    is_unit_active, is_unit_active_bounded, is_unit_active_bounded_query, is_unit_enabled,
    is_unit_enabled_bounded, journalctl_logs_status, read_service_unit_state,
    read_systemd_reload_state, read_systemd_reload_state_bounded, read_unit_enablement,
    restore_unit_enablement, run_systemctl, run_systemctl_bounded, run_systemctl_output_bounded,
};
pub use target::{RunnerServiceUnit, all_units_pattern};
pub use unit_config::{
    parse_unit_config_path, read_unit_config_path, read_unit_config_path_bounded,
};
