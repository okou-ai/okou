//! Actual owned home creation retains full custody through cancelled observation.

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use runner_executor::pre_spawn_admission::PreSpawnAdmission;
use runner_lifecycle::host_memory_operations::HostMemoryOperations;
use runner_lifecycle::host_memory_pressure::HostPressureState;
use runner_lifecycle::lifecycle::RunnerMode;
use runner_supervisor::blank_pool::{BlankPoolReplenisher, BlankProfile, OptionalBlankPoolRequest};
use runner_supervisor::idle_pressure::{IdlePressureConfig, IdlePressureOwner};
use sandbox::{Sandbox, SandboxConfig, SandboxCreateCustody, SandboxCreateObserver};
use serde_json::{Value, json};

use super::*;

pub struct Probe {
    gate: foreground_io::Gate,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    owners: Option<(Arc<ResourceBudget>, HostMemoryOperations)>,
    created: Option<Value>,
    completed: Option<Value>,
}

struct ReleaseOnDrop<'a>(&'a foreground_io::Gate);

impl Drop for ReleaseOnDrop<'_> {
    fn drop(&mut self) {
        // An unwinding/cancelled test observer must also let accepted IO finish.
        // The normal refusal path below still reports release errors and joins.
        let _ = self.0.release();
    }
}

fn accounting(operations: &HostMemoryOperations) -> TestResult<Value> {
    let value = operations.snapshot()?;
    Ok(
        json!({"registered_operations": value.registered_operations, "started": value.started,
        "ordinary_growth_bytes": value.ordinary_growth_bytes, "cleanup_growth_bytes": value.cleanup_growth_bytes,
        "tracked_tasks": value.tracked_tasks, "uncertain": value.uncertain}),
    )
}

impl Probe {
    pub fn new() -> io::Result<Self> {
        Ok(Self {
            gate: foreground_io::Gate::new()?,
            state: Mutex::new(State::default()),
        })
    }

    pub fn checkpoint(self: &Arc<Self>) -> sandbox_firecracker::HomeCreateCheckpoint {
        let probe = self.clone();
        Arc::new(move |path| {
            let mut file = std::fs::File::open(path)?;
            let bytes = file.metadata()?.len();
            file.seek(SeekFrom::Start(1024))?;
            let mut block = [0; 1024];
            file.read_exact(&mut block)?;
            if bytes != fixture::IMAGE_BYTES || block[56..58] != [0x53, 0xef] {
                return Err(io::Error::other(
                    "actual created home lacks original size/ext4 bytes",
                ));
            }
            let mut state = probe
                .state
                .lock()
                .map_err(|_| io::Error::other("create probe poisoned"))?;
            if state.created.is_some() {
                return Err(io::Error::other("actual home checkpoint repeated"));
            }
            state.created = Some(json!({"home_path": path, "home_bytes": bytes,
                "ext4_magic": "53ef", "superblock_hex": hex::encode(block), "superblock_sha256": continuation::digest(&block),
                "held_ns": evidence::clocks()?.0}));
            drop(state);
            probe.gate.blocking_wait()
        })
    }

    fn evidence(&self, completed: bool) -> TestResult<Value> {
        let state = self
            .state
            .lock()
            .map_err(|_| io::Error::other("create probe poisoned"))?;
        let value = if completed {
            &state.completed
        } else {
            &state.created
        };
        value
            .clone()
            .ok_or_else(|| io::Error::other("actual create physical witness absent").into())
    }
}

struct Completion {
    probe: Arc<Probe>,
    workspace: PathBuf,
    // Drop observation happens before releasing the original physical owner.
    _custody: SandboxCreateCustody,
}

impl Drop for Completion {
    fn drop(&mut self) {
        let recorded = (|| -> TestResult<Value> {
            let state = self
                .probe
                .state
                .lock()
                .map_err(|_| io::Error::other("create probe poisoned"))?;
            let (budget, operations) = state
                .owners
                .as_ref()
                .ok_or_else(|| io::Error::other("create owners absent"))?;
            let absent = match std::fs::symlink_metadata(&self.workspace) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => true,
                Err(error) => return Err(error.into()),
                Ok(_) => false,
            };
            Ok(
                json!({"workspace": self.workspace, "workspace_absent": absent,
                "cleanup_ns": evidence::clocks()?.0, "allocated": budget.allocated(),
                "accounting": accounting(operations)?}),
            )
        })();
        if let Ok(mut state) = self.probe.state.lock() {
            state.completed = Some(match recorded {
                Ok(value) => value,
                Err(error) => json!({"error": error.to_string()}),
            });
        }
    }
}

pub struct Factory {
    pub inner: Box<dyn SandboxFactory>,
    pub probe: Arc<Probe>,
    pub directory: PathBuf,
}

