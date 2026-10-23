//! Compiled complete optional owners; execution requires supplied native inputs.

use std::collections::BTreeMap;
use std::time::Duration;

use runner_executor::pre_spawn_admission::PreSpawnAdmission;
use runner_lifecycle::host_memory_pressure::HostPressureState;
use runner_lifecycle::lifecycle::RunnerMode;
use runner_lifecycle::prefetch::{
    GuardedPrefetchConfig, MemoryPrefetchCandidate, MemoryPrefetchTasks,
};
use runner_supervisor::blank_pool::{BlankPoolReplenisher, BlankProfile, OptionalBlankPoolRequest};
use runner_supervisor::idle_pressure::{IdlePressureConfig, IdlePressureOwner};
use serde::Deserialize;
use serde_json::json;

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
    proof: Option<&Arc<evidence::Case>>,
) -> TestResult<()> {
    let raw_inputs = std::fs::read(std::env::var("OKOU_TEST_OPTIONAL_MEMORY_POLICY")?)?;
    let measured: OptionalInputs = serde_json::from_slice(&raw_inputs)?;
    let snapshot_bytes = measured.snapshot_path.metadata()?.len();
    if measured.snapshot_memory_mb == 0
        || snapshot_bytes == 0
        || snapshot_bytes > u64::from(measured.snapshot_memory_mb) * 1024 * 1024
        || measured.prefetch_overhead_bytes < 1024 * 1024
    {
        return Err(io::Error::other(
            "optional native snapshot needs complete bytes within its supplied shape/overhead",
        )
        .into());
    }
    if let Some(proof) = proof {
        let expected_path =
            PathBuf::from(std::env::var("OKOU_TEST_RPC_SNAPSHOT_DIR")?).join("memory.bin");
        if std::fs::canonicalize(&measured.snapshot_path)? != std::fs::canonicalize(expected_path)?
        {
            return Err(
                io::Error::other("optional read must use the original packaged snapshot").into(),
            );
        }
        let path = measured.snapshot_path.clone();
        let expected = proof.snapshot_memory_hash()?.to_owned();
        tokio::task::spawn_blocking(move || evidence::verify_file(&path, &expected)).await??;
        proof.optional_witness(
            "inputs_verified",
            json!({
                "policy": serde_json::to_value(inputs)?,
                "optional_inputs_sha256": continuation::digest(&raw_inputs),
                "snapshot_sha256": proof.snapshot_memory_hash()?,
                "snapshot_bytes": snapshot_bytes,
                "snapshot_memory_mb": measured.snapshot_memory_mb,
                "prefetch_overhead_bytes": measured.prefetch_overhead_bytes,
                "allocated": context.budget.allocated(), "aged": aged,
            }),
        )?;
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
            home_disk_mb: fixture::HOME_DISK_MB,
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
            let observation = context.operations.observe_pressure().await;
            let now = tokio::time::Instant::now();
            let available = observation.available_bytes_at(now, control.policy().max_sample_age)?;
            let allocated = context.budget.allocated();
            // The controller can recover while the real observation is awaited.
            // Inspect its current state immediately before synchronous admission.
            let decision = control.decision();
            if blank.maybe_start_optional(request())? {
                if decision.state != HostPressureState::Ready || decision.wave_inflight
                    || available < control.policy().bounds.recovery_available_bytes
                {
                    return Err(io::Error::other("native optional start has no fresh Ready observation").into());
                }
                if let Some(proof) = proof {
                    proof.optional_witness("preparation_accepted", json!({
                        "state": "Ready", "wave_inflight": decision.wave_inflight,
                        "available_bytes": available,
                        "age_ns": u64::try_from(observation.age_at(now).ok_or_else(|| io::Error::other("native optional sample is in the future"))?.as_nanos())?,
                        "read_duration_ns": u64::try_from(observation.read_duration().as_nanos())?,
                        "allocated": allocated,
                    }))?;
                }
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
        let snapshot = result.snapshot();
        if !snapshot.published || snapshot.retained_resource || !snapshot.finished {
            return Err(io::Error::other("native optional publication refused").into());
        }
        if let Some(proof) = proof {
            proof.optional_witness("preparation_published", json!({
                "prepared": snapshot.prepared, "published": snapshot.published,
                "retired_exact": snapshot.retired_exact, "finished": snapshot.finished,
                "retained_resource": snapshot.retained_resource, "error": snapshot.error,
            }))?;
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
        || !stopped.stopped
        || !read.finished
        || read.accepted != 1
        || read.completed != 1
        || read.cancelled != 0
        || read.failed != 0
        || read.uncertain != 0
        || read.read_bytes != snapshot_bytes
    {
        return Err(
            io::Error::other(format!("native shared optional read incomplete: {read:?}")).into(),
        );
    }
    if let Some(proof) = proof {
        proof.optional_witness(
            "producers_joined",
            json!({
                "accepted": read.accepted, "completed": read.completed,
                "cancelled": read.cancelled, "failed": read.failed,
                "uncertain": read.uncertain, "read_bytes": read.read_bytes,
                "finished": read.finished, "pressure_stopped": stopped.stopped,
                "producer_lost": stopped.producer_lost,
                "prefetch_drained": true, "blank_shutdown_joined": true,
            }),
        )?;
    }
    // Save the original exact home while the independent optional blank still
    // exists, then retire that remaining inventory. Concurrent batch admissions
    // can correctly invalidate each other's accounting observations; this Ready
    // success corpus must not mistake their one-shot refusal for completed IO.
    for scope in [
        IdleRetirementBatchScope::Exact,
        IdleRetirementBatchScope::All,
    ] {
        let mut final_inventory = context
            .tracker
            .start_pool_retirement_batch(
                context.pool.clone(),
                context.status.clone(),
                context.operations.clone(),
                IdlePoolBatchRetirementRequest {
                    scope,
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
    }
    Ok(())
}
