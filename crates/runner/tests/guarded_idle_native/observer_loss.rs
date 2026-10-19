//! Accepted native saving outlives its dropped or panicked external observer.

use std::{path::Path, time::Duration};

use serde_json::json;

use super::cleanup_progress::{accounting, coverage, pending, settled};
use super::*;

pub async fn exercise(
    context: transitions::Context,
    inputs: &fixture::Inputs,
    proof: &Arc<evidence::Case>,
    directory: &Path,
    panic: bool,
) -> TestResult<()> {
    let gate = Arc::new(foreground_io::Gate::new()?);
    proof.install_foreground_io(gate.clone())?;
    let mut probe = foreground_probe::Probe::new(
        &context.pool,
        &context.budget,
        directory,
        &context.rootfs_hash,
    )
    .await?;
    let batch = context
        .tracker
        .start_pool_retirement_batch(
            context.pool.clone(),
            context.status.clone(),
            context.operations.clone(),
            IdlePoolBatchRetirementRequest {
                scope: IdleRetirementBatchScope::All,
                envelope: inputs.envelope(),
                context: "native_observer_loss",
            },
        )
        .await;
    let mut batch = match batch {
        Ok(batch) => Some(batch),
        Err(error) => {
            probe.finish().await?;
            return Err(error.into());
        }
    };
    let mut tracker_shutdown = Box::pin(context.tracker.close_and_wait());
    let mut accounting_shutdown = Box::pin(context.operations.close_and_wait());
    let mut tracker_completed = None;
    let mut accounting_completed = None;
    let mut observer = None;
    let mut pool_hold = None;
    let mut status_hold = None;
    let outcome =
        tokio::time::timeout(Duration::from_secs(90), async {
            gate.wait_entered().await?;
            proof.observer_loss_witness("tail_blocked", json!({
            "mode": if panic {"panic"} else {"drop"}, "policy": serde_json::to_value(inputs)?,
            "coverage": coverage(&context, inputs, proof, false)?,
        }))?;
            let (polled, observed) = tokio::sync::oneshot::channel();
            let mut receiver = batch
                .take()
                .ok_or_else(|| io::Error::other("native batch receiver missing"))?;
            observer = Some(tokio::spawn(async move {
                let mut completion = Box::pin(receiver.join());
                if futures_util::poll!(completion.as_mut()).is_ready() {
                    return Err(io::Error::other("native original observer was not Pending").into());
                }
                drop(completion);
                polled
                    .send(evidence::clocks()?.0)
                    .map_err(|_| io::Error::other("native observer Pending witness lost"))?;
                if panic {
                    // Inject the observer's unwind, leaving the independently
                    // registered physical cleanup producer untouched.
                    std::panic::resume_unwind(Box::new("native external cleanup observer panic"));
                }
                drop(receiver);
                Ok::<(), Box<dyn Error + Send + Sync>>(())
            }));
            let joined = observer
                .as_mut()
                .ok_or_else(|| io::Error::other("native observer missing"))?
                .await;
            observer.take();
            match (panic, joined) {
                (true, Err(error)) if error.is_panic() => {}
                (false, Ok(result)) => result?,
                _ => {
                    return Err(io::Error::other(
                        "native observer did not reach its expected outcome",
                    )
                    .into());
                }
            }
            let receiver_pending_ns = observed.await?;
            let observer_joined_ns = evidence::clocks()?.0;
            pending(tracker_shutdown.as_mut(), &mut tracker_completed).await?;
            pending(accounting_shutdown.as_mut(), &mut accounting_completed).await?;
            proof.observer_loss_witness("observer_lost", json!({
            "mode": if panic {"panic"} else {"drop"}, "panic_confirmed": panic,
            "observer_joined": true, "receiver_polled_pending": true,
            "receiver_pending_ns": receiver_pending_ns, "observer_joined_ns": observer_joined_ns,
            "tracker_shutdown_pending": true, "accounting_shutdown_pending": true,
            "coverage": coverage(&context, inputs, proof, true)?,
        }))?;
            pool_hold = Some(context.pool.lock().await);
            let pool_held_ns = evidence::clocks()?.0;
            status_hold = Some(context.status.hold_state_for_test().await);
            let status_held_ns = evidence::clocks()?.0;
            let mut status_waits = context.status.idle_snapshot_waits_for_test();
            let before = *status_waits.borrow_and_update();
            probe.request()?;
            {
                let heartbeat = probe.complete();
                tokio::pin!(heartbeat);
                if futures_util::poll!(&mut heartbeat).is_ready() {
                    return Err(io::Error::other("native heartbeat ignored held pool").into());
                }
            }
            let heartbeat_pending_ns = evidence::clocks()?.0;
            let observation = foreground_probe::observe().await?;
            proof.observer_loss_witness(
                "pool_wait_progress",
                json!({
                    "pool_held_ns": pool_held_ns, "status_held_ns": status_held_ns,
                    "heartbeat_pending_ns": heartbeat_pending_ns, "heartbeat_polled_pending": true,
                    "observer": observation, "coverage": coverage(&context, inputs, proof, true)?,
                }),
            )?;
            // The heartbeat may be acknowledged on the other worker before
            // this task resumes after unlock, so record the lower bound first.
            let pool_released_ns = evidence::clocks()?.0;
            drop(pool_hold.take());
            let heartbeat = probe.complete().await?;
            pending(tracker_shutdown.as_mut(), &mut tracker_completed).await?;
            pending(accounting_shutdown.as_mut(), &mut accounting_completed).await?;
            proof.observer_loss_witness(
                "tail_wait_progress",
                json!({
                    "pool_released_ns": pool_released_ns, "status_held_ns": status_held_ns,
                    "heartbeat": heartbeat, "tracker_shutdown_pending": true,
                    "accounting_shutdown_pending": true,
                    "coverage": coverage(&context, inputs, proof, true)?,
                }),
            )?;
            let io_released_ns = evidence::clocks()?.0;
            gate.release()?;
            while *status_waits.borrow_and_update() == before {
                status_waits.changed().await?;
            }
            let after = *status_waits.borrow();
            let status_wait_polled_ns = evidence::clocks()?.0;
            if after != before + 1 || context.budget.allocated() != (0, 0, 0) {
                return Err(
                    io::Error::other("native final status wait or lease release changed").into(),
                );
            }
            pending(tracker_shutdown.as_mut(), &mut tracker_completed).await?;
            let completed = accounting_completed.insert(accounting_shutdown.as_mut().await);
            let value = completed
                .as_ref()
                .map_err(|error| io::Error::other(error.to_string()))?;
            settled(value)?;
            probe.request()?;
            let heartbeat = probe.complete().await?;
            proof.observer_loss_witness(
                "status_wait_progress",
                json!({
                    "io_released_ns": io_released_ns, "status_held_ns": status_held_ns,
                    "status_wait_polled_ns": status_wait_polled_ns,
                    "status_waits_before": before, "status_waits_after": after,
                    "tracker_shutdown_pending": true, "accounting_joined": true,
                    "heartbeat": heartbeat, "accounting": accounting(value),
                    "allocated": context.budget.allocated(),
                }),
            )?;
            Ok::<(), Box<dyn Error + Send + Sync>>(())
        })
        .await;
    // Never leave a blocking read or an accepted producer behind on refusal.
    drop(pool_hold.take());
    drop(status_hold.take());
    let release = gate.release();
    if let Some(observer) = observer.take() {
        let _ = observer.await;
    }
    let remaining_receiver = if let Some(mut receiver) = batch.take() {
        receiver.join().await.map(|_| ())
    } else {
        Ok(())
    };
    if tracker_completed.is_none() {
        tracker_shutdown.await;
    }
    let completed = match accounting_completed {
        Some(result) => result,
        None => accounting_shutdown.await,
    };
    let reporting = probe.finish().await;
    release?;
    remaining_receiver?;
    let completed = completed?;
    reporting?;
    outcome.map_err(io::Error::other)??;
    settled(&completed)?;
    let activation = context.tracker.take_retained_activation_owners()?;
    let finalizing = context.tracker.take_retained_finalizing_owners()?;
    if !activation.is_empty() || !finalizing.is_empty() {
        proof.retain(activation);
        proof.retain(finalizing);
        return Err(io::Error::other("native observer loss left unresolved owners").into());
    }
    proof.observer_loss_witness(
        "producers_joined",
        json!({
            "tracker_joined": true, "accounting_joined": true, "observer_joined": true,
            "heartbeat_joined": true, "provider_joined": true, "peer_joined": true,
            "remaining_activation_owners": 0, "remaining_finalizing_owners": 0,
            "allocated": context.budget.allocated(), "accounting": accounting(&completed),
        }),
    )?;
    Ok(())
}
