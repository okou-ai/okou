//! Exercise the complete optional entry with real observations and home bytes.

use std::collections::BTreeMap;
use std::num::NonZeroUsize;
use std::time::Instant;

use runner_executor::pre_spawn_admission::PreSpawnAdmission;
use runner_lifecycle::host_memory_pressure::{
    HostPressureCoordinator, HostPressurePolicy, HostPressureState, OptionalPressureControl,
};
use runner_lifecycle::lifecycle::RunnerMode;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::blank_pool::{
    BlankPoolReplenisher, BlankProfile, OptionalBlankPoolRequest, OptionalBlankResult,
};

mod ownership;
mod physical_io;
mod preparation;

struct Owner {
    fixture: BatchFixture,
    driver: HostPressureCoordinator,
    control: OptionalPressureControl,
    replenisher: BlankPoolReplenisher,
    admission: PreSpawnAdmission,
    overrides: Arc<MockSandboxOverrides>,
    exit: Option<MockBackingProcessCompletion>,
}

fn pressure_policy(operations: &HostMemoryOperations) -> HostPressurePolicy {
    HostPressurePolicy {
        bounds: operations.policy().bounds,
        max_sample_age: operations.policy().max_sample_age,
        recovery_sustain: Duration::from_nanos(1),
        wave_cooldown: Duration::from_millis(20),
        optional_start_interval: Duration::from_millis(20),
        max_wave_entries: NonZeroUsize::MIN,
    }
}

fn envelope() -> IdleRetirementEnvelope {
    IdleRetirementEnvelope {
        live_growth_bytes: 8 * MIB,
        tail_growth_bytes: MIB,
    }
}

fn request<'a>(
    fixture: &'a BatchFixture,
    admission: &'a PreSpawnAdmission,
    control: &'a OptionalPressureControl,
) -> OptionalBlankPoolRequest<'a> {
    OptionalBlankPoolRequest {
        mode: RunnerMode::Running,
        pool: &fixture.pool,
        budget: &fixture.budget,
        admission,
        status: &fixture.status,
        tracker: &fixture.tracker,
        pressure: control,
        preparation_bytes: MIB,
        envelope: envelope(),
    }
}

impl Owner {
    async fn new() -> Self {
        let mut fixture = BatchFixture::new().await;
        fixture.budget = Arc::new(ResourceBudget::new(16, 16384, 1.0, 0));
        fixture.pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
            max_idle: 1,
        })));
        fixture.operations = HostMemoryOperations::new(
            MemoryOperationPolicy {
                bounds: HostMemoryBounds {
                    host_total_bytes: 32768 * MIB,
                    operating_floor_bytes: 16 * MIB,
                    cleanup_reserve_bytes: 16 * MIB,
                    critical_available_bytes: 8192 * MIB,
                    recovery_available_bytes: 16384 * MIB,
                },
                ..policy()
            },
            Arc::new(FileSource(fixture.meminfo.clone())),
        )
        .unwrap();
        let driver = HostPressureCoordinator::new(
            pressure_policy(&fixture.operations),
            fixture.operations.clone(),
        )
        .unwrap();
        let control = driver.optional_control();
        let overrides = Arc::new(MockSandboxOverrides::new());
        let (exit, backing) = MockBackingProcess::channel();
        let factory = MockSandboxFactory::with_overrides(overrides.clone());
        factory.push_create_backing(backing);
        let factory: crate::SharedFactory = Arc::new(Box::new(factory));
        let profiles = BTreeMap::from([(
            "vm0/default".into(),
            BlankProfile {
                vcpu: 2,
                memory_mb: 2048,
                rootfs_hash: "test-rootfs".into(),
                home_disk_mb: 32,
            },
        )]);
        let factories = BTreeMap::from([("vm0/default".into(), (factory, true))]);
        let replenisher =
            BlankPoolReplenisher::new(&profiles, &factories, &fixture.budget, 1, None);
        let mut owner = Self {
            fixture,
            driver,
            control,
            replenisher,
            admission: PreSpawnAdmission::new(2).unwrap(),
            overrides,
            exit: Some(exit),
        };
        owner.observe(32768).await;
        owner.observe(32768).await;
        assert_eq!(owner.control.decision().state, HostPressureState::Ready);
        owner
    }

    async fn observe(&mut self, mib: u64) {
        let next = self.fixture.meminfo.with_extension("next");
        tokio::fs::write(&next, format!("MemAvailable: {} kB\n", mib * 1024))
            .await
            .unwrap();
        tokio::fs::rename(next, &self.fixture.meminfo)
            .await
            .unwrap();
        self.driver
            .observe(HostMemoryObservation::read_at(&self.fixture.meminfo).await);
    }

    fn start(&mut self) -> bool {
        self.replenisher
            .maybe_start_optional(request(&self.fixture, &self.admission, &self.control))
            .unwrap()
    }

    async fn ready(&self) -> OptionalBlankResult {
        tokio::time::timeout(WAIT, self.replenisher.wait_for_optional_preparation())
            .await
            .unwrap()
            .unwrap()
    }

    async fn publish(&mut self, result: &OptionalBlankResult) -> Result<(), MemoryOperationError> {
        self.replenisher
            .finish_optional_preparation(
                result,
                request(&self.fixture, &self.admission, &self.control),
            )
            .await
    }

    fn confirm_exit(&mut self) {
        self.exit.take().unwrap().confirm_exit();
    }

    async fn dispose(&mut self) {
        if self.exit.is_some() {
            self.confirm_exit();
        }
        self.replenisher
            .shutdown_optional(&self.fixture.tracker)
            .await
            .unwrap();
        let report = join(&mut self.fixture.start(IdleRetirementBatchScope::All).await).await;
        assert!(report.is_complete(), "{report:?}");
        self.fixture.tracker.close_and_wait().await;
        assert_eq!(self.fixture.budget.allocated(), (0, 0, 0));
    }
}
