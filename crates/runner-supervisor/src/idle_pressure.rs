//! Independent own-Runner physical-pressure execution with supplied policy.
//!
//! This component is not installed by the production root. Its caller supplies
//! the same P2 authority and idle owners, and joins it before their dependencies.

use std::sync::Arc;
use std::time::Duration;

use runner_host::host_memory::{HostMemoryObservation, HostMemoryUnknown};
use runner_lifecycle::host_memory_operations::{HostMemoryOperations, MemoryOperationError};
use runner_lifecycle::host_memory_pressure::{
    HostMemoryPressure, HostPressureDecision, HostPressurePolicy, HostPressurePolicyError,
    HostPressureWave,
};
use runner_lifecycle::idle_pool::IdleRetirementEnvelope;
use runner_lifecycle::status::StatusTracker;
use tokio::sync::{Notify, oneshot, watch};
use tokio::task::{JoinError, JoinHandle};
use tokio::time::MissedTickBehavior;
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::idle_lifecycle::pressure::IdlePressureWaveRequest;
use crate::idle_lifecycle::{
    IdleCleanupTask, IdleDestroyTracker, IdlePressureWaveReport, SharedIdlePool,
};

/// All values are explicit measured/supplied component inputs, not public knobs
/// or defaults. Scheduling and physical admission must use the same policy.
pub struct IdlePressureConfig {
    pub pool: SharedIdlePool,
    pub status: Arc<StatusTracker>,
    pub tracker: IdleDestroyTracker,
    pub operations: HostMemoryOperations,
    pub policy: HostPressurePolicy,
    pub sample_period: Duration,
    pub envelope: IdleRetirementEnvelope,
}

#[derive(Clone, Debug)]
pub struct IdlePressureSnapshot {
    pub decision: HostPressureDecision,
    /// Latest nonempty original cohort; an empty scan cannot erase real outcomes.
    pub last_wave: Option<Arc<IdlePressureWaveReport>>,
    pub producer_lost: bool,
    /// The controller stopped offering work. Full owner/read joins require
    /// shutdown; this flag cannot establish physical completion or relief.
    pub stopped: bool,
}

/// Dropping this handle requests stop, never aborts accepted work. The detached
/// owners keep their dependencies/custody, but only shutdown supplies join proof.
pub struct IdlePressureOwner {
    cancel: CancellationToken,
    _stop_on_drop: DropGuard,
    latest: watch::Receiver<IdlePressureSnapshot>,
    controller: JoinHandle<IdlePressureSnapshot>,
    sampler: JoinHandle<()>,
}

impl IdlePressureOwner {
    pub fn spawn(config: IdlePressureConfig) -> Result<Self, MemoryOperationError> {
        let runtime =
            tokio::runtime::Handle::try_current().map_err(|_| MemoryOperationError::NoRuntime)?;
        let admission = config.operations.policy();
        if config.sample_period.is_zero()
            || config.policy.bounds != admission.bounds
            || config.policy.max_sample_age != admission.max_sample_age
            || admission.max_cleanup_inflight < 2
        {
            return Err(MemoryOperationError::InvalidLimits);
        }
        if config.envelope.live_growth_bytes == 0 || config.envelope.tail_growth_bytes == 0 {
            return Err(MemoryOperationError::UnsupportedGrowth);
        }
        let mut pressure = HostMemoryPressure::new(config.policy).map_err(|error| match error {
            HostPressurePolicyError::Bounds(error) => MemoryOperationError::Bounds(error),
            HostPressurePolicyError::ZeroInterval => MemoryOperationError::InvalidLimits,
        })?;
        let (state, latest) = watch::channel(IdlePressureSnapshot {
            decision: pressure.decision(),
            last_wave: None,
            producer_lost: false,
            stopped: false,
        });
        let (samples, observations) = watch::channel(HostMemoryObservation::unknown(
            HostMemoryUnknown::NotObserved,
        ));
        let cancel = CancellationToken::new();
        let refresh = Arc::new(Notify::new());
        let sampler = runtime.spawn(sample(
            config.operations.clone(),
            config.sample_period,
            samples,
            refresh.clone(),
            cancel.clone(),
        ));
        let controller = runtime.spawn(control(
            config,
            pressure,
            observations,
            state,
            refresh,
            cancel.clone(),
        ));
        Ok(Self {
            _stop_on_drop: cancel.clone().drop_guard(),
            cancel,
            latest,
            controller,
            sampler,
        })
    }

    pub fn subscribe(&self) -> watch::Receiver<IdlePressureSnapshot> {
        self.latest.clone()
    }

