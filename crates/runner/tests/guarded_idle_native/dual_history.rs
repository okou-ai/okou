//! Two required histories sharing one entry through phased real Executor reuse.

use runner_lifecycle::{
    home_image_cache::HomeCacheCheckoutResult,
    idle_pool::{IdleActivationOwner, IdlePoolIncoming},
    resource_budget::BudgetLeaseWitness,
};
use serde_json::json;
use shell_quote::quote_shell_arg;

use super::*;

const WORKSPACE: &str = "/home/user/workspace/dual-history-payload";

pub struct Setup<'a> {
    pub factory: Arc<Box<dyn SandboxFactory>>,
    pub paths: RunnerPaths,
    pub cache: HomeImageCache,
    pub status: Arc<StatusTracker>,
    pub budget: Arc<ResourceBudget>,
    pub operations: runner_lifecycle::host_memory_operations::HostMemoryOperations,
    pub source: &'a recovery_source::Source,
    pub proof: &'a Arc<evidence::Case>,
    pub inputs: &'a fixture::Inputs,
    pub rootfs: String,
    pub original: RunId,
    pub id: SandboxId,
    pub key: String,
    pub nonzero: bool,
}

struct History {
    original: RunId,
    generation: RunId,
    id: SandboxId,
    backing: String,
    thread: String,
    bytes: Vec<u8>,
    private: Vec<RunId>,
}

pub struct Histories {
    original_fixture: Arc<continuation::Fixture>,
    incoming_fixture: Arc<continuation::Fixture>,
    original: History,
    incoming: Option<History>,
    incoming_lease: Option<BudgetLeaseWitness>,
    cache_key: String,
    directory: PathBuf,
    proof: Arc<evidence::Case>,
}

fn failure(message: &str) -> Box<dyn Error + Send + Sync> {
    io::Error::other(message).into()
}

