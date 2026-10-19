//! Shared required-saving witnesses for native cleanup failure scenarios.

use std::{future::Future, pin::Pin};

use runner_lifecycle::host_memory_operations::MemoryOperationSnapshot;
use serde_json::{Value, json};

use super::*;

pub(super) async fn pending<F: Future>(
    future: Pin<&mut F>,
    completed: &mut Option<F::Output>,
) -> TestResult<()> {
    if completed.is_some() {
        return Err(io::Error::other("native cleanup future already completed").into());
    }
    if let std::task::Poll::Ready(result) = futures_util::poll!(future) {
        *completed = Some(result);
        return Err(io::Error::other("native cleanup future forgot held work").into());
    }
    Ok(())
}

pub(super) fn accounting(value: &MemoryOperationSnapshot) -> Value {
    json!({
        "registered_operations": value.registered_operations, "queued": value.queued,
        "granted": value.granted, "started": value.started, "uncertain": value.uncertain,
        "ordinary_growth_bytes": value.ordinary_growth_bytes,
        "cleanup_growth_bytes": value.cleanup_growth_bytes,
        "tracked_tasks": value.tracked_tasks, "closed": value.closed,
    })
}

pub(super) fn coverage(
    context: &transitions::Context,
    inputs: &fixture::Inputs,
    proof: &evidence::Case,
    closed: bool,
) -> TestResult<Value> {
    proof.require_full_lease()?;
    let value = context.operations.snapshot()?;
    let envelope = inputs.envelope();
    let maximum = envelope
        .live_growth_bytes
        .checked_add(envelope.tail_growth_bytes)
        .ok_or_else(|| io::Error::other("native cleanup growth overflow"))?;
    if value.registered_operations == 0
        || value.started == 0
        || value.tracked_tasks == 0
        || value.uncertain != 0
        || value.ordinary_growth_bytes != 0
        || value.cleanup_growth_bytes < envelope.tail_growth_bytes
        || value.cleanup_growth_bytes > maximum
        || value.closed != closed
    {
        return Err(io::Error::other("native cleanup released required growth").into());
    }
    Ok(
        json!({"allocated": context.budget.allocated(), "accounting": accounting(&value),
        "original_lease_active": true, "io_release_withheld": true}),
    )
}

pub(super) fn settled(value: &MemoryOperationSnapshot) -> TestResult<()> {
    if value.registered_operations != 0
        || value.queued != 0
        || value.granted != 0
        || value.started != 0
        || value.uncertain != 0
        || value.ordinary_growth_bytes != 0
        || value.cleanup_growth_bytes != 0
        || value.tracked_tasks != 0
        || !value.closed
    {
        return Err(io::Error::other("native cleanup accounting remains owned").into());
    }
    Ok(())
}
