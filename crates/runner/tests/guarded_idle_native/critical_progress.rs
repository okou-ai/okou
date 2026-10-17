//! Supplemental actual progress around the original independent Critical waves.

use runner_lifecycle::host_memory_pressure::{HostPressureState, OptionalPressureControl};
use runner_lifecycle::prefetch::{
    GuardedPrefetchSnapshot, MemoryPrefetchCandidate, MemoryPrefetchTasks,
};
use runner_lifecycle::status::StatusTracker;
use sandbox::SandboxBackingProcess;
use serde_json::{Value, json};
use tokio::sync::{OwnedMutexGuard, oneshot, watch};

use super::*;

pub struct Request<'a> {
    pub directory: &'a std::path::Path,
    pub backing: Arc<dyn SandboxBackingProcess>,
    pub original: RunId,
}

struct StatusHold {
    release: oneshot::Sender<()>,
    work: tokio::task::JoinHandle<TestResult<()>>,
}

impl StatusHold {
    async fn new(status: Arc<StatusTracker>) -> TestResult<Self> {
        let (entered, waiting) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let work = tokio::spawn(async move {
            let held = status.hold_state_for_test().await;
            entered
                .send(())
                .map_err(|_| io::Error::other("Critical status holder lost"))?;
            let _ = released.await;
            drop(held);
            Ok(())
        });
        if let Err(error) = waiting.await {
            let _ = work.await;
            return Err(error.into());
        }
        Ok(Self { release, work })
    }

    async fn finish(self) -> TestResult<()> {
        let _ = self.release.send(());
        self.work.await?
    }
}

pub struct Progress {
    context: transitions::Context,
    inputs: fixture::Inputs,
    source: Arc<recovery_source::Source>,
    proof: Arc<evidence::Case>,
    original: startup::Original,
    backing: Arc<dyn SandboxBackingProcess>,
    run: RunId,
    probe: Option<foreground_probe::Probe>,
    gate: Arc<foreground_io::Gate>,
    pool: Option<OwnedMutexGuard<IdlePool>>,
    status: Option<StatusHold>,
    pool_held: u64,
    status_held: u64,
    pool_waits: watch::Receiver<u64>,
    status_waits: watch::Receiver<u64>,
    pool_before: u64,
    status_before: u64,
    startup: Option<MemoryPrefetchTasks>,
    foreground: Option<tokio::task::JoinHandle<TestResult<foreground_growth::Completion>>>,
    first_sample: usize,
}

impl Progress {
    pub async fn new(
        context: &transitions::Context,
        inputs: &fixture::Inputs,
        source: &Arc<recovery_source::Source>,
        proof: &Arc<evidence::Case>,
        original: startup::Original,
        request: Request<'_>,
    ) -> TestResult<Self> {
        let gate = Arc::new(foreground_io::Gate::new()?);
        proof.install_foreground_io(gate.clone())?;
        let first_sample = source.samples()?.len();
        let pool = context.pool.clone().lock_owned().await;
        let pool_held = evidence::clocks()?.0;
        let status = StatusHold::new(context.status.clone()).await?;
        let status_held = match evidence::clocks() {
            Ok(clocks) => clocks.0,
            Err(error) => {
                status.finish().await?;
                return Err(error.into());
            }
        };
        // Start reporting only after fallible gate/sample/clock setup. A later
        // setup refusal must still positively join the accepted status holder.
        let probe = match foreground_probe::Probe::new(
            &context.pool,
            &context.budget,
            request.directory,
            &context.rootfs_hash,
        )
        .await
        {
            Ok(probe) => probe,
            Err(error) => {
                status.finish().await?;
                return Err(error);
            }
        };
        let mut pool_waits = context.tracker.pressure_pool_waits_for_test();
        let mut status_waits = context.status.idle_snapshot_waits_for_test();
        let pool_before = *pool_waits.borrow_and_update();
        let status_before = *status_waits.borrow_and_update();
        Ok(Self {
            context: context.clone(),
            inputs: inputs.clone(),
            source: source.clone(),
            proof: proof.clone(),
            original,
            backing: request.backing,
            run: request.original,
            probe: Some(probe),
            gate,
            pool: Some(pool),
            status: Some(status),
            pool_held,
            status_held,
            pool_waits,
            status_waits,
            pool_before,
            status_before,
            startup: None,
            foreground: None,
            first_sample,
        })
    }

    fn record(&self, phase: &str, value: Value) -> TestResult<()> {
        self.proof.critical_progress_witness(phase, value)?;
        Ok(())
    }