pub async fn exercise(setup: Setup<'_>) -> TestResult<()> {
    let Setup {
        factory,
        paths,
        cache,
        status,
        budget,
        operations,
        source,
        proof,
        inputs,
        rootfs,
        original,
        id,
        key,
        nonzero,
    } = setup;
    let original_fixture = continuation::Fixture::new(
        &paths,
        cache.clone(),
        rootfs.clone(),
        proof.clone(),
        nonzero,
    )
    .await?;
    let incoming_fixture =
        continuation::Fixture::new(&paths, cache, rootfs.clone(), proof.clone(), false).await?;
    let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096)
        .ok_or_else(|| failure("dual original full lease unavailable"))?;
    proof.bind_original_lease(&lease)?;
    let result = original_fixture
        .execute(continuation::Execution {
            factory: factory.clone(),
            operations: operations.clone(),
            inputs,
            run: original,
            id,
            key: key.clone(),
            history: Vec::new(),
            original,
            continued: false,
        })
        .await;
    let mut prepared = match result {
        Ok(p) => p,
        Err(e) => {
            proof.retain(lease);
            proof.retain(original_fixture);
            proof.retain(incoming_fixture);
            return Err(e);
        }
    };
    let initialized: TestResult<_> = async {
        fixture::prepare_started_guest(&mut *prepared.sandbox, original).await?;
        prepared.sandbox.write_file(WORKSPACE, &fixture::home_payload(original)).await?;
        let backing = prepared.sandbox.backing_process().ok_or_else(|| failure("dual original backing missing"))?;
        proof.bind(id.to_string(), backing.clone(), budget.clone())?;
        if prepared.sandbox.park().await? != SandboxParkOutcome::Reusable { return Err(failure("dual original failed to park")); }
        let cache_key = prepared.home.cache_key().ok_or_else(|| failure("dual original entry key missing"))?.to_owned();
        let history = History { original, generation: original, id, backing: backing.identity().generation().to_string(),
            thread: original_fixture.session()?.0, bytes: prepared.history.clone(), private: vec![original] };
        proof.dual_history_witness("original_prepared", json!({
            "run_id":original,"sandbox_id":id,"backing_generation":history.backing,"thread_id":history.thread,
            "history_hex":hex::encode(&history.bytes),"cache_key":cache_key,"reuse_key":key,
            "profile":fixture::PROFILE,"home_bytes":fixture::IMAGE_BYTES,"exit_code":prepared.exit_code,
            "final_identity_verified":prepared.identity.is_some(),"allocated":budget.allocated(),
        }))?;
        Ok((backing, cache_key, history))
    }.await;
    let (backing, cache_key, history) = match initialized {
        Ok(value) => value,
        Err(e) => {
            proof.retain(prepared);
            proof.retain(lease);
            proof.retain(original_fixture);
            proof.retain(incoming_fixture);
            return Err(e);
        }
    };
    let promotion = prepared
        .home
        .into_promotion_context(HomeImagePromotionRequest {
            run_id: original,
            sandbox_id: id,
            restored_session_identity: prepared.identity.as_ref(),
            terminal_status: if nonzero {
                HomeCacheTerminalStatus::NonzeroExit
            } else {
                HomeCacheTerminalStatus::Success
            },
            completed_at: chrono::Utc::now().to_rfc3339(),
            storage_fingerprints: prepared.storage.clone(),
        });
    let Some(promotion) = promotion else {
        proof.retain(prepared.sandbox);
        proof.retain(lease);
        proof.retain(original_fixture);
        proof.retain(incoming_fixture);
        return Err(failure("dual original promotion unavailable"));
    };
    let candidate = ParkedIdleCandidateBuilder::new(&key, lease)
        .with_sandbox(prepared.sandbox)
        .with_factory(factory.clone())
        .with_sandbox_id(id)
        .with_profile_name(fixture::PROFILE)
        .with_rootfs_hash(&rootfs)
        .with_history_generation_run_id(original)
        .with_home_promotion(promotion)
        .with_storage_fingerprints(prepared.storage);
    let mut candidate = if let Some(identity) = prepared.identity {
        candidate.with_restored_session_identity(identity)
    } else {
        candidate
    }
    .build();
    if let Err(e) = candidate.capture_retirement_backing() {
        proof.retain(candidate);
        proof.retain(original_fixture);
        proof.retain(incoming_fixture);
        return Err(e.into());
    }
    let pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
        max_idle: 1,
    })));
    let parked = pool.lock().await.park(candidate);
    if !matches!(parked, ParkResult::Parked) {
        proof.retain(parked);
        proof.retain(pool);
        proof.retain(original_fixture);
        proof.retain(incoming_fixture);
        return Err(failure("dual original insertion failed"));
    }
    let tracker = IdleDestroyTracker::new(Arc::new(Notify::new()));
    proof.retain(pool.clone());
    proof.retain(tracker.clone());
    proof.retain(operations.clone());
    let context = transitions::Context {
        factory,
        pool,
        status,
        operations,
        budget,
        tracker,
        rootfs_hash: rootfs,
        reuse_key: key,
    };
    let mut histories = Histories {
        original_fixture,
        incoming_fixture,
        original: history,
        incoming: None,
        incoming_lease: None,
        cache_key,
        directory: paths.base_dir().to_owned(),
        proof: proof.clone(),
    };
    proof.event("terminal_started", json!({}))?;
    let result = batch_replacement::exercise(
        context,
        inputs,
        source,
        proof,
        paths.base_dir(),
        backing,
        Some(&mut histories),
    )
    .await;
    if let Err(e) = result {
        proof.retain(histories);
        return Err(e);
    }
    Arc::try_unwrap(histories.original_fixture)
        .map_err(|_| failure("dual original API still owned"))?
        .finish()
        .await?;
    Arc::try_unwrap(histories.incoming_fixture)
        .map_err(|_| failure("dual incoming API still owned"))?
        .finish()
        .await?;
    proof.dual_history_witness(
        "histories_joined",
        json!({"original_api_joined":true,"incoming_api_joined":true,
        "both_required_histories_restored":true,"permanent_dual_cache_retention_claimed":false}),
    )?;
    Ok(())
}

