use super::*;

fn assert_f64_close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-12,
        "expected {expected}, got {actual}"
    );
}

#[test]
fn fixed_host_cpu_reservation_curve() {
    let cases = [
        (1, 0.060, 0.940),
        (2, 0.070, 1.930),
        (4, 0.080, 3.920),
        (8, 0.090, 7.910),
        (16, 0.110, 15.890),
        (32, 0.150, 31.850),
        (64, 0.230, 63.770),
        (128, 0.390, 127.610),
    ];

    for (host_cpus, expected_reservation, expected_guest_capacity) in cases {
        let budget = ResourceBudget::new(host_cpus, 1, 1.0, 0);
        assert_f64_close(
            budget.host_cpu_admission_reservation(),
            expected_reservation,
        );
        assert_f64_close(
            budget.guest_cpu_admission_capacity(),
            expected_guest_capacity,
        );
        assert_f64_close(budget.vcpu_admission_limit(), expected_guest_capacity);
    }
}

#[test]
fn concurrency_factor_applies_after_host_cpu_reservation() {
    let cases = [
        (1, 0.5, 0.470, 0, 1),
        (8, 0.5, 3.955, 3, 1),
        (16, 1.0, 15.890, 15, 7),
        (4, 1.5, 5.880, 5, 2),
        (4, 2.0, 7.840, 7, 3),
    ];

    for (host_cpus, factor, expected_limit, expected_effective, admitted_pairs) in cases {
        let budget = ResourceBudget::new(host_cpus, u32::MAX, factor, 0);
        assert_f64_close(budget.vcpu_admission_limit(), expected_limit);
        assert_eq!(budget.effective_vcpu(), expected_effective);

        for _ in 0..admitted_pairs {
            assert!(budget.try_reserve_inner(2, 1));
        }
        assert!(!budget.try_reserve_inner(2, 1));
    }
}

#[test]
fn host_cpu_cgroup_weights_preserve_reservation_ratio() {
    let cases = [(1, (600, 9400)), (4, (200, 9800)), (64, (36, 9964))];

    for (host_cpus, expected) in cases {
        let first = ResourceBudget::new(host_cpus, 1, 1.0, 0);
        let overcommitted = ResourceBudget::new(host_cpus, 1, 2.0, 0);
        assert_eq!(first.host_cpu_cgroup_weights(), expected);
        assert_eq!(overcommitted.host_cpu_cgroup_weights(), expected);
    }
}

#[test]
fn fractional_cpu_admission_limit_accepts_floor_and_rejects_ceiling() {
    let budget = ResourceBudget::new(16, u32::MAX, 1.0, 0);

    assert!(budget.try_reserve_inner(14, 1));
    assert!(budget.try_reserve_inner(1, 1)); // 15 <= 15.89
    assert!(!budget.try_reserve_inner(1, 1)); // 16 > 15.89
}

struct AdmissionParityCase<'a> {
    name: &'a str,
    host_vcpu: u32,
    host_memory_mb: u32,
    max_concurrent: usize,
    existing_reservations: &'a [(u32, u32)],
    request: (u32, u32),
    expected: bool,
}

fn budget_with_reservations(
    host_vcpu: u32,
    host_memory_mb: u32,
    max_concurrent: usize,
    reservations: &[(u32, u32)],
) -> ResourceBudget {
    let budget = ResourceBudget::new(host_vcpu, host_memory_mb, 1.0, max_concurrent);
    for &(vcpu, memory_mb) in reservations {
        assert!(budget.try_reserve_inner(vcpu, memory_mb));
    }
    budget
}