    fn critical(&self, control: &OptionalPressureControl) -> TestResult<Value> {
        let decision = control.decision();
        if decision.state != HostPressureState::Critical {
            return Err(io::Error::other("Critical progress lost actual Critical").into());
        }
        Ok(
            json!({"state": "Critical", "available_bytes": decision.available_bytes,
            "samples": self.source.samples()?.into_iter().skip(self.first_sample).collect::<Vec<_>>()}),
        )
    }

    async fn reporting(&mut self) -> TestResult<Value> {
        let probe = self
            .probe
            .as_mut()
            .ok_or_else(|| io::Error::other("Critical reporting owner missing"))?;
        probe.request()?;
        let heartbeat = probe.complete().await?;
        Ok(json!({"heartbeat": heartbeat, "observer": foreground_probe::observe().await?}))
    }

    pub async fn unknown(&mut self, reads: &GuardedPrefetchSnapshot) -> TestResult<()> {
        let owner = self.startup.insert(MemoryPrefetchTasks::spawn(
            [MemoryPrefetchCandidate {
                path: self.original.path.clone(),
                memory_mb: 4096,
            }],
            4096,
        ));
        owner.drain().await;
        let startup = owner.startup_snapshot()?;
        startup::completed(&startup, self.original.bytes)?;
        critical::no_reads(reads, false)?;
        self.proof.require_full_lease()?;
        self.record("startup_unknown", json!({
            "startup": startup::read_evidence(&startup), "startup_drained": true, "reads": critical::read_evidence(reads),
            "state": "Unknown", "startup_pressure_guarded": false, "pool_held_ns": self.pool_held,
            "status_held_ns": self.status_held, "allocated": self.context.budget.allocated(),
        }))
    }

    pub async fn pressure_waits(
        &mut self,
        control: &OptionalPressureControl,
        reads: &GuardedPrefetchSnapshot,
    ) -> TestResult<()> {
        while *self.pool_waits.borrow_and_update() == self.pool_before {
            self.pool_waits.changed().await?;
        }
        let observed = evidence::clocks()?.0;
        if *self.pool_waits.borrow() != self.pool_before + 1 {
            return Err(io::Error::other("Critical actual pool Pending count changed").into());
        }
        self.proof.require_full_lease()?;
        let observer = foreground_probe::observe().await?;
        self.record("pressure_pool_wait_progress", json!({
            "pressure": self.critical(control)?, "reads": critical::read_evidence(reads),
            "pool_held_ns": self.pool_held, "pending_observed_ns": observed,
            "waits_before": self.pool_before, "waits_after": *self.pool_waits.borrow(),
            "actual_pressure_pool_pending": true, "observer": observer, "allocated": self.context.budget.allocated(),
        }))?;
        drop(self.pool.take());
        let released = evidence::clocks()?.0;
        while *self.status_waits.borrow_and_update() == self.status_before {
            self.status_waits.changed().await?;
        }
        let observed = evidence::clocks()?.0;
        if *self.status_waits.borrow() != self.status_before + 1
            || self.context.budget.allocated() != (4, 8192, 2)
        {
            return Err(
                io::Error::other("Critical first cleanup/status Pending custody changed").into(),
            );
        }
        self.proof.require_full_lease()?;
        let reporting = self.reporting().await?;
        self.record("pressure_status_wait_progress", json!({
            "pressure": self.critical(control)?, "reads": critical::read_evidence(reads),
            "status_held_ns": self.status_held, "pool_released_ns": released, "pending_observed_ns": observed,
            "waits_before": self.status_before, "waits_after": *self.status_waits.borrow(),
            "actual_pressure_status_pending": true, "first_blank_cleanup_completed": true,
            "reporting": reporting, "allocated": self.context.budget.allocated(),
        }))?;
        if let Some(held) = self.status.take() {
            held.finish().await?;
        }
        Ok(())
    }