impl Histories {
    pub async fn prepare_incoming(
        &mut self,
        context: &transitions::Context,
        inputs: &fixture::Inputs,
    ) -> TestResult<transitions::PreparedIncoming> {
        let run = RunId::new_v4();
        let id = SandboxId::new_v4();
        let lease = ResourceBudget::try_reserve_lease(&context.budget, 2, 4096)
            .ok_or_else(|| failure("dual incoming lease unavailable"))?;
        self.incoming_lease = lease.witness();
        let result = self
            .incoming_fixture
            .execute(continuation::Execution {
                factory: context.factory.clone(),
                operations: context.operations.clone(),
                inputs,
                run,
                id,
                key: context.reuse_key.clone(),
                history: Vec::new(),
                original: run,
                continued: false,
            })
            .await;
        let mut prepared = match result {
            Ok(p) => p,
            Err(e) => {
                self.proof.retain(lease);
                return Err(e);
            }
        };
        let checked: TestResult<_> = async {
            let locked = prepared.home.checkout_observation().is_some_and(|observation| {
                observation.outcome == runner_host::home_observation::HomeObservationOutcome::Busy
                    && observation.reason.as_deref() == Some("finalizing")
                    && observation.reuse_key.as_deref() == Some(context.reuse_key.as_str())
                    && observation.profile_name.as_deref() == Some(fixture::PROFILE)
            });
            if prepared.home.result()!=HomeCacheCheckoutResult::LockBusy || !locked || prepared.identity.is_none() {
                return Err(failure("dual incoming did not retain a complete LockBusy history"));
            }
            fixture::prepare_started_guest(&mut *prepared.sandbox, run).await?;
            prepared.sandbox.write_file(WORKSPACE, &fixture::home_payload(run)).await?;
            let backing = prepared.sandbox.backing_process().ok_or_else(||failure("dual incoming backing missing"))?;
            if prepared.sandbox.park().await? != SandboxParkOutcome::Reusable {return Err(failure("dual incoming failed to park"));}
            let history = History {original:run,generation:run,id,backing:backing.identity().generation().to_string(),
                thread:self.incoming_fixture.session()?.0,bytes:prepared.history.clone(),private:vec![run]};
            if history.thread==self.original.thread || history.bytes==self.original.bytes {return Err(failure("dual histories are not independent"));}
            self.proof.dual_history_witness("incoming_prepared",json!({
                "run_id":run,"sandbox_id":id,"backing_generation":history.backing,"thread_id":history.thread,
                "history_hex":hex::encode(&history.bytes),"cache_key":self.cache_key,"reuse_key":context.reuse_key,
                "initial_checkout":"LockBusy","lock_owner":"finalizing","final_identity_verified":true,"incoming_full_lease_active":self.active()?,
                "allocated":context.budget.allocated(),
            }))?;
            self.incoming=Some(history);
            Ok(backing)
        }.await;
        let backing = match checked {
            Ok(b) => b,
            Err(e) => {
                self.proof.retain(prepared);
                self.proof.retain(lease);
                return Err(e);
            }
        };
        let receipt = transitions::IncomingPreparation {
            sandbox_id: id.to_string(),
            backing_generation: backing.identity().generation().to_string(),
            operation_id: prepared.preparation.operation_id.clone(),
            grant_started_ns: prepared.preparation.grant_started_ns,
            grant_finished_ns: prepared.preparation.grant_finished_ns,
            prepared_ns: evidence::clocks()?.0,
            guest_rpc_completed: true,
            phase_settled: true,
            separate_incoming_lease: true,
        };
        let Some(identity) = prepared.identity.take() else {
            self.proof.retain(prepared);
            self.proof.retain(lease);
            return Err(failure("dual incoming identity missing"));
        };
        let mut candidate = ParkedIdleCandidateBuilder::new(&context.reuse_key, lease)
            .with_sandbox(prepared.sandbox)
            .with_factory(context.factory.clone())
            .with_sandbox_id(id)
            .with_profile_name(fixture::PROFILE)
            .with_rootfs_hash(&context.rootfs_hash)
            .with_history_generation_run_id(run)
            .with_restored_session_identity(identity)
            .with_storage_fingerprints(prepared.storage)
            .build();
        if let Err(e) = candidate.capture_retirement_backing() {
            self.proof.retain(candidate);
            return Err(e.into());
        }
        Ok(transitions::PreparedIncoming {
            candidate,
            backing,
            receipt,
        })
    }