fn assert_admission_parity(case: AdmissionParityCase<'_>) {
    let (request_vcpu, request_memory_mb) = case.request;

    let can_afford_budget = budget_with_reservations(
        case.host_vcpu,
        case.host_memory_mb,
        case.max_concurrent,
        case.existing_reservations,
    );
    assert_eq!(
        can_afford_budget.can_afford(request_vcpu, request_memory_mb),
        case.expected,
        "can_afford mismatch for {}",
        case.name
    );

    let reserve_budget = budget_with_reservations(
        case.host_vcpu,
        case.host_memory_mb,
        case.max_concurrent,
        case.existing_reservations,
    );
    let before = reserve_budget.allocated();
    assert_eq!(
        reserve_budget.try_reserve_inner(request_vcpu, request_memory_mb),
        case.expected,
        "reservation mismatch for {}",
        case.name
    );

    if case.expected {
        assert_eq!(
            reserve_budget.allocated(),
            (
                before.0 + request_vcpu,
                before.1 + request_memory_mb,
                before.2 + 1
            ),
            "successful reservation recorded wrong allocation for {}",
            case.name
        );
    } else {
        assert_eq!(
            reserve_budget.allocated(),
            before,
            "failed reservation mutated budget for {}",
            case.name
        );
    }
}

#[test]
fn reserve_within_budget() {
    let budget = ResourceBudget::new(8, 16384, 1.0, 0);
    assert!(budget.try_reserve_inner(2, 2048));
    let state = budget.lock();
    assert_eq!(state.running_vcpu, 2);
    assert_eq!(state.running_memory_mb, 2048);
    assert_eq!(state.running_count, 1);
}

#[test]
fn observing_reclaimable_leases_keeps_actual_capacity_reserved() {
    let budget = Arc::new(ResourceBudget::new(5, 8192, 1.0, 2));
    let _active = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let parked = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();

    assert!(budget.can_afford_after_releasing(2, 4096, [&parked]));
    assert!(!budget.can_afford_after_releasing(4, 8192, [&parked]));
    assert_eq!(budget.allocated(), (4, 8192, 2));
    assert!(ResourceBudget::try_reserve_lease(&budget, 2, 4096).is_none());

    let _replacement = ResourceBudget::try_substitute_leases(&budget, vec![parked], 2, 4096)
        .unwrap_or_else(|_| panic!("observed replacement should fit"));
    assert_eq!(budget.allocated(), (4, 8192, 2));
    assert!(ResourceBudget::try_reserve_lease(&budget, 2, 4096).is_none());
}

