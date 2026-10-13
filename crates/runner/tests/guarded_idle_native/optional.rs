//! Compiled complete optional owners; execution requires supplied native inputs.

use std::collections::BTreeMap;
use std::time::Duration;

use runner_executor::pre_spawn_admission::PreSpawnAdmission;
use runner_lifecycle::lifecycle::RunnerMode;
use runner_lifecycle::prefetch::{
    GuardedPrefetchConfig, MemoryPrefetchCandidate, MemoryPrefetchTasks,
};
use runner_supervisor::blank_pool::{BlankPoolReplenisher, BlankProfile, OptionalBlankPoolRequest};
use runner_supervisor::idle_pressure::{IdlePressureConfig, IdlePressureOwner};
use serde::Deserialize;

use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OptionalInputs {
    snapshot_path: PathBuf,
    snapshot_memory_mb: u32,
    prefetch_overhead_bytes: u64,
}

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    aged: bool,
) -> TestResult<()> {
    let measured: OptionalInputs = serde_json::from_slice(&std::fs::read(std::env::var(
        "OKOU_TEST_OPTIONAL_MEMORY_POLICY",
    )?)?)?;
    if measured.snapshot_memory_mb == 0 || measured.snapshot_path.metadata()?.len() == 0 {
        return Err(io::Error::other(
            "optional native snapshot needs positive measured shape and real bytes",
        )
        .into());
    }
    let pressure = IdlePressureOwner::spawn(IdlePressureConfig {
        pool: context.pool.clone(),
        status: context.status.clone(),
        tracker: context.tracker.clone(),
        operations: context.operations.clone(),
        policy: inputs.pressure_policy()?,
        sample_period: inputs.pressure_sample_period(),
        envelope: inputs.envelope(),
    })?;
    let control = pressure.optional_preparation();
    let prefetch_started = MemoryPrefetchTasks::spawn_guarded(
        [MemoryPrefetchCandidate {
            path: measured.snapshot_path,
            memory_mb: measured.snapshot_memory_mb,
        }],
        u64::from(measured.snapshot_memory_mb),
        GuardedPrefetchConfig {
            pressure: control.clone(),
            overhead_bytes: measured.prefetch_overhead_bytes,
        },
    );
    let (mut prefetch, mut latest) = match prefetch_started {
        Ok(started) => started,
        Err(error) => {
            pressure.shutdown().await?;
            return Err(error.into());
        }
    };
    let profiles = BTreeMap::from([(
        fixture::PROFILE.into(),
        BlankProfile {
            vcpu: 2,
            memory_mb: 4096,
            rootfs_hash: context.rootfs_hash.clone(),
            home_disk_mb: 16384,
        },
    )]);
    let factories = BTreeMap::from([(fixture::PROFILE.into(), (context.factory.clone(), true))]);
    let admission = PreSpawnAdmission::new(2)?;
    let mut blank = BlankPoolReplenisher::new(
        &profiles,
        &factories,
        &context.budget,
        if aged { 1 } else { 2 },
        None,
    );
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
    let outcome = tokio::time::timeout(Duration::from_secs(60), async {
        let mut ticks = tokio::time::interval(control.policy().optional_start_interval);
        loop {
            if blank.maybe_start_optional(request())? {
                break;
            }
            ticks.tick().await;
        }
        let result = blank
            .wait_for_optional_preparation()
            .await
            .ok_or_else(|| io::Error::other("native optional preparation owner missing"))?;
        let snapshot = result.snapshot();
        if !snapshot.prepared || snapshot.retired_exact != aged || snapshot.error.is_some() {
            return Err(io::Error::other(format!(
                "native optional preparation incomplete: {snapshot:?}"
            ))
            .into());
        }
        blank
            .finish_optional_preparation(&result, request())
            .await?;
        if !result.snapshot().published {
            return Err(io::Error::other("native optional publication refused").into());
        }
        while !latest.borrow_and_update().finished {
            latest.changed().await?;
        }
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    })
    .await;
    // Join both concrete producers before pressure, inventory and factory teardown.
    // Even a timeout/refusal is not positive physical completion evidence.
    prefetch.cancel();
    prefetch.drain().await;
    let blank_stopped = blank.shutdown_optional(&context.tracker).await;
    let pressure_stopped = pressure.shutdown().await;
    blank_stopped?;
    let stopped = pressure_stopped?;
    outcome.map_err(io::Error::other)??;
    let read = latest.borrow().clone();
    if stopped.producer_lost
        || read.completed != 1
        || read.failed != 0
        || read.uncertain != 0
        || read.read_bytes == 0
    {
        return Err(
            io::Error::other(format!("native shared optional read incomplete: {read:?}")).into(),
        );
    }
    let mut final_inventory = context
        .tracker
        .start_pool_retirement_batch(
            context.pool,
            context.status,
            context.operations,
            IdlePoolBatchRetirementRequest {
                scope: IdleRetirementBatchScope::All,
                envelope: inputs.envelope(),
                context: "native_optional_final_inventory",
            },
        )
        .await?;
    let report = final_inventory.join().await?;
    if !report.is_complete() {
        return Err(
            io::Error::other(format!("native optional saving incomplete: {report:?}")).into(),
        );
    }
    Ok(())
}
