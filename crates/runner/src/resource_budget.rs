use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::Notify;
use tracing::error;

/// Resource-budget concurrency control.
///
/// Tracks running vcpu, memory, and job count against effective limits.
/// Uses a mutex for correctness — hold times are negligible (no I/O), and
/// ordinary admission plus claimed fallback tasks may reserve concurrently.
///
/// Three conditions must hold for admission:
/// 1. `running_vcpu + vcpu <= vcpu_admission_limit`
/// 2. `running_memory_mb + memory_mb <= effective_memory_mb`
/// 3. `max_concurrent == 0 || running_count < max_concurrent`
///
/// Exception: if `running_count == 0`, the first job is always admitted
/// regardless of resource limits (ensures at least 1 job can run on
/// under-provisioned hosts — matches old `.max(1)` behaviour).
pub struct ResourceBudget {
    cpu_capacity: CpuAdmissionCapacity,
    effective_memory_mb: u32,
    max_concurrent: usize,
    state: Mutex<BudgetState>,
    availability: Notify,
}

#[derive(Clone, Copy)]
struct CpuAdmissionCapacity {
    host_reservation: f64,
    guest_capacity: f64,
    admission_limit: f64,
}

impl CpuAdmissionCapacity {
    fn new(host_cpus: u32, concurrency_factor: f64) -> Self {
        let host_cpus = f64::from(host_cpus);

        // R(P) follows GKE's node CPU reservation curve:
        // https://cloud.google.com/kubernetes-engine/docs/concepts/plan-node-sizes#cpu_reservations
        //
        // P is the logical CPU capacity visible to Runner; F is concurrency_factor.
        // R(P) = 0.06 * min(P, 1)
        //      + 0.01 * clamp(P - 1, 0, 1)
        //      + 0.005 * clamp(P - 2, 0, 2)
        //      + 0.0025 * max(P - 4, 0)
        // C(P) = P - R(P)
        // B(P, F) = C(P) * F
        //
        // The runner uses B(P, F) as the fractional declared-vCPU admission limit;
        // the GKE source defines R(P), not the runner's overcommit factor F.
        let host_reservation = 0.06 * host_cpus.min(1.0)
            + 0.01 * (host_cpus - 1.0).clamp(0.0, 1.0)
            + 0.005 * (host_cpus - 2.0).clamp(0.0, 2.0)
            + 0.0025 * (host_cpus - 4.0).max(0.0);
        let guest_capacity = host_cpus - host_reservation;
        let admission_limit = guest_capacity * concurrency_factor;
        Self {
            host_reservation,
            guest_capacity,
            admission_limit,
        }
    }

    fn effective_vcpu(self) -> u32 {
        self.admission_limit.floor() as u32
    }
}

/// Owned reservation against a [`ResourceBudget`].
///
/// The lease releases its reservation when dropped. Drop must never panic:
/// idle sandbox cleanup may run while unwinding from sandbox/factory failures, and
/// a panic here would turn a cleanup failure into a budget leak or task abort.
#[must_use = "dropping a BudgetLease releases the reserved resources"]
pub struct BudgetLease {
    budget: Option<Arc<ResourceBudget>>,
    vcpu: u32,
    memory_mb: u32,
}

#[derive(Debug, PartialEq, Eq)]
enum BudgetReleaseError {
    Vcpu { running: u32, release: u32 },
    Memory { running: u32, release: u32 },
    Count,
}

struct BudgetState {
    running_vcpu: u32,
    running_memory_mb: u32,
    running_count: usize,
}

impl BudgetLease {
    fn new(budget: Arc<ResourceBudget>, vcpu: u32, memory_mb: u32) -> Self {
        Self {
            budget: Some(budget),
            vcpu,
            memory_mb,
        }
    }

    /// Returns the vCPU reservation held by this lease.
    pub fn vcpu(&self) -> u32 {
        self.vcpu
    }

    /// Returns the memory reservation, in MiB, held by this lease.
    pub fn memory_mb(&self) -> u32 {
        self.memory_mb
    }

    fn release_inner(&mut self) {
        let Some(budget) = self.budget.take() else {
            return;
        };

        match budget.release_reserved(self.vcpu, self.memory_mb) {
            Ok(()) => budget.availability.notify_waiters(),
            Err(error) => {
                error!(
                    ?error,
                    vcpu = self.vcpu,
                    memory_mb = self.memory_mb,
                    "failed to release resource budget lease"
                );
            }
        }
    }
}

impl Drop for BudgetLease {
    fn drop(&mut self) {
        self.release_inner();
    }
}