#[test]
fn original_lease_witness_cannot_be_replaced_by_an_unrelated_reservation() {
    let budget = Arc::new(ResourceBudget::new(12, 24576, 1.0, 0));
    let original = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let witness = original.witness().unwrap();
    let unrelated = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    assert!(witness.is_active());
    assert_eq!(witness.resources(), (2, 4096));
    drop(original);
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert!(!witness.is_active());
    drop(unrelated);
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[test]
fn same_shape_atomic_transfer_preserves_the_original_nonowning_witness() {
    let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
    let original = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let witness = original.witness().unwrap();
    let incoming = ResourceBudget::try_substitute_leases(&budget, vec![original], 2, 4096)
        .unwrap_or_else(|_| panic!("same shape substitution should fit"));
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert!(witness.is_active());
    drop(incoming);
    assert!(!witness.is_active());
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[test]
fn failed_substitution_keeps_the_original_witness_and_shape_change_does_not() {
    let budget = Arc::new(ResourceBudget::new(8, 8192, 1.0, 0));
    let original = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let witness = original.witness().unwrap();
    let other = ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap();
    let originals = match ResourceBudget::try_substitute_leases(&budget, vec![original], 2, 8192) {
        Err(leases) => leases,
        Ok(_) => panic!("substitution must not steal the unrelated reservation"),
    };
    assert!(witness.is_active());
    assert_eq!(budget.allocated(), (4, 8192, 2));
    drop(other);
    let incoming = ResourceBudget::try_substitute_leases(&budget, originals, 2, 8192)
        .unwrap_or_else(|_| panic!("changed shape should now fit"));
    assert!(!witness.is_active());
    assert_eq!(budget.allocated(), (2, 8192, 1));
    drop(incoming);
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[test]
fn reserve_fails_on_vcpu_exhaustion() {
    let budget = ResourceBudget::new(5, 16384, 1.0, 0);
    assert!(budget.try_reserve_inner(2, 2048));
    assert!(budget.try_reserve_inner(2, 2048));
    assert!(!budget.try_reserve_inner(2, 2048)); // 6 > 4.9175
    assert_eq!(budget.lock().running_count, 2);
}

#[test]
fn reserve_fails_on_memory_exhaustion() {
    let budget = ResourceBudget::new(16, 4096, 1.0, 0);
    assert!(budget.try_reserve_inner(2, 2048));
    assert!(budget.try_reserve_inner(2, 2048));
    assert!(!budget.try_reserve_inner(2, 2048)); // 6144 > 4096
    // vcpu should not be consumed on memory failure
    assert_eq!(budget.lock().running_vcpu, 4);
}

#[test]
fn reserve_fails_on_max_concurrent() {
    let budget = ResourceBudget::new(16, 32768, 1.0, 2);
    assert!(budget.try_reserve_inner(2, 2048));
    assert!(budget.try_reserve_inner(2, 2048));
    assert!(!budget.try_reserve_inner(2, 2048)); // count 2 >= max 2
    let state = budget.lock();
    assert_eq!(state.running_vcpu, 4);
    assert_eq!(state.running_memory_mb, 4096);
}

#[test]
fn reservation_with_headroom_observes_one_budget_snapshot() {
    let available = ResourceBudget::new(20, 40_960, 1.0, 0);
    assert_eq!(
        available.observe_reservation_with_headroom(2, 4096, 2, 4096),
        (ReservationWithHeadroomStatus::Available, (0, 0, 0))
    );

    let resource_limited = ResourceBudget::new(20, 40_960, 1.0, 0);
    assert!(resource_limited.try_reserve_inner(18, 36_864));
    assert_eq!(
        resource_limited.observe_reservation_with_headroom(2, 4096, 2, 4096),
        (
            ReservationWithHeadroomStatus::ResourceUnavailable,
            (18, 36_864, 1),
        )
    );

    let headroom_limited = ResourceBudget::new(20, 40_960, 1.0, 0);
    assert!(headroom_limited.try_reserve_inner(17, 34_816));
    assert_eq!(
        headroom_limited.observe_reservation_with_headroom(2, 4096, 2, 4096),
        (
            ReservationWithHeadroomStatus::HeadroomReserved,
            (17, 34_816, 1),
        )
    );
}

#[test]
fn release_frees_resources() {
    let budget = ResourceBudget::new(5, 4096, 1.0, 0);
    assert!(budget.try_reserve_inner(2, 2048));
    assert!(budget.try_reserve_inner(2, 2048));
    assert!(!budget.try_reserve_inner(2, 2048));
    budget.release(2, 2048);
    assert!(budget.try_reserve_inner(2, 2048)); // works after release
}

#[test]
fn lease_drop_frees_resources() {
    let budget = Arc::new(ResourceBudget::new(4, 4096, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();
    assert_eq!(budget.allocated(), (2, 2048, 1));

    drop(lease);

    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[test]
fn lease_reservation_failure_does_not_consume_budget() {
    let budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();

    assert!(ResourceBudget::try_reserve_lease(&budget, 2, 2048).is_none());
    assert_eq!(budget.allocated(), (2, 2048, 1));

    drop(lease);
    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[test]
fn lease_drop_does_not_panic_on_underflow() {
    let budget = Arc::new(ResourceBudget::new(4, 4096, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 2048).unwrap();

    budget.release(2, 2048);
    drop(lease);

    assert_eq!(budget.allocated(), (0, 0, 0));
}

#[test]
fn can_afford_matches_reserve() {
    let cases = [
        AdmissionParityCase {
            name: "idle first-job bypass",
            host_vcpu: 1,
            host_memory_mb: 1024,
            max_concurrent: 0,
            existing_reservations: &[],
            request: (2, 2048),
            expected: true,
        },
        AdmissionParityCase {
            name: "over-budget second job",
            host_vcpu: 1,
            host_memory_mb: 1024,
            max_concurrent: 0,
            existing_reservations: &[(2, 2048)],
            request: (2, 2048),
            expected: false,
        },
        AdmissionParityCase {
            name: "within budget",
            host_vcpu: 5,
            host_memory_mb: 4096,
            max_concurrent: 0,
            existing_reservations: &[(2, 2048)],
            request: (2, 2048),
            expected: true,
        },
        AdmissionParityCase {
            name: "vcpu exhausted",
            host_vcpu: 5,
            host_memory_mb: 8192,
            max_concurrent: 0,
            existing_reservations: &[(2, 2048), (2, 2048)],
            request: (1, 1024),
            expected: false,
        },
        AdmissionParityCase {
            name: "memory exhausted",
            host_vcpu: 8,
            host_memory_mb: 4096,
            max_concurrent: 0,
            existing_reservations: &[(2, 2048), (2, 2048)],
            request: (1, 1024),
            expected: false,
        },
        AdmissionParityCase {
            name: "max concurrent exhausted",
            host_vcpu: 16,
            host_memory_mb: 32768,
            max_concurrent: 2,
            existing_reservations: &[(2, 2048), (2, 2048)],
            request: (1, 1024),
            expected: false,
        },
        AdmissionParityCase {
            name: "max concurrent zero has no count cap",
            host_vcpu: 17,
            host_memory_mb: 32768,
            max_concurrent: 0,
            existing_reservations: &[
                (2, 2048),
                (2, 2048),
                (2, 2048),
                (2, 2048),
                (2, 2048),
                (2, 2048),
                (2, 2048),
            ],
            request: (2, 2048),
            expected: true,
        },
    ];

    for case in cases {
        assert_admission_parity(case);
    }
}

#[test]
fn can_afford_matches_reserve_after_lease_drop() {
    let can_afford_budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&can_afford_budget, 2, 4096).unwrap();
    assert!(!can_afford_budget.can_afford(2, 4096));
    drop(lease);
    assert!(can_afford_budget.can_afford(2, 4096));

    let reserve_budget = Arc::new(ResourceBudget::new(2, 4096, 1.0, 0));
    let lease = ResourceBudget::try_reserve_lease(&reserve_budget, 2, 4096).unwrap();
    assert!(ResourceBudget::try_reserve_lease(&reserve_budget, 2, 4096).is_none());
    drop(lease);
    assert!(ResourceBudget::try_reserve_lease(&reserve_budget, 2, 4096).is_some());
}

#[test]
fn admission_rejects_overflow_without_consuming_budget() {
    let budget = ResourceBudget::new(1, 1, 1.0, 0);
    assert!(budget.try_reserve_inner(u32::MAX, u32::MAX));

    assert!(!budget.can_afford(1, 1));
    assert!(!budget.try_reserve_inner(1, 1));
    assert_eq!(budget.allocated(), (u32::MAX, u32::MAX, 1));
}

#[test]
fn concurrency_factor_increases_budget() {
    // (4 CPUs - 0.08 reserved) * 2.0 = 7.84 declared vCPU admission.
    let budget = ResourceBudget::new(4, 8192, 2.0, 0);
    assert_eq!(budget.effective_vcpu(), 7);
    assert_eq!(budget.effective_memory_mb(), 16384);
    for _ in 0..3 {
        assert!(budget.try_reserve_inner(2, 2048));
    }
    assert!(!budget.try_reserve_inner(2, 2048)); // vCPU: 8 > 7.84
}

#[test]
fn max_concurrent_zero_means_no_cap() {
    let budget = ResourceBudget::new(17, 65536, 1.0, 0);
    for _ in 0..8 {
        assert!(budget.try_reserve_inner(2, 2048));
    }
    assert_eq!(budget.lock().running_count, 8);
}

#[test]
fn mixed_resource_jobs() {
    // 8.9075 declared vCPU admission and 8GB memory fit this mixed shape.
    let budget = ResourceBudget::new(9, 8192, 1.0, 0);
    assert!(budget.try_reserve_inner(4, 4096)); // browser
    assert!(budget.try_reserve_inner(2, 2048)); // default
    assert!(budget.try_reserve_inner(2, 2048)); // default — exactly 8/8
    assert!(!budget.try_reserve_inner(2, 2048)); // no room
}

#[test]
fn first_job_admitted_even_if_exceeds_budget() {
    // 1 CPU, 1GB — job needs 2 vcpu / 2GB, exceeds both limits
    let budget = ResourceBudget::new(1, 1024, 1.0, 0);
    assert!(budget.try_reserve_inner(2, 2048)); // first job always admitted
    assert!(!budget.try_reserve_inner(2, 2048)); // second blocked
    budget.release(2, 2048);
    assert!(budget.try_reserve_inner(2, 2048)); // first again after release
}

#[test]
fn first_job_bypass_respects_max_concurrent() {
    // max_concurrent=1 still limits to 1 job, but first job can exceed resource budget
    let budget = ResourceBudget::new(1, 512, 1.0, 1);
    assert!(budget.try_reserve_inner(2, 2048)); // first job: exceeds budget but admitted
    assert!(!budget.try_reserve_inner(2, 2048)); // blocked by max_concurrent
}

#[test]
fn release_returns_to_zero() {
    let budget = ResourceBudget::new(8, 16384, 1.0, 0);
    assert!(budget.try_reserve_inner(2, 2048));
    assert!(budget.try_reserve_inner(4, 4096));
    budget.release(2, 2048);
    budget.release(4, 4096);
    let state = budget.lock();
    assert_eq!(state.running_vcpu, 0);
    assert_eq!(state.running_memory_mb, 0);
    assert_eq!(state.running_count, 0);
}

#[test]
fn concurrent_reserves_no_overcommit() {
    use std::sync::Arc;

    let budget = Arc::new(ResourceBudget::new(5, 8192, 1.0, 0));
    let mut handles = vec![];

    // Spawn 10 threads each trying to reserve 2 vcpu / 2048 MB
    // Only 2 should succeed (4.9175 declared vCPU admission — first-job bypass doesn't
    // help the second thread because count > 0 after the first).
    for _ in 0..10 {
        let b = Arc::clone(&budget);
        handles.push(std::thread::spawn(move || b.try_reserve_inner(2, 2048)));
    }

    let successes: usize = handles
        .into_iter()
        .map(|h| if h.join().unwrap() { 1 } else { 0 })
        .sum();

    assert_eq!(successes, 2);
    let state = budget.lock();
    assert_eq!(state.running_vcpu, 4);
    assert_eq!(state.running_memory_mb, 4096);
    assert_eq!(state.running_count, 2);
}

#[test]
fn allocated_empty() {
    let budget = ResourceBudget::new(16, 32768, 1.0, 8);
    let (vcpu, mem, count) = budget.allocated();
    assert_eq!(vcpu, 0);
    assert_eq!(mem, 0);
    assert_eq!(count, 0);
}

#[test]
fn allocated_partially_used() {
    let budget = ResourceBudget::new(16, 32768, 1.0, 8);
    budget.try_reserve_inner(4, 8192);
    budget.try_reserve_inner(2, 4096);
    let (vcpu, mem, count) = budget.allocated();
    assert_eq!(vcpu, 6);
    assert_eq!(mem, 12288);
    assert_eq!(count, 2);
}

#[test]
fn allocated_fully_used() {
    let budget = ResourceBudget::new(5, 4096, 1.0, 2);
    budget.try_reserve_inner(2, 2048);
    budget.try_reserve_inner(2, 2048);
    let (vcpu, mem, count) = budget.allocated();
    assert_eq!(vcpu, 4);
    assert_eq!(mem, 4096);
    assert_eq!(count, 2);
}

#[test]
fn allocated_overcommitted() {
    // First-job bypass allows exceeding budget
    let budget = ResourceBudget::new(1, 1024, 1.0, 0);
    budget.try_reserve_inner(2, 2048);
    let (vcpu, mem, count) = budget.allocated();
    assert_eq!(vcpu, 2);
    assert_eq!(mem, 2048);
    assert_eq!(count, 1);
}
