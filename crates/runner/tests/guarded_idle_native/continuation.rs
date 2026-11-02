//! Complete native session bytes through the public Executor and real saving.

use std::{collections::HashMap, sync::Arc};

use runner_executor::{
    executor::{self, ExecutorConfig, JobParams, NewSandboxDispatch},
    pre_spawn_admission::PreSpawnAdmission,
};
use runner_host::paths::{HomePaths, LogPaths, RunnerPaths};
use runner_lifecycle::{
    home_image_cache::{
        HomeCacheTerminalStatus, HomeImageCache, HomeImageLease, HomeImagePromotionRequest,
    },
    host_memory_operations::{HostMemoryOperations, MemoryOperationError},
    idle_pool::{
        ActivationCleanupOutcome, IdlePool, IdlePoolConfig, IdleRetirementBatchScope, ParkResult,
        test_support::ParkedIdleCandidateBuilder,
    },
    resource_budget::ResourceBudget,
    restored_session_identity::RestoredSessionIdentity,
};
use runner_network::{
    network_log_drain::NetworkLogDrainCoordinator, network_log_manager::NetworkLogManager,
    network_logs::NetworkLogUploadHealthTracker, proxy::ProxyRegistryHandle,
};
use runner_provider::http::{HttpClient, HttpClientConfig};
use runner_storage::{
    storage_cache::{
        FreshArchiveDeliveryAdmission, StorageCacheBackgroundFillCoordinator, decoded::DecodedCache,
    },
    storage_fingerprints::StorageFingerprints,
};
use runner_supervisor::idle_lifecycle::{IdleDestroyTracker, IdlePoolRetirementRequest};
use runner_types::{
    ids::RunId,
    storage_manifest::{ArtifactEntry, StorageManifest},
    types::{ExecutionContext, SandboxReuseResult},
};
use sandbox::{Sandbox, SandboxFactory, SandboxId, SandboxParkOutcome};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use shell_quote::quote_shell_arg;
use tokio_util::sync::CancellationToken;

use super::{
    TestResult,
    continuation_api::{Api, TOKEN},
    evidence, fixture, io,
};

pub const SEED: &[u8] = b"";

pub struct Prepared {
    pub sandbox: Box<dyn Sandbox>,
    pub home: HomeImageLease,
    pub identity: Option<RestoredSessionIdentity>,
    pub history: Vec<u8>,
    pub storage: StorageFingerprints,
    pub exit_code: i32,
    pub preparation: Preparation,
}

pub struct Preparation {
    pub operation_id: String,
    pub grant_started_ns: u64,
    pub grant_finished_ns: u64,
}

pub struct Fixture {
    api: Api,
    config: ExecutorConfig,
    rootfs_hash: String,
    case: Arc<evidence::Case>,
    nonzero: bool,
    workspace_artifact: Option<ArtifactEntry>,
}

pub struct Execution<'a> {
    pub factory: Arc<Box<dyn SandboxFactory>>,
    pub operations: HostMemoryOperations,
    pub inputs: &'a fixture::Inputs,
    pub run: RunId,
    pub id: SandboxId,
    pub key: String,
    pub history: Vec<u8>,
    pub original: RunId,
    pub continued: bool,
}

pub struct Saving<'a> {
    pub factory: Arc<Box<dyn SandboxFactory>>,
    pub operations: &'a HostMemoryOperations,
    pub inputs: &'a fixture::Inputs,
    pub budget: &'a Arc<ResourceBudget>,
    pub tracker: &'a IdleDestroyTracker,
    pub status: &'a Arc<runner_lifecycle::status::StatusTracker>,
    pub key: &'a str,
    pub original: RunId,
    pub history: &'a [u8],
}

impl Fixture {
    pub(super) fn session(&self) -> TestResult<(String, String)> {
        self.api.session(None)
    }