    pub fn stop(&self) {
        self.cancel.cancel();
    }

    /// Stop further waves and positively join sampling and all accepted work.
    /// Uncertain results remain explicit; this does not close shared P2/tracker
    /// owners or convert scheduling completion into physical memory credit.
    pub async fn shutdown(self) -> Result<IdlePressureSnapshot, JoinError> {
        self.cancel.cancel();
        let controller = self.controller.await;
        let sampler = self.sampler.await;
        sampler?;
        controller
    }
}

async fn sample(
    operations: HostMemoryOperations,
    period: Duration,
    latest: watch::Sender<HostMemoryObservation>,
    refresh: Arc<Notify>,
    cancel: CancellationToken,
) {
    let mut ticks = tokio::time::interval(period);
    ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => break,
            () = refresh.notified() => {},
            _ = ticks.tick() => {},
        }
        // One accepted read at a time. Stop joins it instead of treating a
        // cancelled waiter as completion of real reader I/O.
        let observation = operations.observe_pressure().await;
        if cancel.is_cancelled() {
            break;
        }
        latest.send_replace(observation);
    }
    latest.send_replace(HostMemoryObservation::unknown(
        HostMemoryUnknown::ObserverStopped,
    ));
}

async fn join_wave(
    task: &mut Option<IdleCleanupTask<IdlePressureWaveReport>>,
) -> Result<IdlePressureWaveReport, oneshot::error::RecvError> {
    match task {
        Some(task) => task.join().await,
        None => std::future::pending().await,
    }
}

fn finish_wave(
    result: Result<IdlePressureWaveReport, oneshot::error::RecvError>,
    pressure: &mut HostMemoryPressure,
    token: &mut Option<HostPressureWave>,
    snapshot: &mut IdlePressureSnapshot,
    refresh: &Notify,
) {
    match result {
        Ok(report) => {
            if report.is_resolved()
                && let Some(wave) = token.take()
                && let Err(wave) = pressure.complete_wave(wave)
            {
                *token = Some(wave);
                snapshot.producer_lost = true;
            }
            if report.selected > 0 {
                snapshot.last_wave = Some(Arc::new(report));
            }
        }
        Err(_) => snapshot.producer_lost = true,
    }
    // A fresh read starts after the observed outcomes. An already in-flight
    // read retains its original timestamp and cannot satisfy the P3a fence.
    refresh.notify_one();
}

async fn control(
    config: IdlePressureConfig,
    mut pressure: HostMemoryPressure,
    mut observations: watch::Receiver<HostMemoryObservation>,
    latest: watch::Sender<IdlePressureSnapshot>,
    refresh: Arc<Notify>,
    cancel: CancellationToken,
) -> IdlePressureSnapshot {
    let mut snapshot = latest.borrow().clone();
    let mut ticks = tokio::time::interval(config.sample_period);
    ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut token = None;
    let mut wave = None;
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => break,
            result = join_wave(&mut wave) => {
                wave = None;
                finish_wave(result, &mut pressure, &mut token, &mut snapshot, &refresh);
            }
            changed = observations.changed(), if !snapshot.producer_lost => {
                let observation = if changed.is_ok() {
                    observations.borrow_and_update().clone()
                } else {
                    snapshot.producer_lost = true;
                    HostMemoryObservation::unknown(HostMemoryUnknown::ObserverStopped)
                };
                pressure.observe(observation);
            }
            _ = ticks.tick() => {},
        }
        snapshot.decision = pressure.decision();
        if !snapshot.producer_lost
            && wave.is_none()
            && let Some(offer) = pressure.try_begin_wave()
        {
            token = Some(offer);
            match config.tracker.start_pressure_wave(IdlePressureWaveRequest {
                pool: config.pool.clone(),
                status: config.status.clone(),
                operations: config.operations.clone(),
                policy: config.policy,
                envelope: config.envelope,
                cancel: cancel.clone(),
            }) {
                Ok(task) => wave = Some(task),
                Err(_) => snapshot.producer_lost = true,
            }
        }
        snapshot.decision = pressure.decision();
        latest.send_replace(snapshot.clone());
    }
    if wave.is_some() {
        let result = join_wave(&mut wave).await;
        finish_wave(result, &mut pressure, &mut token, &mut snapshot, &refresh);
    }
    pressure.observe(HostMemoryObservation::unknown(
        HostMemoryUnknown::ObserverStopped,
    ));
    snapshot.decision = pressure.decision();
    snapshot.stopped = true;
    latest.send_replace(snapshot.clone());
    snapshot
}