#[async_trait]
impl SandboxFactory for Factory {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn config_hash(&self) -> String {
        self.inner.config_hash()
    }
    async fn create(&self, config: SandboxConfig) -> sandbox::Result<Box<dyn Sandbox>> {
        self.inner.create(config).await
    }
    async fn create_with_observer(
        &self,
        config: SandboxConfig,
        observer: &mut dyn SandboxCreateObserver,
    ) -> sandbox::Result<Box<dyn Sandbox>> {
        self.inner.create_with_observer(config, observer).await
    }
    async fn create_with_custody(
        &self,
        config: SandboxConfig,
        custody: SandboxCreateCustody,
    ) -> sandbox::Result<Box<dyn Sandbox>> {
        let workspace = sandbox_firecracker::FactoryPaths::new(self.directory.clone())
            .workspace(&config.id.to_string());
        self.inner
            .create_with_custody(
                config,
                SandboxCreateCustody::new(Arc::new(Completion {
                    probe: self.probe.clone(),
                    workspace,
                    _custody: custody,
                })),
            )
            .await
    }
    async fn destroy(&self, sandbox: Box<dyn Sandbox>) {
        self.inner.destroy(sandbox).await;
    }
    async fn shutdown(&mut self) {
        self.inner.shutdown().await;
    }
}