    pub async fn new(
        paths: &RunnerPaths,
        cache: HomeImageCache,
        rootfs_hash: String,
        case: Arc<evidence::Case>,
        nonzero: bool,
    ) -> TestResult<Arc<Self>> {
        Self::new_with_workspace(
            paths,
            cache,
            rootfs_hash,
            case,
            nonzero,
            Some(ArtifactEntry {
                mount_path: "/home/user/workspace".into(),
                vas_storage_name: "workspace".into(),
                vas_storage_id: "native-workspace".into(),
                vas_version_id: "native-empty-version".into(),
                archive_url: None,
                archive_size: None,
                empty: Some(true),
                missing_root_policy: None,
            }),
        )
        .await
    }

    /// Keep the ordinary workspace directory under the required home owner.
    pub(super) async fn new_with_home_workspace(
        paths: &RunnerPaths,
        cache: HomeImageCache,
        rootfs_hash: String,
        case: Arc<evidence::Case>,
        nonzero: bool,
    ) -> TestResult<Arc<Self>> {
        Self::new_with_workspace(paths, cache, rootfs_hash, case, nonzero, None).await
    }

    async fn new_with_workspace(
        paths: &RunnerPaths,
        cache: HomeImageCache,
        rootfs_hash: String,
        case: Arc<evidence::Case>,
        nonzero: bool,
        workspace_artifact: Option<ArtifactEntry>,
    ) -> TestResult<Arc<Self>> {
        if std::env::var("USE_MOCK_CODEX").as_deref() != Ok("true") {
            return Err(io::Error::other(
                "native continuation requires explicit USE_MOCK_CODEX=true",
            )
            .into());
        }
        let api = Api::start().await?;
        let root = paths.base_dir();
        let registry = root.join("continuation-registry.json");
        tokio::fs::write(&registry, br#"{"sandboxes":{},"updatedAt":0}"#).await?;
        let logs = root.join("continuation-logs");
        tokio::fs::create_dir_all(&logs).await?;
        let home = HomePaths::with_root(root.to_owned());
        let config = ExecutorConfig {
            api_url: api.url.clone(),
            runner_hostname: None,
            registry: ProxyRegistryHandle::new(registry, root.join("continuation-registry.lock")),
            http: HttpClient::new(HttpClientConfig {
                api_url: api.host_url.clone(),
                vercel_bypass: None,
                client_session_id: "native-continuation".into(),
                runner_version: env!("CARGO_PKG_VERSION"),
            })?,
            log_paths: LogPaths::new(logs),
            network_log_manager: NetworkLogManager::new(),
            network_log_drain: NetworkLogDrainCoordinator::noop(),
            network_log_upload_health: NetworkLogUploadHealthTracker::new(),
            mitm_jsonl_flush: None,
            connector_runtime_sync: None,
            guest_rpc: None,
            content_bundle_cache: runner_storage::content_bundle_cache::ContentBundleCache::new(
                home.bundles_dir(),
            )?,
            fresh_archive_delivery: FreshArchiveDeliveryAdmission::new(),
            background_fill: StorageCacheBackgroundFillCoordinator::new()?,
            decoded_cache: DecodedCache::new(home.clone()),
            pre_spawn_admission: PreSpawnAdmission::new(2)?,
            home,
            home_cache: Some(cache),
        };
        Ok(Arc::new(Self {
            api,
            config,
            rootfs_hash,
            case,
            nonzero,
            workspace_artifact,
        }))
    }

    fn context(
        &self,
        run: RunId,
        key: &str,
        history: &[u8],
        original: RunId,
        continued: bool,
    ) -> TestResult<ExecutionContext> {
        let mut context =
            runner_executor::test_fixtures::execution_context::execution_context_for_test(run);
        context.cli_agent_type = "codex".into();
        context.reuse_key = Some(key.into());
        context.sandbox_token = TOKEN.into();
        context.real_agent_in_preview = Some(false);
        context.environment = Some(HashMap::from([
            (
                "HOME".into(),
                api_contracts::generated::constants::runners::paths::CANONICAL_GUEST_HOME_DIR
                    .into(),
            ),
            (
                "MOCK_CODEX_APP_SERVER_SCENARIO".into(),
                if !continued && self.nonzero {
                    "runtime-turn-failed"
                } else {
                    "runtime-turn-complete"
                }
                .into(),
            ),
            (
                "MOCK_CODEX_SESSION_TIMESTAMP".into(),
                "2026-06-04T07:18:08.000Z".into(),
            ),
        ]));
        let previous = if continued {
            Some(self.api.session(None)?)
        } else {
            None
        };
        context.native_continuation = Some(guest_contracts::env::NativeContinuation {
            session_id: previous.as_ref().map(|(id, _)| id.clone()),
            generation_run_id: previous.map(|(_, run)| run),
            recovery_prompt: None,
        });
        context.storage_manifest = Some(StorageManifest {
            storages: Vec::new(),
            artifacts: self.workspace_artifact.iter().cloned().collect(),
        });
        let observation = format!("/home/user/native-continuation-{run}.json");
        let source = format!(
            "import hashlib,json,pathlib,subprocess; files=list(pathlib.Path('/home/user/.codex/sessions/2026/06/04').glob('rollout-*.jsonl*')); assert len(files)==1; p=files[0]; thread=p.name.removesuffix('.zst').removesuffix('.jsonl')[-36:]; z=pathlib.Path(str(p)+'.zst'); data=p.read_bytes() if p.suffix!='.zst' else subprocess.check_output(['zstd','-d','--stdout',str(p)]); prefix=data[:{size}]; assert hashlib.sha256(prefix).hexdigest()=={hash:?}; home=pathlib.Path('/home/user/guarded-idle-payload'); expected=({original:?}.encode()*2048)[:65536]; {home_action}; pathlib.Path({observation:?}).write_text(json.dumps({{'thread':thread,'prefix_sha256':hashlib.sha256(prefix).hexdigest(),'prefix_bytes':len(prefix),'home_sha256':hashlib.sha256(home.read_bytes()).hexdigest()}}))",
            size = history.len(),
            hash = digest(history),
            original = original.to_string(),
            home_action = if continued {
                "assert home.read_bytes()==expected"
            } else {
                "home.write_bytes(expected)"
            },
        );
        context.prompt = format!(
            "@shell@\npython3 -I -c {}\n@end-shell@",
            quote_shell_arg(&source)
        );
        Ok(context)
    }

    pub async fn execute(self: &Arc<Self>, request: Execution<'_>) -> TestResult<Prepared> {
        self.execute_dispatch(request, None).await
    }

    pub async fn execute_reused(
        self: &Arc<Self>,
        request: Execution<'_>,
        idle: Box<runner_lifecycle::idle_pool::ReusableIdleSandbox>,
    ) -> TestResult<Prepared> {
        self.execute_dispatch(request, Some(idle)).await
    }

    async fn execute_dispatch(
        self: &Arc<Self>,
        request: Execution<'_>,
        idle: Option<Box<runner_lifecycle::idle_pool::ReusableIdleSandbox>>,
    ) -> TestResult<Prepared> {
        let Execution {
            factory,
            operations,
            inputs,
            run,
            id,
            key,
            history,
            original,
            continued,
        } = request;
        let reused = idle.is_some();
        // Admission or task registration may refuse before invoking the work.
        // Keep the already live reused Guest owned across either refusal.
        let custody = Arc::new(std::sync::Mutex::new(idle));
        if reused {
            self.case.retain(custody.clone());
        }
        let grant_started_ns = evidence::clocks()?.0;
        let mut request = operations.request(inputs.replacement_plan()?)?;
        let permit = request.try_grant().await?;
        let preparation = Preparation {
            operation_id: permit
                .id()
                .ok_or_else(|| io::Error::other("native preparation permit missing"))?
                .generation()
                .to_string(),
            grant_started_ns,
            grant_finished_ns: evidence::clocks()?.0,
        };
        let context = self.context(run, &key, &history, original, continued)?;
        let previous_generation = context
            .native_continuation
            .as_ref()
            .and_then(|native| native.generation_run_id.clone());
        let previous_session_hash = context
            .native_continuation
            .as_ref()
            .and_then(|native| native.session_id.as_deref())
            .map(|id| digest(id.as_bytes()));
        let previous_history_hash = digest(&history);
        let previous_history_size = history.len() as u64;
        let storage = StorageFingerprints::from_manifest(
            context
                .storage_manifest
                .as_ref()
                .ok_or_else(|| io::Error::other("native storage manifest missing"))?,
        );
        let this = self.clone();
        let connection_scope = guest_control_client::test_support::ConnectionScope::current();
        let work = permit.spawn(move |mut operation| {
          let execution = async move {
            let idle = custody.lock().map_err(|_| io::Error::other("native reused custody poisoned"))?.take();
            let params = JobParams { required_home_source_run_id: None, profile_name: fixture::PROFILE.into(), vcpu: 2, memory_mb: 4096, home_disk_mb: fixture::HOME_DISK_MB, rootfs_hash: this.rootfs_hash.clone(), restore_guest_state: true, device_rate_limits: None, home_image_prepare_policy: Default::default() };
            let (mut outcome, _telemetry) = if let Some(idle) = idle {
                executor::execute_job_reuse_with_hooks(
                    executor::ReusedSandboxDispatch {
                        factory: &**factory, idle_sandbox: *idle,
                        reuse_result: SandboxReuseResult::Reused,
                    }, context, &this.config, &params,
                    runner_provider::RunCancellationSignals::from_hard_token(CancellationToken::new()),
                    executor::ExecutionHooks {
                        sandbox_recovery: None,
                        sandbox_prepared: None, active_input_source: None, pre_spawn_timing: None,
                    },
                ).await
            } else { executor::execute_job_with_prepared_notifier(
                &**factory, context, NewSandboxDispatch { id, reuse_result: SandboxReuseResult::PoolMiss },
                &this.config, &params,
                runner_provider::RunCancellationSignals::from_hard_token(CancellationToken::new()),
                executor::ExecutionHooks {
                    sandbox_recovery: None,
                    sandbox_prepared: None, active_input_source: None, pre_spawn_timing: None,
                },
            ).await };
            let checked: TestResult<(Vec<u8>, Option<RestoredSessionIdentity>)> = async {
                let expected_exit = if !continued && this.nonzero {1} else {0};
                if outcome.exit_code()!=expected_exit || !outcome.sandbox_reuse_disposition.is_eligible() {
                    return Err(io::Error::other(format!("native Executor did not positively finish: {:?} {:?}", outcome.failure, outcome.sandbox_reuse_disposition)).into());
                }
                let sandbox = outcome.sandbox.as_ref().ok_or_else(|| io::Error::other("native Executor returned no live owner"))?;
                let backing = sandbox.backing_process().ok_or_else(|| io::Error::other("native Executor returned no backing"))?;
                operation.bind_backing(backing)?;
                loop {
                    match operation.complete_phase().await {
                        Ok(()) => break,
                        Err(MemoryOperationError::AccountingChanged) => tokio::task::yield_now().await,
                        Err(error) => return Err(error.into()),
                    }
                }
                let (thread,_) = this.api.session(Some(&run.to_string()))?;
                let command = format!("python3 -I -c {}", quote_shell_arg(&format!("import pathlib,subprocess,sys; files=list(pathlib.Path('/home/user/.codex/sessions/2026/06/04').glob('*{thread}.jsonl*')); assert len(files)==1; p=files[0]; sys.stdout.buffer.write(p.read_bytes() if p.suffix!='.zst' else subprocess.check_output(['zstd','-d','--stdout',str(p)]))")));
                let complete = fixture::exec(&**sandbox, &command).await?;
                if !complete.starts_with(&history) {
                    return Err(io::Error::other("native continuation lost complete original history bytes").into());
                }
                let identity = outcome.restored_session_identity.as_ref();
                if expected_exit == 0 {
                    let identity = identity.ok_or_else(|| io::Error::other("native final verified session identity missing"))?;
                    let verification = identity.final_metadata_verification().ok_or_else(|| io::Error::other("native final identity has no verifier provenance"))?;
                    if verification.history_hash!=digest(&complete) || verification.history_size_bytes!=complete.len() as u64
                        || verification.session_id_hash!=digest(thread.as_bytes()) {
                        return Err(io::Error::other("native final identity does not bind complete bytes/thread").into());
                    }
                } else if identity.is_some() {
                    return Err(io::Error::other("failed native execution returned a reusable session identity").into());
                }
                let probe_path = format!("/home/user/native-continuation-{run}.json");
                let probe = fixture::exec(&**sandbox, &format!("cat {}", quote_shell_arg(&probe_path))).await?;
                let probe: Value = serde_json::from_slice(&probe)?;
                let home = fixture::home_payload(original);
                if probe != json!({"thread":thread,"prefix_sha256":digest(&history),"prefix_bytes":history.len(),"home_sha256":digest(&home)}) {
                    return Err(io::Error::other("native process did not observe original full prepared data").into());
                }
                Ok((complete, identity.cloned()))
            }.await;
            let (history, identity) = match checked {
                Ok(value) => value,
                Err(error) => { this.case.retain(outcome); this.case.retain(factory); this.case.retain(this.clone()); return Err(error); }
            };
            if let Some(report) = outcome.startup_report.take() { report.finish().await; }
            let exit_code = outcome.exit_code();
            let Some(sandbox) = outcome.sandbox.take() else {
                this.case.retain(outcome);
                return Err(io::Error::other("native live owner disappeared").into());
            };
            let Some(home) = outcome.home_image.take() else {
                this.case.retain(sandbox);
                this.case.retain(outcome);
                return Err(io::Error::other("native home lease disappeared").into());
            };
            if continued && !reused {
                // Acknowledged nonzero execution can finalize local history too.
                // Executor still withholds its reusable identity, while terminal
                // preparation independently verifies those bytes for the cache.
                let bound = home.history_proof_binding().is_some_and(|binding| {
                    let identity = &binding.proof.identity;
                    Some(binding.proof.generation.as_str()) == previous_generation.as_deref()
                        && identity.history_hash == previous_history_hash
                        && identity.history_size_bytes == previous_history_size
                        && Some(identity.session_id_hash.as_str()) == previous_session_hash.as_deref()
                        && binding.proof.to_json_vec().is_ok_and(|bytes| digest(&bytes) == binding.sha256)
                });
                if !home.is_cache_hit() || !bound {
                    this.case.retain(sandbox); this.case.retain(home);
                    return Err(io::Error::other("native continuation did not use verified saved home/history").into());
                }
            }
            if reused && (!matches!(home.result(), runner_lifecycle::home_image_cache::HomeCacheCheckoutResult::Miss)
                || home.is_cache_hit()) {
                this.case.retain(sandbox); this.case.retain(home);
                return Err(io::Error::other("native reused continuation did not acquire its active entry lease").into());
            }
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(Prepared { sandbox, home, identity, history, storage, exit_code, preparation })
          };
          async move {
            match connection_scope {
                Some(scope) => scope.scope(execution).await,
                None => execution.await,
            }
          }
        })?;
        work.join().await?
    }

    pub fn record_original(&self, run: RunId, prepared: &Prepared) -> TestResult<()> {
        self.case.continuation_witness("original_executor_completed", json!({
            "original_run_id":run.to_string(),"thread_id":self.api.session(None)?.0,
            "seed_history_sha256":digest(SEED),"seed_history_bytes":SEED.len(),
            "original_history_sha256":digest(&prepared.history),"original_history_bytes":prepared.history.len(),
            "original_home_sha256":digest(&fixture::home_payload(run)),"original_home_bytes":fixture::PAYLOAD_BYTES,
            "exit_code":prepared.exit_code,"final_identity_verified":prepared.identity.is_some(),
            "reusable_identity_withheld_after_nonzero":prepared.exit_code != 0 && prepared.identity.is_none(),"full_original_prefix_verified":true,
            "preparation_observed_by_native_process":true,"original_full_lease_witness":true,
        }))?;
        Ok(())
    }

    pub async fn continue_and_save(self: &Arc<Self>, request: Saving<'_>) -> TestResult<()> {
        let mut history = request.history.to_vec();
        // Reopen the resulting saved image through Executor too. A read-only
        // Guest has no new verified identity and would erase the final cache
        // binding when its consumed image is promoted.
        for generation in 0..2 {
            let lease = ResourceBudget::try_reserve_lease(request.budget, 2, 4096)
                .ok_or_else(|| io::Error::other("continued native full lease unavailable"))?;
            let run = RunId::new_v4();
            let id = SandboxId::new_v4();
            let result = self
                .execute(Execution {
                    factory: request.factory.clone(),
                    operations: request.operations.clone(),
                    inputs: request.inputs,
                    run,
                    id,
                    key: request.key.into(),
                    history: history.clone(),
                    original: request.original,
                    continued: true,
                })
                .await;
            let prepared = match result {
                Ok(prepared) => prepared,
                Err(error) => {
                    self.case.retain(lease);
                    return Err(error);
                }
            };
            let checked: TestResult<()> = async {
                fixture::verify_saved_guest(&*prepared.sandbox, request.original).await?;
                if prepared.history.len() <= history.len() {
                    return Err(io::Error::other("native continuation did not extend complete history").into());
                }
                if generation == 0 {
                    self.case.continuation_witness("continued_executor_completed", json!({
                        "continued_run_id":run.to_string(),"continued_sandbox_id":id.to_string(),
                        "thread_id":self.api.session(None)?.0,"restored_history_sha256":digest(&history),"restored_history_bytes":history.len(),
                        "continued_history_sha256":digest(&prepared.history),"continued_history_bytes":prepared.history.len(),
                        "original_home_sha256":digest(&fixture::home_payload(request.original)),"original_home_bytes":fixture::PAYLOAD_BYTES,
                        "exit_code":prepared.exit_code,"final_identity_verified":true,"full_original_prefix_verified":true,
                        "preparation_observed_by_native_process":true,"home_cache_hit":true,"history_proof_bound":prepared.home.history_proof_binding().is_some(),
                    }))?;
                }
                Ok(())
            }.await;
            if let Err(error) = checked {
                self.case.retain(prepared);
                self.case.retain(lease);
                return Err(error);
            }
            history = prepared.history.clone();
            self.save_prepared(&request, run, id, prepared, lease)
                .await?;
        }
        self.case.continuation_witness(
            "continued_saving_completed",
            json!({"required_cleanup_joined":true,"complete_continued_bytes_restored":true,"verified_final_identity_preserved":true}),
        )?;
        Ok(())
    }

    pub(super) async fn save_prepared(
        &self,
        request: &Saving<'_>,
        run: RunId,
        id: SandboxId,
        mut prepared: Prepared,
        lease: runner_lifecycle::resource_budget::BudgetLease,
    ) -> TestResult<()> {
        let checked: TestResult<()> = async {
            if !matches!(
                prepared.home.result(),
                runner_lifecycle::home_image_cache::HomeCacheCheckoutResult::Hit
                    | runner_lifecycle::home_image_cache::HomeCacheCheckoutResult::Miss
            ) {
                return Err(
                    io::Error::other("native required home promotion is unavailable").into(),
                );
            }
            if prepared.sandbox.park().await? != SandboxParkOutcome::Reusable {
                return Err(io::Error::other("continued native Guest could not park").into());
            }
            Ok(())
        }
        .await;
        if let Err(error) = checked {
            self.case.retain(prepared);
            self.case.retain(lease);
            return Err(error);
        }
        let Some(identity) = prepared.identity.clone() else {
            self.case.retain(prepared);
            self.case.retain(lease);
            return Err(
                io::Error::other("successful native saving has no verified identity").into(),
            );
        };
        let storage = prepared.storage.clone();
        let promotion = prepared
            .home
            .into_promotion_context(HomeImagePromotionRequest {
                run_id: run,
                sandbox_id: id,
                restored_session_identity: Some(&identity),
                terminal_status: HomeCacheTerminalStatus::Success,
                completed_at: chrono::Utc::now().to_rfc3339(),
                storage_fingerprints: prepared.storage,
            });
        let Some(promotion) = promotion else {
            self.case.retain(prepared.sandbox);
            self.case.retain(lease);
            return Err(io::Error::other("native required promotion context missing").into());
        };
        let pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
            max_idle: 0,
        })));
        let mut candidate = ParkedIdleCandidateBuilder::new(request.key, lease)
            .with_source_run_id(run)
            .with_sandbox(prepared.sandbox)
            .with_factory(request.factory.clone())
            .with_sandbox_id(id)
            .with_profile_name(fixture::PROFILE)
            .with_rootfs_hash(&self.rootfs_hash)
            .with_source_run_id(run)
            .with_native_generation_run_id(run)
            .with_restored_session_identity(identity)
            .with_storage_fingerprints(storage)
            .with_home_promotion(promotion)
            .build();
        if let Err(error) = candidate.capture_retirement_backing() {
            self.case.retain(candidate);
            return Err(error.into());
        }
        match pool.lock().await.park(candidate) {
            ParkResult::Parked => {}
            other => {
                self.case.retain(other);
                self.case.retain(pool.clone());
                return Err(io::Error::other("continued native owner was not parked").into());
            }
        }
        self.case.retain(pool.clone());
        let selections = pool
            .lock()
            .await
            .retirement_batch(IdleRetirementBatchScope::All);
        if selections.len() != 1 {
            return Err(
                io::Error::other("continued native required owner selection changed").into(),
            );
        }
        let selected = selections
            .into_iter()
            .next()
            .ok_or_else(|| io::Error::other("continued native required owner missing"))?;
        let (_, _, candidate) = selected.into_parts();
        let mut task = request
            .tracker
            .retire_pool_entry(
                &pool,
                request.operations,
                IdlePoolRetirementRequest {
                    candidate: candidate?,
                    envelope: request.inputs.envelope(),
                    context: "native_complete_continuation",
                },
            )
            .await?
            .task;
        let outcome = match task.join().await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(error)) => {
                self.case.retain(task);
                return Err(error.into());
            }
            Err(error) => {
                self.case.retain(task);
                return Err(error.into());
            }
        };
        if !matches!(
            outcome,
            ActivationCleanupOutcome::Completed {
                home_cache_promoted: true
            }
        ) {
            self.case.retain(task);
            return Err(io::Error::other(format!(
                "continued native saving did not preserve its verified cache identity: {outcome:?}"
            ))
            .into());
        }
        let snapshot = pool.lock().await.status_snapshot();
        if let Err(error) = request.status.set_idle_snapshot(snapshot).await {
            self.case.retain(task);
            return Err(error.into());
        }
        match task.take_completed_lease() {
            Ok(lease) => drop(lease),
            Err(error) => {
                self.case.retain(task);
                return Err(error.into());
            }
        }
        Ok(())
    }

    pub async fn finish(self) -> TestResult<()> {
        self.api.finish().await
    }
}

pub fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
