//! Deliberate state fixtures for cross-owner service policy tests.
//!
//! Production query fields and normalization stay private to the host owner.

use super::{CleanupUnitActiveState, ServiceUnitState, SystemdReloadState};
use crate::HostResult;

pub fn reload_state(
    is_not_found: bool,
    need_daemon_reload: bool,
    drop_in_paths: Vec<String>,
) -> SystemdReloadState {
    SystemdReloadState::for_test(is_not_found, need_daemon_reload, drop_in_paths)
}

pub fn cleanup_unit_active_state(active_state: &str, active_like: bool) -> CleanupUnitActiveState {
    CleanupUnitActiveState::for_test(active_state, active_like)
}

/// Normalize a unit-state fixture, rejecting invalid states without a library panic.
pub fn service_unit_state(
    load_state: &str,
    active_state: &str,
    sub_state: &str,
    result: &str,
) -> HostResult<ServiceUnitState> {
    ServiceUnitState::for_test(load_state, active_state, sub_state, result)
}
