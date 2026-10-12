use super::super::*;

#[test]
fn host_cpu_placement_policy_uses_worker_mode_and_budget_ratio() {
    let budget = ResourceBudget::new(4, 32_768, 2.0, 8);

    let production = host_cpu_placement_config(&budget, false).unwrap();
    assert_eq!(production.control_weight(), 200);
    assert_eq!(production.guests_weight(), 9_800);
    assert_eq!(production.mode(), sandbox::HostCpuPlacementMode::Required);

    let local = host_cpu_placement_config(&budget, true).unwrap();
    assert_eq!(local.control_weight(), 200);
    assert_eq!(local.guests_weight(), 9_800);
    assert_eq!(local.mode(), sandbox::HostCpuPlacementMode::PreferManaged);
}