impl ResourceBudget {
    /// Create a new resource budget from host resources and config.
    ///
    /// CPU admission reserves fixed host headroom before applying
    /// `concurrency_factor`; memory applies the factor directly.
    /// Free-page reporting releases genuinely free pages; parked Guests also
    /// request balloon reclamation. Active Guests can use their full profile
    /// capacity, so neither mechanism guarantees resident-memory headroom
    /// when profiles are overcommitted.
    pub fn new(
        host_cpus: u32,
        host_memory_mb: u32,
        concurrency_factor: f64,
        max_concurrent: usize,
    ) -> Self {
        let cpu_capacity = CpuAdmissionCapacity::new(host_cpus, concurrency_factor);
        let effective_memory_mb = (host_memory_mb as f64 * concurrency_factor).floor() as u32;
        Self {
            cpu_capacity,
            effective_memory_mb,
            max_concurrent,
            state: Mutex::new(BudgetState {
                running_vcpu: 0,
                running_memory_mb: 0,
                running_count: 0,
            }),
            availability: Notify::new(),
        }
    }

    /// Try to reserve resources for a job without creating a lease.
    ///
    /// If nothing is currently running, the first job is always admitted
    /// regardless of resource limits.
    fn try_reserve_inner(&self, vcpu: u32, memory_mb: u32) -> bool {
        let mut state = self.lock();

        if !self.can_admit_locked(&state, vcpu, memory_mb) {
            return false;
        }

        Self::reserve_locked(&mut state, vcpu, memory_mb);
        true
    }

    /// Try to reserve resources and return an owned lease on success.
    pub fn try_reserve_lease(budget: &Arc<Self>, vcpu: u32, memory_mb: u32) -> Option<BudgetLease> {
        if budget.try_reserve_inner(vcpu, memory_mb) {
            Some(BudgetLease::new(Arc::clone(budget), vcpu, memory_mb))
        } else {
            None
        }
    }

    /// Atomically substitute existing leases for one incoming reservation.
    ///
    /// The supplied leases remain intact when the virtual post-release state
    /// cannot admit the incoming shape. On success their reservations are
    /// consumed under the same lock that installs the incoming reservation,
    /// so concurrent admission cannot observe or steal intermediate capacity.
    pub fn try_substitute_leases(
        budget: &Arc<Self>,
        mut leases: Vec<BudgetLease>,
        vcpu: u32,
        memory_mb: u32,
    ) -> Result<BudgetLease, Vec<BudgetLease>> {
        assert!(
            leases.iter().all(|lease| {
                lease
                    .budget
                    .as_ref()
                    .is_some_and(|owner| Arc::ptr_eq(owner, budget))
            }),
            "substituted leases must belong to the target resource budget"
        );

        let mut state = budget.lock();
        let before = (
            state.running_vcpu,
            state.running_memory_mb,
            state.running_count,
        );
        let mut virtual_state = BudgetState {
            running_vcpu: state.running_vcpu,
            running_memory_mb: state.running_memory_mb,
            running_count: state.running_count,
        };
        for lease in &leases {
            assert!(
                virtual_state.running_vcpu >= lease.vcpu,
                "substituted vCPU exceeds resource budget allocation"
            );
            assert!(
                virtual_state.running_memory_mb >= lease.memory_mb,
                "substituted memory exceeds resource budget allocation"
            );
            assert!(
                virtual_state.running_count > 0,
                "substituted lease count exceeds resource budget allocation"
            );
            virtual_state.running_vcpu -= lease.vcpu;
            virtual_state.running_memory_mb -= lease.memory_mb;
            virtual_state.running_count -= 1;
        }

        if !budget.can_admit_locked(&virtual_state, vcpu, memory_mb) {
            return Err(leases);
        }

        *state = virtual_state;
        Self::reserve_locked(&mut state, vcpu, memory_mb);
        for lease in &mut leases {
            lease.budget = None;
        }
        let released_capacity = state.running_vcpu < before.0
            || state.running_memory_mb < before.1
            || state.running_count < before.2;
        drop(state);

        if released_capacity {
            budget.availability.notify_waiters();
        }

        Ok(BudgetLease::new(Arc::clone(budget), vcpu, memory_mb))
    }

    /// Wait until selected leases can be atomically substituted for one
    /// incoming reservation without losing a concurrent release notification.
    /// The leases remain in the caller-owned vector whenever this future is
    /// waiting, so cancelling the wait preserves normal lease-drop accounting.
    pub async fn substitute_leases_when_available(
        budget: &Arc<Self>,
        leases: &mut Vec<BudgetLease>,
        vcpu: u32,
        memory_mb: u32,
    ) -> BudgetLease {
        loop {
            let notified = budget.availability.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            match Self::try_substitute_leases(budget, std::mem::take(leases), vcpu, memory_mb) {
                Ok(lease) => return lease,
                Err(retained) => *leases = retained,
            }
            notified.await;
        }
    }

