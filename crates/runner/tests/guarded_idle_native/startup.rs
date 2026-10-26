//! Experimental unadmitted startup reading beside a suppressed guarded reader.

use std::time::Duration;

use runner_lifecycle::host_memory_pressure::HostPressureState;
use runner_lifecycle::prefetch::{
    GuardedPrefetchConfig, MemoryPrefetchCandidate, MemoryPrefetchTasks, StartupPrefetchSnapshot,
};
use runner_supervisor::idle_pressure::{IdlePressureConfig, IdlePressureOwner};
use serde::Deserialize;
use serde_json::{Value, json};

use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Inputs {
    snapshot_path: PathBuf,
    snapshot_memory_mb: u32,
    prefetch_overhead_bytes: u64,
}

pub(super) fn completed(read: &StartupPrefetchSnapshot, bytes: u64) -> TestResult<()> {
    if read.accepted != 1
        || read.completed != 1
        || read.cancelled != 0
        || read.failed != 0
        || read.read_bytes != bytes
        || read.last_error.is_some()
    {
        return Err(io::Error::other(format!(
            "startup did not completely read the original snapshot: {read:?}"
        ))
        .into());
    }
    Ok(())
}

pub(super) fn read_evidence(read: &StartupPrefetchSnapshot) -> Value {
    json!({"accepted": read.accepted, "completed": read.completed,
        "cancelled": read.cancelled, "failed": read.failed,
        "read_bytes": read.read_bytes, "last_error": read.last_error})
}

pub(super) struct Original {
    pub path: PathBuf,
    pub bytes: u64,
    pub overhead: u64,
    pub raw: Vec<u8>,
}