    pub async fn original_io(
        &mut self,
        control: &OptionalPressureControl,
        reads: &GuardedPrefetchSnapshot,
    ) -> TestResult<()> {
        self.gate.wait_entered().await?;
        self.proof.require_full_lease()?;
        self.pool = Some(self.context.pool.clone().lock_owned().await);
        let pool_held = evidence::clocks()?.0;
        self.status = Some(StatusHold::new(self.context.status.clone()).await?);
        let status_held = evidence::clocks()?.0;
        let (pool_wait, pool_entered) = oneshot::channel();
        let (status_wait, status_entered) = oneshot::channel();
        let request = foreground_growth::Request {
            context: self.context.clone(),
            plan: self.inputs.replacement_plan()?,
            preparation_bytes: self.inputs.preparation_bytes(),
            envelope: self.inputs.envelope(),
            proof: self.proof.clone(),
            backing: self.backing.clone(),
            original: self.run,
            fresh: true,
            pool_wait,
            status_wait,
        };
        self.foreground = Some(tokio::spawn(foreground_growth::prepare(request)));
        pool_entered.await?;
        let observed = evidence::clocks()?.0;
        let observer = foreground_probe::observe().await?;
        self.proof.require_full_lease()?;
        self.record("foreground_pool_wait_progress", json!({
            "pressure": self.critical(control)?, "reads": critical::read_evidence(reads),
            "pool_held_ns": pool_held, "status_held_ns": status_held, "pending_observed_ns": observed,
            "actual_foreground_pool_pending": true, "original_kernel_io_blocked": true,
            "observer": observer, "allocated": self.context.budget.allocated(),
        }))?;
        drop(self.pool.take());
        let released = evidence::clocks()?.0;
        status_entered.await?;
        let observed = evidence::clocks()?.0;
        let reporting = self.reporting().await?;
        self.proof.require_full_lease()?;
        self.record("foreground_status_wait_progress", json!({
            "pressure": self.critical(control)?, "reads": critical::read_evidence(reads),
            "status_held_ns": status_held, "pool_released_ns": released, "pending_observed_ns": observed,
            "actual_foreground_status_pending": true, "original_kernel_io_blocked": true,
            "reporting": reporting, "allocated": self.context.budget.allocated(),
        }))?;
        if let Some(held) = self.status.take() {
            held.finish().await?;
        }
        let work = self
            .foreground
            .as_mut()
            .ok_or_else(|| io::Error::other("Critical foreground owner missing"))?;
        let completed = work.await;
        self.foreground.take();
        let completed = completed??;
        if !completed.backing_exit_confirmed
            || completed.backing_generation == self.backing.identity().generation().to_string()
            || self.context.budget.allocated() != (2, 4096, 1)
        {
            return Err(io::Error::other(
                "Critical foreground physical completion/custody missing",
            )
            .into());
        }
        self.proof.require_full_lease()?;
        let reporting = self.reporting().await?;
        self.proof.require_full_lease()?;
        self.record("foreground_io_wait_progress", json!({
            "pressure": self.critical(control)?, "reads": critical::read_evidence(reads),
            "foreground": completed, "foreground_joined": true, "guest_rpc_completed": true, "phase_settled": true,
            "original_kernel_io_blocked": true, "release_byte_withheld": true, "original_full_lease": [2,4096,1],
            "reporting": reporting, "allocated": self.context.budget.allocated(),
        }))?;
        self.gate.release()?;
        Ok(())
    }

    pub async fn cleanup(&mut self) -> TestResult<()> {
        drop(self.pool.take());
        let released = self.gate.release();
        self.source.resume();
        let status = match self.status.take() {
            Some(held) => held.finish().await,
            None => Ok(()),
        };
        let foreground = match self.foreground.take() {
            Some(work) => work
                .await
                .map_err(|e| Box::new(e) as Box<dyn Error + Send + Sync>)
                .and_then(|v| v)
                .map(|_| ()),
            None => Ok(()),
        };
        if let Some(startup) = &mut self.startup {
            startup.cancel();
            startup.drain().await;
        }
        let reporting = match self.probe.take() {
            Some(probe) => probe.finish().await,
            None => Ok(()),
        };
        released?;
        status?;
        foreground?;
        reporting
    }

    pub fn joined(&self, reads: &GuardedPrefetchSnapshot) -> TestResult<()> {
        let startup = self
            .startup
            .as_ref()
            .ok_or_else(|| io::Error::other("Critical startup owner missing"))?
            .startup_snapshot()?;
        startup::completed(&startup, self.original.bytes)?;
        critical::no_reads(reads, true)?;
        self.record("producers_joined", json!({
            "startup": startup::read_evidence(&startup), "reads": critical::read_evidence(reads),
            "startup_drained": true, "runtime_drained": true, "foreground_joined": true,
            "heartbeat_joined": true, "provider_joined": true, "peer_joined": true,
            "pressure_stopped": true, "snapshot_reverified": true, "allocated": self.context.budget.allocated(),
        }))
    }
}