    fn active(&self) -> TestResult<bool> {
        let witness = self
            .incoming_lease
            .as_ref()
            .ok_or_else(|| failure("dual incoming witness missing"))?;
        if !witness.is_active() || witness.resources() != (2, 4096) {
            return Err(failure("dual incoming original full lease lost"));
        }
        Ok(true)
    }

    pub async fn before_incoming_retirement(
        &mut self,
        context: &transitions::Context,
        inputs: &fixture::Inputs,
    ) -> TestResult<()> {
        self.active()?;
        self.restore(
            context,
            inputs,
            &self.original_fixture,
            &self.original,
            "original_restored",
        )
        .await?;
        self.active()?;
        let previous = self
            .incoming
            .as_ref()
            .ok_or_else(|| failure("dual incoming history missing"))?;
        let run = RunId::new_v4();
        let reservation = context
            .pool
            .lock()
            .await
            .take_reserved(&context.reuse_key)
            .ok_or_else(|| failure("dual incoming reservation missing"))?;
        let mut owner = match IdleActivationOwner::new(reservation) {
            Ok(o) => o,
            Err(o) => {
                self.proof.retain(o);
                return Err(failure("dual incoming became a running handoff"));
            }
        };
        let (idle, lease) = match owner.activate(run).await {
            Ok(o) => o,
            Err(e) => {
                self.proof.retain(owner);
                return Err(io::Error::other(e).into());
            }
        };
        if let Err(error) = self.active() {
            self.proof.retain(idle);
            self.proof.retain(lease);
            return Err(error);
        }
        let result = self
            .incoming_fixture
            .execute_reused(
                continuation::Execution {
                    factory: context.factory.clone(),
                    operations: context.operations.clone(),
                    inputs,
                    run,
                    id: previous.id,
                    key: context.reuse_key.clone(),
                    history: previous.bytes.clone(),
                    original: previous.original,
                    continued: true,
                },
                idle,
            )
            .await;
        let mut prepared = match result {
            Ok(p) => p,
            Err(e) => {
                self.proof.retain(lease);
                return Err(e);
            }
        };
        let checked: TestResult<_> = async {
            self.verify_payload(&*prepared.sandbox,previous).await?;
            let backing=prepared.sandbox.backing_process().ok_or_else(||failure("dual reused backing missing"))?;
            if backing.identity().generation().to_string()!=previous.backing || prepared.home.cache_key()!=Some(self.cache_key.as_str())
                || self.incoming_fixture.session()?.0!=previous.thread || prepared.history.len()<=previous.bytes.len() {
                return Err(failure("dual continuation changed physical owner/cache/thread or lost history"));
            }
            let private=quote_shell_arg(&fixture::runtime_dir(run)?);
            fixture::exec(&*prepared.sandbox,&format!("mkdir -p {private} && chmod 700 {private} && printf 'dual continuation private bytes' > {private}/dual-private && chmod 600 {private}/dual-private")).await?;
            if prepared.sandbox.park().await?!=SandboxParkOutcome::Reusable{return Err(failure("dual continued incoming failed to park"));}
            self.proof.dual_history_witness("incoming_continued",json!({
                "run_id":run,"previous_run_id":previous.generation,"sandbox_id":previous.id,"backing_generation":previous.backing,
                "thread_id":previous.thread,"history_hex":hex::encode(&prepared.history),"original_history_hex":hex::encode(&previous.bytes),
                "cache_key":self.cache_key,"same_full_lease_active":self.active()?,"active_checkout":"Miss",
                "actual_executor_reuse":true,"final_identity_verified":prepared.identity.is_some(),"allocated":context.budget.allocated(),
            }))?;
            Ok(backing)
        }.await;
        let _backing = match checked {
            Ok(b) => b,
            Err(e) => {
                self.proof.retain(prepared);
                self.proof.retain(lease);
                return Err(e);
            }
        };
        let history = History {
            original: previous.original,
            generation: run,
            id: previous.id,
            backing: previous.backing.clone(),
            thread: previous.thread.clone(),
            bytes: prepared.history.clone(),
            private: vec![previous.original, run],
        };
        let Some(identity) = prepared.identity.take() else {
            self.proof.retain(prepared);
            self.proof.retain(lease);
            return Err(failure("dual continued identity missing"));
        };
        let promotion = prepared
            .home
            .into_promotion_context(HomeImagePromotionRequest {
                run_id: run,
                sandbox_id: history.id,
                restored_session_identity: Some(&identity),
                terminal_status: HomeCacheTerminalStatus::Success,
                completed_at: chrono::Utc::now().to_rfc3339(),
                storage_fingerprints: prepared.storage.clone(),
            });
        let Some(promotion) = promotion else {
            self.proof.retain(prepared.sandbox);
            self.proof.retain(lease);
            return Err(failure("dual continued promotion unavailable"));
        };
        let mut candidate = ParkedIdleCandidateBuilder::new(&context.reuse_key, lease)
            .with_sandbox(prepared.sandbox)
            .with_factory(context.factory.clone())
            .with_sandbox_id(history.id)
            .with_profile_name(fixture::PROFILE)
            .with_rootfs_hash(&context.rootfs_hash)
            .with_history_generation_run_id(run)
            .with_storage_fingerprints(prepared.storage)
            .with_restored_session_identity(identity)
            .with_home_promotion(promotion)
            .build();
        if let Err(e) = candidate.capture_retirement_backing() {
            self.proof.retain(candidate);
            return Err(e.into());
        }
        let mut incoming = IdlePoolIncoming::park(candidate);
        let inserted = context
            .tracker
            .insert_pool_entry(
                &context.pool,
                &mut incoming,
                &context.operations,
                inputs.envelope(),
                "native_dual_continued_repark",
            )
            .await;
        if let Some(owner) = incoming.into_owner() {
            self.proof.retain(owner);
            return Err(failure("dual continued incoming custody not transferred"));
        }
        let inserted = inserted?;
        if inserted.retirement.is_some() {
            self.proof.retain(inserted);
            return Err(failure(
                "dual continued repark unexpectedly replaced an owner",
            ));
        }
        self.incoming = Some(history);
        Ok(())
    }