fn held(context: &transitions::Context, growth: u64) -> TestResult<Value> {
    let value = accounting(&context.operations)?;
    let tracked = value
        .get("tracked_tasks")
        .and_then(Value::as_u64)
        .ok_or_else(|| io::Error::other("actual create tracked owner count missing or invalid"))?;
    if context.budget.allocated() != (4, 8192, 2)
        || tracked == 0
        || value
            != json!({
        "registered_operations": 1, "started": 1, "ordinary_growth_bytes": growth,
        "cleanup_growth_bytes": 0, "tracked_tasks": tracked, "uncertain": 0})
    {
        return Err(io::Error::other(format!(
            "accepted create lost original full P2 custody: {value}"
        ))
        .into());
    }
    Ok(value)
}

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    source: &Arc<recovery_source::Source>,
    proof: Option<&Arc<evidence::Case>>,
    directory: &std::path::Path,
    probe: &Arc<Probe>,
) -> TestResult<()> {
    let _release_on_drop = ReleaseOnDrop(&probe.gate);
    let proof =
        proof.ok_or_else(|| io::Error::other("create cancellation needs measured owners"))?;
    let original = snapshot_inputs::original(&context.budget, inputs, proof).await?;
    probe
        .state
        .lock()
        .map_err(|_| io::Error::other("create probe poisoned"))?
        .owners = Some((context.budget.clone(), context.operations.clone()));
    let policy = inputs.pressure_policy()?;
    let admission = PreSpawnAdmission::new(2)?;
    let mut heartbeat = foreground_probe::Probe::new(
        &context.pool,
        &context.budget,
        directory,
        &context.rootfs_hash,
    )
    .await?;
    source.pause();
    let pressure = match IdlePressureOwner::spawn(IdlePressureConfig {
        pool: context.pool.clone(),
        status: context.status.clone(),
        tracker: context.tracker.clone(),
        operations: context.operations.clone(),
        policy,
        sample_period: inputs.pressure_sample_period(),
        envelope: inputs.envelope(),
    }) {
        Ok(owner) => owner,
        Err(error) => {
            source.resume();
            heartbeat.finish().await?;
            return Err(error.into());
        }
    };
    let control = pressure.optional_preparation();
    let profiles = BTreeMap::from([(
        fixture::PROFILE.into(),
        BlankProfile {
            vcpu: 2,
            memory_mb: 4096,
            rootfs_hash: context.rootfs_hash.clone(),
            home_disk_mb: fixture::HOME_DISK_MB,
        },
    )]);
    let factories = BTreeMap::from([(fixture::PROFILE.into(), (context.factory.clone(), true))]);
    let mut blank = BlankPoolReplenisher::new(&profiles, &factories, &context.budget, 2, None);
    let request = || OptionalBlankPoolRequest {
        mode: RunnerMode::Running,
        pool: &context.pool,
        budget: &context.budget,
        admission: &admission,
        status: &context.status,
        tracker: &context.tracker,
        pressure: &control,
        preparation_bytes: inputs.preparation_bytes(),
        envelope: inputs.envelope(),
    };
    let growth = 4096 * 1024 * 1024 + inputs.preparation_bytes();
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        source.wait_for_readers(1).await;
        proof.create_cancellation_witness("inputs_verified", json!({"policy": serde_json::to_value(inputs)?,
            "inputs_sha256": continuation::digest(&original.raw), "snapshot_sha256": proof.snapshot_memory_hash()?,
            "snapshot_bytes": original.bytes, "prefetch_overhead_bytes": original.overhead,
            "preparation_bytes": inputs.preparation_bytes(), "allocated": context.budget.allocated(),
            "checkpoint_models_stalled_storage": false}))?;
        let first_sample = source.samples()?.len();
        source.resume();
        let mut ticks = tokio::time::interval(control.policy().optional_start_interval);
        loop {
            if blank.maybe_start_optional(request())? { break; }
            ticks.tick().await;
        }
        probe.gate.wait_entered().await?;
        let decision = control.decision();
        if decision.state != HostPressureState::Ready || decision.wave_inflight {
            return Err(io::Error::other("actual accepted create lacks Ready pressure").into());
        }
        proof.require_full_lease()?;
        proof.create_cancellation_witness("create_accepted", json!({"created": probe.evidence(false)?,
            "state": "Ready", "available_bytes": decision.available_bytes,
            "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "accounting": held(&context, growth)?, "allocated": context.budget.allocated(), "release_byte_withheld": true}))?;
        blank.cancel_if_inactive(RunnerMode::Draining);
        let cancelled_ns = evidence::clocks()?.0;
        {
            let first = blank.wait_for_optional_preparation(); tokio::pin!(first);
            if futures_util::poll!(&mut first).is_ready() { return Err(io::Error::other("first create wait lost accepted IO").into()); }
        }
        let first_dropped_ns = evidence::clocks()?.0;
        let release_ns;
        let result;
        {
            let second = blank.wait_for_optional_preparation(); tokio::pin!(second);
            if futures_util::poll!(&mut second).is_ready() { return Err(io::Error::other("replacement create wait lost accepted IO").into()); }
            let second_pending_ns = evidence::clocks()?.0;
            let foreground = admission.acquire(2, &tokio_util::sync::CancellationToken::new()).await?;
            let foreground_acquired_ns = evidence::clocks()?.0;
            heartbeat.request()?; let acknowledged = heartbeat.complete().await?;
            let observed = foreground_probe::observe().await?;
            proof.require_full_lease()?;
            proof.create_cancellation_witness("cancel_wait", json!({"cancelled_ns": cancelled_ns,
                "first_dropped_ns": first_dropped_ns, "second_pending_ns": second_pending_ns,
                "foreground_acquired_ns": foreground_acquired_ns, "first_pending": true, "first_dropped": true,
                "second_pending": true, "release_byte_withheld": true, "allocated": context.budget.allocated(),
                "accounting": held(&context, growth)?, "heartbeat": acknowledged, "observer": observed}))?;
            drop(foreground);
            release_ns = evidence::clocks()?.0; probe.gate.release()?;
            result = second.await.ok_or_else(|| io::Error::other("create result owner absent"))?;
        }
        // The result channel precedes the original task's final tracking-token
        // drop. Observe that same owner's actual end before recording a join.
        // This condition shares the bounded outcome deadline; no elapsed delay
        // or extra physical-memory settlement is substituted for completion.
        while context.operations.snapshot()?.tracked_tasks != 0 {
            tokio::task::yield_now().await;
        }
        let joined_ns = evidence::clocks()?.0;
        let snapshot = result.snapshot();
        let complete = probe.evidence(true)?;
        if complete.get("workspace_absent").and_then(Value::as_bool) != Some(true)
            || complete.get("allocated") != Some(&json!([4,8192,2]))
            || !snapshot.finished || snapshot.prepared || snapshot.published || snapshot.retained_resource
            || snapshot.error.as_deref() != Some("creation cancelled/lost; joined physical rollback, Fresh remains uncertain")
            || context.budget.allocated() != (2,4096,1) {
            return Err(io::Error::other(format!("actual create rollback incomplete: {snapshot:?}; {complete}")).into());
        }
        proof.require_full_lease()?;
        proof.create_cancellation_witness("create_joined", json!({"completion": complete, "release_ns": release_ns,
            "joined_ns": joined_ns, "finished": snapshot.finished, "prepared": snapshot.prepared,
            "published": snapshot.published, "retained_resource": snapshot.retained_resource, "error": snapshot.error,
            "allocated": context.budget.allocated(), "accounting": accounting(&context.operations)?}))?;
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    }).await;
    let release = probe.gate.release();
    source.resume();
    let blank_stopped = blank.shutdown_optional(&context.tracker).await;
    let pressure_stopped = pressure.shutdown().await;
    let reporting = heartbeat.finish().await;
    release?;
    blank_stopped?;
    let stopped = pressure_stopped?;
    reporting?;
    outcome.map_err(io::Error::other)??;
    if stopped.producer_lost || !stopped.stopped || stopped.decision.wave_inflight {
        return Err(io::Error::other("create dependencies not joined").into());
    }
    let path = original.path;
    let expected = proof.snapshot_memory_hash()?.to_owned();
    tokio::task::spawn_blocking(move || evidence::verify_file(&path, &expected)).await??;
    proof.require_full_lease()?;
    proof.create_cancellation_witness("producers_joined", json!({"blank_shutdown_joined": true, "pressure_stopped": true,
        "heartbeat_joined": true, "provider_joined": true, "peer_joined": true, "snapshot_reverified": true,
        "allocated": context.budget.allocated(), "accounting": accounting(&context.operations)?}))?;
    let mut batch = context
        .tracker
        .start_pool_retirement_batch(
            context.pool,
            context.status,
            context.operations,
            IdlePoolBatchRetirementRequest {
                scope: IdleRetirementBatchScope::All,
                envelope: inputs.envelope(),
                context: "native_create_cancellation_required_saving",
            },
        )
        .await?;
    let completed = batch.join().await?;
    if !completed.is_complete() || completed.selected != 1 || completed.completed != 1 {
        return Err(io::Error::other("create cancellation original saving incomplete").into());
    }
    Ok(())
}
