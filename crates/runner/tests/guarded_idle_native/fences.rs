//! Native pre-detach refusals retain the exact original physical owner.

use std::time::Duration;

use runner_host::host_memory::HostMemoryUnknown;
use runner_lifecycle::idle_pool::{
    IdlePoolRetirement, IdleSandboxIdentity, RestoreReservedIdleResult,
};
use sandbox::SandboxBackingProcess;
use serde_json::json;

use super::*;

#[derive(Clone, Copy)]
enum Fence {
    Stale,
    Insertion,
    Authority,
    Envelope,
}

impl Fence {
    fn name(self) -> &'static str {
        match self {
            Self::Stale => "stale_refresh",
            Self::Insertion => "changed_insertion",
            Self::Authority => "foreign_authority",
            Self::Envelope => "changed_envelope",
        }
    }

    fn expected(self) -> MemoryOperationError {
        match self {
            Self::Stale => MemoryOperationError::UnknownObservation(HostMemoryUnknown::Stale),
            Self::Insertion => MemoryOperationError::ResourceChanged,
            Self::Authority | Self::Envelope => MemoryOperationError::OwnershipInvariant,
        }
    }
}

pub async fn exercise(
    context: &transitions::Context,
    inputs: &fixture::Inputs,
    source: &recovery_source::Source,
    proof: &Arc<evidence::Case>,
    backing: &Arc<dyn SandboxBackingProcess>,
) -> TestResult<()> {
    let original = backing.identity();
    for fence in [
        Fence::Stale,
        Fence::Insertion,
        Fence::Authority,
        Fence::Envelope,
    ] {
        let selected_ns = evidence::clocks()?.0;
        let identity = IdleSandboxIdentity::Exact(context.reuse_key.clone());
        let (candidate, original_id) = {
            let pool = context.pool.lock().await;
            let snapshot = pool.status_snapshot();
            let [entry] = snapshot.idle_sandboxes.as_slice() else {
                return Err(
                    io::Error::other("native fence requires its single original owner").into(),
                );
            };
            (pool.retirement_candidate(&identity)?, entry.sandbox_id)
        };
        let before = context.operations.snapshot()?;
        if before.registered_operations != 0 || before.tracked_tasks != 0 {
            return Err(io::Error::other("native fence has unrelated P2 work").into());
        }
        let first_sample = source.samples()?.len();
        let mut retirement =
            IdlePoolRetirement::new(candidate.clone(), &context.operations, inputs.envelope())?;
        retirement.try_grant().await?;
        let granted_ns = evidence::clocks()?.0;
        let granted = context.operations.snapshot()?;
        if granted.granted != 2 || granted.started != 0 || granted.tracked_tasks != 0 {
            return Err(
                io::Error::other("native fence lacks paired unused original grants").into(),
            );
        }
        // Keep unused permissions outside the waiting future. Early observation
        // failure must release the pool guard before dropping these claims.
        let mut retirement = Some(retirement);
        // The independent empty authority is a refusal input, never a replacement
        // accepting authority or a source of successful physical credit.
        let foreign = inputs.operations()?;
        let mut holder = context.pool.lock().await;
        let held_ns = evidence::clocks()?.0;
        let selected_revision = holder.revision();
        let (entered, pending) = tokio::sync::oneshot::channel();
        let attempt = async {
            let lock = context.pool.lock();
            tokio::pin!(lock);
            if futures_util::poll!(&mut lock).is_ready() {
                return Err(
                    io::Error::other("native fence did not encounter the held pool").into(),
                );
            }
            entered
                .send(())
                .map_err(|_| io::Error::other("native fence wait observer lost"))?;
            let mut pool = lock.await;
            let mut retirement = retirement
                .take()
                .ok_or_else(|| io::Error::other("native fence permissions already consumed"))?;
            let mut refresh = None;
            let mut refresh_error = None;
            if matches!(fence, Fence::Stale) {
                // A grant has no automatic start-time expiry. The caller must
                // refresh after a wait, outside the inventory lock.
                drop(pool);
                source.delay_next_delivery(
                    inputs.pressure_policy()?.max_sample_age + Duration::from_millis(1),
                )?;
                let started_ns = evidence::clocks()?.0;
                let error = retirement
                    .refresh_grants()
                    .await
                    .err()
                    .ok_or_else(|| io::Error::other("native expired refresh was accepted"))?;
                let finished_ns = evidence::clocks()?.0;
                let rearm = retirement.validate_granted_backing();
                if rearm != Err(MemoryOperationError::Consumed) {
                    return Err(io::Error::other("native failed refresh was rearmed").into());
                }
                refresh = Some(json!({"started_ns": started_ns, "finished_ns": finished_ns,
                    "error": format!("{error:?}"), "backing_rearm_error": "Consumed"}));
                refresh_error = Some(error);
                pool = context.pool.lock().await;
            }
            let result = match fence {
                Fence::Authority => retirement.start_required(
                    &mut pool,
                    &foreign,
                    inputs.envelope(),
                    "native_fence_foreign",
                ),
                Fence::Envelope => {
                    let mut envelope = inputs.envelope();
                    envelope.live_growth_bytes = envelope
                        .live_growth_bytes
                        .checked_add(1)
                        .ok_or_else(|| io::Error::other("native fence envelope overflow"))?;
                    retirement.start_required(
                        &mut pool,
                        &context.operations,
                        envelope,
                        "native_fence_envelope",
                    )
                }
                _ => retirement.start(&mut pool, "native_fence_original"),
            };
            let revision = pool.revision();
            let snapshot = pool.status_snapshot();
            // Return both outcomes outside the inventory lock. In particular,
            // unused claims may own the final provider reference on rejection.
            drop(pool);
            let error = match result {
                Err(failure) => failure.into_error(),
                Ok(accepted) => {
                    proof.retain(accepted);
                    return Err(io::Error::other(
                        "native fence unexpectedly accepted physical cleanup",
                    )
                    .into());
                }
            };
            let start_error = format!("{error:?}");
            if matches!(fence, Fence::Stale) && error != MemoryOperationError::Consumed {
                return Err(io::Error::other("native failed refresh allowed start").into());
            }
            Ok::<_, Box<dyn Error + Send + Sync>>((
                refresh_error.unwrap_or(error),
                revision,
                snapshot,
                evidence::clocks()?.0,
                refresh,
                start_error,
            ))
        };
        tokio::pin!(attempt);
        if futures_util::poll!(&mut attempt).is_ready() {
            return Err(
                io::Error::other("native fence completed before releasing the pool").into(),
            );
        }
        pending.await?;
        let wait_polled_ns = evidence::clocks()?.0;
        let observer = foreground_probe::observe().await?;
        if matches!(fence, Fence::Insertion) {
            let owner = holder
                .take_reserved(&context.reuse_key)
                .ok_or_else(|| io::Error::other("native fence original reservation missing"))?;
            let restored = holder.restore_reserved(owner);
            if !matches!(restored, RestoreReservedIdleResult::Restored) {
                proof.retain(restored);
                return Err(io::Error::other("native fence original restoration failed").into());
            }
        }
        let ready_revision = holder.revision();
        let same_insertion = holder
            .retirement_candidate(&identity)?
            .same_insertion(&candidate);
        if same_insertion == matches!(fence, Fence::Insertion) {
            return Err(io::Error::other(
                "native fence did not preserve/change the selected insertion",
            )
            .into());
        }
        drop(holder);
        let released_ns = evidence::clocks()?.0;
        let (error, revision, snapshot, refused_ns, refresh, start_error) = attempt.await?;
        if error != fence.expected()
            || revision != ready_revision
            || !matches!(snapshot.idle_sandboxes.as_slice(), [entry] if entry.sandbox_id == original_id)
            || backing.identity() != original
            || context.budget.allocated() != (2, 4096, 1)
        {
            return Err(io::Error::other(format!(
                "native fence lost exact refusal/original custody: {error:?}"
            ))
            .into());
        }
        proof.require_full_lease()?;
        let after = context.operations.snapshot()?;
        let closed = foreign.close_and_wait().await?;
        if after.registered_operations != 0
            || after.started != 0
            || after.tracked_tasks != 0
            || closed.registered_operations != 0
            || closed.started != 0
            || closed.tracked_tasks != 0
        {
            return Err(io::Error::other("native fence left accepted or unjoined claims").into());
        }
        proof.fence_witness(fence.name(), json!({
            "policy": serde_json::to_value(inputs)?, "expected_error": format!("{:?}", fence.expected()),
            "error": format!("{error:?}"), "selected_ns": selected_ns, "granted_ns": granted_ns,
            "refresh": refresh, "start_error": start_error,
            "pool_held_ns": held_ns, "wait_polled_ns": wait_polled_ns,
            "pool_released_ns": released_ns, "refused_ns": refused_ns,
            "selected_revision": selected_revision, "ready_revision": ready_revision, "refused_revision": revision,
            "same_insertion": same_insertion,
            "pool_wait_polled_pending": true, "observer": observer,
            "samples": source.samples()?.into_iter().skip(first_sample).collect::<Vec<_>>(),
            "paired_grants": granted.granted, "registered_after": after.registered_operations,
            "started_after": after.started, "tracked_after": after.tracked_tasks,
            "foreign_closed": closed.closed, "foreign_registered": closed.registered_operations,
            "foreign_started": closed.started, "foreign_tracked": closed.tracked_tasks,
            "original_sandbox_id": original_id.to_string(),
            "original_backing_generation": original.generation().to_string(),
            "full_original_lease": [2, 4096, 1], "allocated": context.budget.allocated(),
            "original_retained": true, "cleanup_accepted": false,
        }))?;
    }
    Ok(())
}