    pub async fn after_incoming_retirement(
        &self,
        context: &transitions::Context,
        inputs: &fixture::Inputs,
    ) -> TestResult<()> {
        if self
            .incoming_lease
            .as_ref()
            .is_none_or(BudgetLeaseWitness::is_active)
        {
            return Err(failure(
                "dual incoming lease not released after required saving",
            ));
        }
        self.restore(
            context,
            inputs,
            &self.incoming_fixture,
            self.incoming
                .as_ref()
                .ok_or_else(|| failure("dual saved incoming history missing"))?,
            "incoming_restored",
        )
        .await
    }

    async fn verify_payload(
        &self,
        sandbox: &dyn sandbox::Sandbox,
        history: &History,
    ) -> TestResult<(Vec<u8>, Vec<u8>, Vec<u8>)> {
        let home = fixture::exec(sandbox, "cat /home/user/guarded-idle-payload").await?;
        let workspace = fixture::exec(sandbox, &format!("cat {WORKSPACE}")).await?;
        let ordinary = fixture::exec(sandbox, "cat /home/user/guarded-idle-ordinary").await?;
        let expected = fixture::home_payload(history.original);
        if home != expected || workspace != expected || ordinary != b"native ordinary home bytes" {
            return Err(failure("dual complete home/workspace bytes changed"));
        }
        Ok((home, workspace, ordinary))
    }

