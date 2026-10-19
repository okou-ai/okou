//! Real borrowed speculative rollback before the shared fixed-batch race.

use runner_lifecycle::idle_pool::{
    ActivationCleanupOutcome, GuardedSpeculativeIdleOwner, IdlePoolIncoming, IdlePoolIncomingOwner,
    IdleRetirementCandidate, IdleSandboxIdentity, RestoreReservedIdleResult,
};
use sandbox::SandboxBackingProcess;
use serde_json::json;

use super::*;

#[derive(Default)]
pub struct Owner {
    speculative: Option<GuardedSpeculativeIdleOwner>,
    incoming: Option<IdlePoolIncoming>,
}

impl Owner {
    pub async fn exercise(
        &mut self,
        context: &transitions::Context,
        proof: &Arc<evidence::Case>,
        history: RunId,
        selected: &IdleRetirementCandidate,
        backing: &Arc<dyn SandboxBackingProcess>,
    ) -> TestResult<()> {
        let started_ns = evidence::clocks()?.0;
        let reservation = context
            .pool
            .lock()
            .await
            .reserve_reusable(&context.reuse_key, fixture::PROFILE, &None)
            .ok_or_else(|| io::Error::other("physical rollback original reservation missing"))?;
        self.speculative = Some(match GuardedSpeculativeIdleOwner::new(reservation) {
            Ok(owner) => owner,
            Err(owner) => {
                proof.retain(owner);
                return Err(io::Error::other("physical rollback received running handoff").into());
            }
        });
        let original_backing = backing.identity();
        let mut cycles = Vec::new();
        for index in 0..2 {
            let owner = self
                .speculative
                .as_mut()
                .ok_or_else(|| io::Error::other("physical rollback owner absent"))?;
            if !owner.matches_claim(Some(&context.reuse_key), Some(history), fixture::PROFILE) {
                return Err(
                    io::Error::other("physical rollback changed original claim metadata").into(),
                );
            }
            let operation = RunId::new_v4();
            let rpc = Arc::new(std::sync::Mutex::new(None));
            let written = rpc.clone();
            let prepare_started_ns = evidence::clocks()?.0;
            owner
                .prepare(operation, move |sandbox, _, _| {
                    Box::pin(async move {
                        let digest = fixture::verify_speculative_guest(sandbox, history)
                            .await
                            .map_err(|error| error.to_string())?;
                        let completed = evidence::clocks().map_err(|error| error.to_string())?.0;
                        *written
                            .lock()
                            .map_err(|_| "physical RPC receipt poisoned")? =
                            Some((completed, digest));
                        Ok(())
                    })
                })
                .await
                .map_err(io::Error::other)?;
            let prepared_ns = evidence::clocks()?.0;
            let rpc = rpc
                .lock()
                .map_err(|_| io::Error::other("physical RPC receipt poisoned"))?
                .take()
                .ok_or_else(|| io::Error::other("physical RPC did not complete"))?;
            let repark_started_ns = evidence::clocks()?.0;
            owner
                .repark(fixture::IMAGE_BYTES)
                .await
                .map_err(io::Error::other)?;
            let repark_completed_ns = evidence::clocks()?.0;
            proof.require_full_lease()?;
            if !owner.matches_claim(Some(&context.reuse_key), Some(history), fixture::PROFILE)
                || backing.identity() != original_backing
                || context.budget.allocated() != (2, 4096, 1)
                || futures_util::poll!(Box::pin(backing.exit_confirmed()).as_mut()).is_ready()
            {
                return Err(io::Error::other(
                    "physical rollback lost original metadata/backing/full lease",
                )
                .into());
            }
            cycles.push(json!({"operation_run_id":operation,"prepare_started_ns":prepare_started_ns,
                "rpc_completed_ns":rpc.0,"prepared_ns":prepared_ns,"repark_started_ns":repark_started_ns,
                "repark_completed_ns":repark_completed_ns,"payload_sha256":rpc.1,
                "private_history_verified":true,"ordinary_home_verified":true,
                "physical_unpark_completed":true,"physical_repark_completed":true,
                "original_metadata_preserved":true,"original_full_lease_active":true}));
            self.incoming = Some(owner.take_incoming()?);
            self.speculative = None;
            if index == 0 {
                // A fresh borrowed owner represents the next speculative claim;
                // the verified parked capsule preserves the original metadata.
                let incoming = self
                    .incoming
                    .take()
                    .ok_or_else(|| io::Error::other("next speculative owner absent"))?;
                let reservation = match incoming.into_owner() {
                    Some(IdlePoolIncomingOwner::Reserved(owner)) => owner,
                    unexpected => {
                        proof.retain(unexpected);
                        return Err(
                            io::Error::other("next speculative claim lost parked owner").into()
                        );
                    }
                };
                self.speculative = Some(match GuardedSpeculativeIdleOwner::new(reservation) {
                    Ok(owner) => owner,
                    Err(owner) => {
                        proof.retain(owner);
                        return Err(io::Error::other(
                            "next speculative claim received running owner",
                        )
                        .into());
                    }
                });
            }
        }
        let mut pool = context.pool.lock().await;
        if !pool.is_empty() {
            return Err(
                io::Error::other("physical rollback cannot replace unexpected inventory").into(),
            );
        }
        let incoming = self
            .incoming
            .take()
            .ok_or_else(|| io::Error::other("physical rollback incoming absent"))?;
        let reservation = match incoming.into_owner() {
            Some(IdlePoolIncomingOwner::Reserved(owner)) => owner,
            unexpected => {
                proof.retain(unexpected);
                return Err(
                    io::Error::other("physical rollback lost complete parked reservation").into(),
                );
            }
        };
        let sandbox_id = reservation.sandbox_id();
        let restored = pool.restore_reserved(reservation);
        if !matches!(restored, RestoreReservedIdleResult::Restored) {
            proof.retain(restored);
            return Err(
                io::Error::other("physical rollback could not restore original owner").into(),
            );
        }
        let identity = IdleSandboxIdentity::Exact(context.reuse_key.clone());
        if pool
            .retirement_candidate(&identity)?
            .same_insertion(selected)
        {
            return Err(io::Error::other("physical rollback retained old insertion").into());
        }
        proof.batch_repark_witness("original_reparked", json!({
            "started_ns":started_ns,"restored_ns":evidence::clocks()?.0,
            "original_history_run_id":history,"original_sandbox_id":sandbox_id,
            "original_backing_generation":original_backing.generation(),"reuse_key":context.reuse_key,
            "cycles":cycles,"revision":pool.status_snapshot().revision,"same_insertion":false,
            "restored_original":true,"image_size_bytes":fixture::IMAGE_BYTES,
            "payload_bytes":fixture::PAYLOAD_BYTES,"allocated":context.budget.allocated(),
            "provider_awaits_outside_pool_status":true,
        }))?;
        Ok(())
    }