    /// Release resources after a job completes.
    #[cfg(test)]
    pub fn release(&self, vcpu: u32, memory_mb: u32) {
        self.release_reserved(vcpu, memory_mb)
            .expect("release underflow");
    }

    /// Check if there is potentially enough budget for a job with the given
    /// resources. Used as a gate in the main loop to avoid blocking on
    /// discovery when resources are exhausted.
    pub fn can_afford(&self, vcpu: u32, memory_mb: u32) -> bool {
        let state = self.lock();
        self.can_admit_locked(&state, vcpu, memory_mb)
    }

    fn can_admit_locked(&self, state: &BudgetState, vcpu: u32, memory_mb: u32) -> bool {
        if state.running_count == 0 {
            return true;
        }

        let Some(next_vcpu) = state.running_vcpu.checked_add(vcpu) else {
            return false;
        };
        let Some(next_memory_mb) = state.running_memory_mb.checked_add(memory_mb) else {
            return false;
        };

        let vcpu_ok = f64::from(next_vcpu) <= self.cpu_capacity.admission_limit;
        let mem_ok = next_memory_mb <= self.effective_memory_mb;
        let count_ok = self.max_concurrent == 0 || state.running_count < self.max_concurrent;
        vcpu_ok && mem_ok && count_ok
    }

    fn reserve_locked(state: &mut BudgetState, vcpu: u32, memory_mb: u32) {
        state.running_vcpu += vcpu;
        state.running_memory_mb += memory_mb;
        state.running_count += 1;
    }

    /// Returns the host CPU capacity reserved before applying the concurrency factor.
    pub fn host_cpu_admission_reservation(&self) -> f64 {
        self.cpu_capacity.host_reservation
    }

    /// Returns the host CPU capacity available for Guest admission before overcommit.
    pub fn guest_cpu_admission_capacity(&self) -> f64 {
        self.cpu_capacity.guest_capacity
    }

    /// Normalize the fixed host reservation and Guest capacity to cgroup v2 weights.
    ///
    /// `R(P) + C(P) = P`, so this maps the reviewed admission headroom ratio
    /// directly onto the kernel's full `1..=10000` weight range. The mapping
    /// intentionally excludes `concurrency_factor`: overcommit changes how many
    /// declared vCPUs may run, not the host-control share while they are runnable.
    pub fn host_cpu_cgroup_weights(&self) -> (u32, u32) {
        const TOTAL_WEIGHT: u32 = 10_000;

        let total_capacity = self.cpu_capacity.host_reservation + self.cpu_capacity.guest_capacity;
        let control_weight = (self.cpu_capacity.host_reservation / total_capacity
            * f64::from(TOTAL_WEIGHT))
        .round() as u32;
        let control_weight = control_weight.clamp(1, TOTAL_WEIGHT - 1);
        (control_weight, TOTAL_WEIGHT - control_weight)
    }

    /// Returns the fractional declared-vCPU admission limit after overcommit.
    pub fn vcpu_admission_limit(&self) -> f64 {
        self.cpu_capacity.admission_limit
    }

    /// Returns the final discrete declared-vCPU capacity used by integer consumers.
    pub fn effective_vcpu(&self) -> u32 {
        self.cpu_capacity.effective_vcpu()
    }

    /// Returns the memory admission budget, in MiB, after applying the concurrency factor.
    pub fn effective_memory_mb(&self) -> u32 {
        self.effective_memory_mb
    }

    /// Returns the configured concurrent job cap; `0` means no job-count cap.
    pub fn max_concurrent(&self) -> usize {
        self.max_concurrent
    }

    /// Returns the current allocated vCPU, memory, and lease count in one snapshot.
    pub fn allocated(&self) -> (u32, u32, usize) {
        let state = self.lock();
        (
            state.running_vcpu,
            state.running_memory_mb,
            state.running_count,
        )
    }

    /// Lock the budget state, recovering from poison if a thread panicked.
    fn lock(&self) -> MutexGuard<'_, BudgetState> {
        match self.state.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn release_reserved(&self, vcpu: u32, memory_mb: u32) -> Result<(), BudgetReleaseError> {
        let mut state = self.lock();
        if state.running_vcpu < vcpu {
            return Err(BudgetReleaseError::Vcpu {
                running: state.running_vcpu,
                release: vcpu,
            });
        }
        if state.running_memory_mb < memory_mb {
            return Err(BudgetReleaseError::Memory {
                running: state.running_memory_mb,
                release: memory_mb,
            });
        }
        if state.running_count == 0 {
            return Err(BudgetReleaseError::Count);
        }

        state.running_vcpu -= vcpu;
        state.running_memory_mb -= memory_mb;
        state.running_count -= 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
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
}