    async fn restore(
        &self,
        context: &transitions::Context,
        inputs: &fixture::Inputs,
        fixture: &Arc<continuation::Fixture>,
        history: &History,
        phase: &str,
    ) -> TestResult<()> {
        let tracker = IdleDestroyTracker::new(Arc::new(Notify::new()));
        self.proof.retain(tracker.clone());
        let status = Arc::new(StatusTracker::new(
            self.directory.join(format!("{phase}-status.json")),
            1,
            None,
            None,
        ));
        status.write_initial().await?;
        let lease = ResourceBudget::try_reserve_lease(&context.budget, 2, 4096)
            .ok_or_else(|| failure("dual restoration lease unavailable"))?;
        let Some(witness) = lease.witness() else {
            self.proof.retain(lease);
            return Err(failure("dual restoration lease witness missing"));
        };
        let run = RunId::new_v4();
        let id = SandboxId::new_v4();
        let result = fixture
            .execute(continuation::Execution {
                factory: context.factory.clone(),
                operations: context.operations.clone(),
                inputs,
                run,
                id,
                key: context.reuse_key.clone(),
                history: history.bytes.clone(),
                original: history.original,
                continued: true,
            })
            .await;
        let prepared = match result {
            Ok(p) => p,
            Err(e) => {
                self.proof.retain(lease);
                return Err(e);
            }
        };
        let backing = prepared.sandbox.backing_process();
        let checked:TestResult<()> = async {
            let (home,workspace,ordinary)=self.verify_payload(&*prepared.sandbox,history).await?;
            for private in &history.private {fixture::exec(&*prepared.sandbox,&format!("test ! -e {}",quote_shell_arg(&fixture::runtime_dir(*private)?))).await?;}
            let generation=&prepared.home.history_proof_binding().ok_or_else(||failure("dual restored history binding missing"))?.proof.generation;
            if generation!=&history.generation.to_string() || prepared.home.cache_key()!=Some(self.cache_key.as_str()) {return Err(failure("dual restored the wrong physical entry/generation"));}
            let prefix=prepared.history.get(..history.bytes.len()).ok_or_else(||failure("dual restored prefix truncated"))?;
            if prefix!=history.bytes{return Err(failure("dual complete original history changed"));}
            self.proof.dual_history_witness(phase,json!({
                "source_run_id":history.generation,"original_run_id":history.original,"source_sandbox_id":history.id,
                "restoration_run_id":run,"restoration_sandbox_id":id,"thread_id":history.thread,"cache_key":self.cache_key,
                "restoration_backing_generation":backing.as_ref().ok_or_else(||failure("dual restoration backing missing"))?.identity().generation().to_string(),
                "history_hex":hex::encode(&history.bytes),"restored_history_hex":hex::encode(prefix),
                "home_hex":hex::encode(home),"workspace_hex":hex::encode(workspace),"ordinary_hex":hex::encode(ordinary),
                "private_generations_removed":history.private,
                "history_proof_generation":generation,"cache_hit":prepared.home.is_cache_hit(),"allocated":context.budget.allocated(),
            }))?;
            Ok(())
        }.await;
        if let Err(e) = checked {
            self.proof.retain(prepared);
            self.proof.retain(lease);
            return Err(e);
        }
        let request = continuation::Saving {
            factory: context.factory.clone(),
            operations: &context.operations,
            inputs,
            budget: &context.budget,
            tracker: &tracker,
            status: &status,
            key: &context.reuse_key,
            original: history.original,
            history: &history.bytes,
        };
        fixture
            .save_prepared(&request, run, id, prepared, lease)
            .await?;
        tracker.close_and_wait().await;
        let owners = tracker.take_retained_activation_owners()?;
        if !owners.is_empty() {
            self.proof.retain(owners);
            return Err(failure("dual restoration retained required cleanup"));
        }
        let backing = backing.ok_or_else(|| failure("dual restoration backing disappeared"))?;
        if !backing.exit_confirmed().await || witness.is_active() {
            return Err(failure(
                "dual restoration saving lost positive exit/full-lease release",
            ));
        }
        self.proof.dual_history_witness(&format!("{phase}_joined"),json!({
            "restoration_run_id":run,"restoration_sandbox_id":id,
            "restoration_backing_generation":backing.identity().generation().to_string(),
            "backing_exit_confirmed":true,"home_cache_promoted":true,"full_lease_released":true,
            "tracker_joined":true,"remaining_activation_owners":0,"allocated":context.budget.allocated(),
        }))?;
        Ok(())
    }
}