    /// Retire any caller-owned remainder after failure, before tracker teardown.
    pub async fn finish(
        &mut self,
        context: &transitions::Context,
        inputs: &fixture::Inputs,
        proof: &evidence::Case,
    ) -> TestResult<()> {
        let owner = if let Some(mut incoming) = self.incoming.take() {
            match incoming.take_required_cleanup_owner() {
                Ok(owner) => owner,
                Err(error) => {
                    proof.retain(incoming);
                    return Err(error.into());
                }
            }
        } else if let Some(mut speculative) = self.speculative.take() {
            match speculative.take_cleanup_owner() {
                Ok(owner) => owner,
                Err(error) => {
                    proof.retain(speculative);
                    return Err(error.into());
                }
            }
        } else {
            return Ok(());
        };
        let mut owner = Some(owner);
        let mut task = match context
            .tracker
            .retire_activation_owner(
                &mut owner,
                &context.operations,
                inputs.envelope(),
                "native_repark_failure",
            )
            .await
        {
            Ok(task) => task,
            Err(error) => {
                proof.retain(owner);
                return Err(error.into());
            }
        };
        let result = task.join().await??;
        if !matches!(
            result,
            ActivationCleanupOutcome::Completed {
                home_cache_promoted: true
            }
        ) {
            return Err(
                io::Error::other("physical rollback failure cleanup remains uncertain").into(),
            );
        }
        drop(task.take_completed_lease()?);
        Ok(())
    }
}