pub(super) async fn original(
    budget: &ResourceBudget,
    inputs: &fixture::Inputs,
    proof: &evidence::Case,
) -> TestResult<Original> {
    let raw = std::fs::read(std::env::var("OKOU_TEST_OPTIONAL_MEMORY_POLICY")?)?;
    let supplied: Inputs = serde_json::from_slice(&raw)?;
    let original = PathBuf::from(std::env::var("OKOU_TEST_RPC_SNAPSHOT_DIR")?).join("memory.bin");
    let bytes = original.metadata()?.len();
    let policy = inputs.pressure_policy()?;
    policy.bounds.growth_bytes(
        supplied.snapshot_memory_mb,
        supplied.prefetch_overhead_bytes,
    )?;
    if std::fs::canonicalize(&original)? != std::fs::canonicalize(&supplied.snapshot_path)?
        || supplied.snapshot_memory_mb != 4096
        || bytes != 4096 * 1024 * 1024
        || supplied.prefetch_overhead_bytes < 1024 * 1024
        || budget.allocated() != (2, 4096, 1)
    {
        return Err(
            io::Error::other("startup original snapshot shape/identity/lease is invalid").into(),
        );
    }
    let checked = original.clone();
    let hash = proof.snapshot_memory_hash()?.to_owned();
    tokio::task::spawn_blocking(move || evidence::verify_file(&checked, &hash)).await??;
    Ok(Original {
        path: original,
        bytes,
        overhead: supplied.prefetch_overhead_bytes,
        raw,
    })
}

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    source: &Arc<recovery_source::Source>,
    proof: Option<&Arc<evidence::Case>>,
) -> TestResult<()> {
    let proof = proof.ok_or_else(|| io::Error::other("startup requires measured owners"))?;
    let Original {
        path: original,
        bytes,
        overhead,
        raw,
    } = original(&context.budget, inputs, proof).await?;
    let policy = inputs.pressure_policy()?;
    proof.startup_witness(
        "inputs_verified",
        json!({
            "policy": serde_json::to_value(inputs)?, "inputs_sha256": continuation::digest(&raw),
            "snapshot_sha256": proof.snapshot_memory_hash()?, "snapshot_bytes": bytes,
            "snapshot_memory_mb": 4096,
            "prefetch_overhead_bytes": overhead,
            "allocated": context.budget.allocated(), "startup_pressure_guarded": false,
        }),
    )?;

    source.pause();
    let pressure = IdlePressureOwner::spawn(IdlePressureConfig {
        pool: context.pool.clone(),
        status: context.status.clone(),
        tracker: context.tracker.clone(),
        operations: context.operations.clone(),
        policy,
        sample_period: inputs.pressure_sample_period(),
        envelope: inputs.envelope(),
    })?;
    let control = pressure.optional_preparation();
    let guarded = MemoryPrefetchTasks::spawn_guarded(
        [MemoryPrefetchCandidate {
            path: original.clone(),
            memory_mb: 4096,
        }],
        4096,
        GuardedPrefetchConfig {
            pressure: control.clone(),
            overhead_bytes: overhead,
        },
    );
    let (mut runtime, reads) = match guarded {
        Ok(spawned) => spawned,
        Err(error) => {
            pressure.stop();
            source.resume();
            pressure.shutdown().await?;
            return Err(error.into());
        }
    };
    let mut startup = None;
    let outcome = tokio::time::timeout(Duration::from_secs(90), async {
        source.wait_for_readers(1).await;
        critical::no_reads(&reads.borrow(), false)?;
        let pending = context.operations.snapshot()?;
        if control.decision().state != HostPressureState::Unknown
            || pending.registered_operations != 0 || pending.tracked_tasks != 0
        {
            return Err(io::Error::other("startup initial runtime reader is not Unknown/quiescent").into());
        }
        proof.startup_witness("initial_unknown", json!({
            "state": "Unknown", "reads": critical::read_evidence(&reads.borrow()),
            "registered_operations": pending.registered_operations, "tracked_tasks": pending.tracked_tasks,
        }))?;
        let tasks = startup.insert(MemoryPrefetchTasks::spawn(
            [MemoryPrefetchCandidate { path: original.clone(), memory_mb: 4096 }], 4096,
        ));
        // This is the retained unadmitted startup baseline. Neither spawning
        // nor draining alone can establish a complete physical read.
        tasks.drain().await;
        let read = tasks.startup_snapshot()?;
        completed(&read, bytes)?;
        critical::no_reads(&reads.borrow(), false)?;
        let pending = context.operations.snapshot()?;
        if control.decision().state != HostPressureState::Unknown
            || context.budget.allocated() != (2, 4096, 1)
            || pending.registered_operations != 0 || pending.tracked_tasks != 0
        {
            return Err(io::Error::other("startup changed held runtime admission/original ownership").into());
        }
        proof.startup_witness("startup_completed", json!({
            "startup": read_evidence(&read), "startup_drained": true, "state": "Unknown",
            "reads": critical::read_evidence(&reads.borrow()), "allocated": context.budget.allocated(),
            "registered_operations": pending.registered_operations, "tracked_tasks": pending.tracked_tasks,
        }))?;
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    }).await;
    // A failed case still joins every started reader before its dependencies.
    runtime.cancel();
    runtime.drain().await;
    if let Some(tasks) = &mut startup {
        tasks.cancel();
        tasks.drain().await;
    }
    // Reopening the held sampler must not offer a final pressure wave.
    pressure.stop();
    source.resume();
    let stopped = pressure.shutdown().await?;
    outcome.map_err(io::Error::other)??;
    critical::no_reads(&reads.borrow(), true)?;
    if stopped.producer_lost || !stopped.stopped || stopped.decision.wave_inflight {
        return Err(io::Error::other("startup pressure/sampler did not positively join").into());
    }
    let read = startup
        .as_ref()
        .ok_or_else(|| io::Error::other("startup owner missing"))?
        .startup_snapshot()?;
    completed(&read, bytes)?;
    let pending = context.operations.snapshot()?;
    if pending.registered_operations != 0 || pending.tracked_tasks != 0 {
        return Err(io::Error::other("startup runtime P2 has unjoined work").into());
    }
    let hash = proof.snapshot_memory_hash()?.to_owned();
    tokio::task::spawn_blocking(move || evidence::verify_file(&original, &hash)).await??;
    proof.startup_witness("producers_joined", json!({
        "startup": read_evidence(&read), "startup_drained": true,
        "reads": critical::read_evidence(&reads.borrow()), "runtime_drained": true,
        "pressure_stopped": stopped.stopped, "producer_lost": stopped.producer_lost,
        "wave_inflight": stopped.decision.wave_inflight, "snapshot_reverified": true,
        "registered_operations": pending.registered_operations, "tracked_tasks": pending.tracked_tasks,
    }))?;
    let mut batch = context
        .tracker
        .start_pool_retirement_batch(
            context.pool,
            context.status,
            context.operations,
            IdlePoolBatchRetirementRequest {
                scope: IdleRetirementBatchScope::All,
                envelope: inputs.envelope(),
                context: "native_startup_original_required_saving",
            },
        )
        .await?;
    let result = batch.join().await?;
    if !result.is_complete() || result.selected != 1 || result.completed != 1 {
        return Err(
            io::Error::other(format!("startup original saving incomplete: {result:?}")).into(),
        );
    }
    Ok(())
}
