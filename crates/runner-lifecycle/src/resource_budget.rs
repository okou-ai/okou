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
    #[cfg(any(test, feature = "test-support"))]
    lifetime: Option<Arc<()>>,
}

/// Non-owning test observation of one reservation, including a same-shape
/// one-for-one atomic substitution. It cannot keep budget resources reserved.
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone)]
pub struct BudgetLeaseWitness {
    lifetime: std::sync::Weak<()>,
    vcpu: u32,
    memory_mb: u32,
}

#[cfg(any(test, feature = "test-support"))]
impl BudgetLeaseWitness {
    pub fn is_active(&self) -> bool {
        self.lifetime.strong_count() > 0
    }

    pub fn resources(&self) -> (u32, u32) {
        (self.vcpu, self.memory_mb)
    }
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReservationWithHeadroomStatus {
    ResourceUnavailable,
    HeadroomReserved,
    Available,
}

impl BudgetLease {
    fn new(budget: Arc<ResourceBudget>, vcpu: u32, memory_mb: u32) -> Self {
        Self {
            budget: Some(budget),
            vcpu,
            memory_mb,
            #[cfg(any(test, feature = "test-support"))]
            lifetime: Some(Arc::new(())),
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn witness(&self) -> Option<BudgetLeaseWitness> {
        self.budget.as_ref()?;
        Some(BudgetLeaseWitness {
            lifetime: Arc::downgrade(self.lifetime.as_ref()?),
            vcpu: self.vcpu,
            memory_mb: self.memory_mb,
        })
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
        let mut state = budget.lock();
        let before = (
            state.running_vcpu,
            state.running_memory_mb,
            state.running_count,
        );
        let virtual_state = budget.state_after_releasing(&state, &leases);

        if !budget.can_admit_locked(&virtual_state, vcpu, memory_mb) {
            return Err(leases);
        }

        *state = virtual_state;
        Self::reserve_locked(&mut state, vcpu, memory_mb);
        #[cfg(any(test, feature = "test-support"))]
        let inherited_witness = if leases.len() == 1
            && leases
                .first()
                .is_some_and(|lease| lease.vcpu == vcpu && lease.memory_mb == memory_mb)
        {
            leases.first_mut().and_then(|lease| lease.lifetime.take())
        } else {
            None
        };
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

        let incoming = BudgetLease::new(Arc::clone(budget), vcpu, memory_mb);
        #[cfg(any(test, feature = "test-support"))]
        let incoming = {
            let mut incoming = incoming;
            if let Some(witness) = inherited_witness {
                incoming.lifetime = Some(witness);
            }
            incoming
        };
        Ok(incoming)
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
    #[cfg(any(test, feature = "test-support"))]
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

    /// Observe potential admission after releasing the supplied distinct owned leases.
    /// This neither releases resources nor reserves the incoming shape; callers
    /// must still reclaim and atomically reserve before claiming work.
    pub(crate) fn can_afford_after_releasing<'a>(
        &self,
        vcpu: u32,
        memory_mb: u32,
        leases: impl IntoIterator<Item = &'a BudgetLease>,
    ) -> bool {
        let state = self.lock();
        let remaining = self.state_after_releasing(&state, leases);
        self.can_admit_locked(&remaining, vcpu, memory_mb)
    }

    fn state_after_releasing<'a>(
        &self,
        state: &BudgetState,
        leases: impl IntoIterator<Item = &'a BudgetLease>,
    ) -> BudgetState {
        let mut remaining = BudgetState {
            running_vcpu: state.running_vcpu,
            running_memory_mb: state.running_memory_mb,
            running_count: state.running_count,
        };
        for lease in leases {
            assert!(
                lease
                    .budget
                    .as_ref()
                    .is_some_and(|owner| std::ptr::eq(owner.as_ref(), self)),
                "substituted leases must belong to the target resource budget"
            );
            assert!(
                remaining.running_vcpu >= lease.vcpu,
                "substituted vCPU exceeds resource budget allocation"
            );
            remaining.running_vcpu -= lease.vcpu;
            assert!(
                remaining.running_memory_mb >= lease.memory_mb,
                "substituted memory exceeds resource budget allocation"
            );
            remaining.running_memory_mb -= lease.memory_mb;
            assert!(
                remaining.running_count > 0,
                "substituted lease count exceeds resource budget allocation"
            );
            remaining.running_count -= 1;
        }
        remaining
    }

    /// Observe whether one reservation and its required remaining headroom fit
    /// the same current allocation snapshot without mutating the budget.
    pub fn observe_reservation_with_headroom(
        &self,
        vcpu: u32,
        memory_mb: u32,
        headroom_vcpu: u32,
        headroom_memory_mb: u32,
    ) -> (ReservationWithHeadroomStatus, (u32, u32, usize)) {
        let state = self.lock();
        let allocated = (
            state.running_vcpu,
            state.running_memory_mb,
            state.running_count,
        );
        if !self.can_admit_locked(&state, vcpu, memory_mb) {
            return (
                ReservationWithHeadroomStatus::ResourceUnavailable,
                allocated,
            );
        }

        let mut after_reservation = BudgetState {
            running_vcpu: state.running_vcpu,
            running_memory_mb: state.running_memory_mb,
            running_count: state.running_count,
        };
        Self::reserve_locked(&mut after_reservation, vcpu, memory_mb);
        let status = if self.can_admit_locked(&after_reservation, headroom_vcpu, headroom_memory_mb)
        {
            ReservationWithHeadroomStatus::Available
        } else {
            ReservationWithHeadroomStatus::HeadroomReserved
        };
        (status, allocated)
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
mod tests;
