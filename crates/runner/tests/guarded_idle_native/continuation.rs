//! Complete native session bytes through the public Executor and real saving.

use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};

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
        IdlePool, IdlePoolConfig, IdleRetirementBatchScope, ParkResult,
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
use runner_supervisor::idle_lifecycle::{IdleDestroyTracker, IdlePoolBatchRetirementRequest};
use runner_types::{
    ids::RunId,
    storage_manifest::{ArtifactEntry, StorageManifest},
    types::{
        ExecutionContext, ResumeSession, ResumeSessionHistory, ResumeSessionHistoryEncoding,
        ResumeSessionHistoryRef, ResumeSessionHistoryRefKind, SandboxReuseResult,
    },
};
use sandbox::{CopyFileOptions, Sandbox, SandboxFactory, SandboxId, SandboxParkOutcome};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use shell_quote::quote_shell_arg;
use tokio_util::sync::CancellationToken;

use super::{
    TestResult,
    continuation_api::{Api, TOKEN},
    evidence, fixture, io,
};

pub const THREAD: &str = "019e9154-c304-70f0-adde-36efb1be1701";
pub const SEED: &[u8] = include_bytes!("continuation_history.jsonl");
const HISTORY_PATH: &str = "/home/user/.codex/sessions/2026/06/04/rollout-2026-06-04T07-18-08-019e9154-c304-70f0-adde-36efb1be1701.jsonl";

pub struct Prepared {
    pub sandbox: Box<dyn Sandbox>,
    pub home: HomeImageLease,
    pub identity: RestoredSessionIdentity,
    pub history: Vec<u8>,
    pub storage: StorageFingerprints,
    pub exit_code: i32,
}

pub struct Fixture {
    api: Api,
    config: ExecutorConfig,
    rootfs_hash: String,
    case: Arc<evidence::Case>,
    nonzero: bool,
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
    pub paths: &'a RunnerPaths,
    pub cache: &'a HomeImageCache,
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
    pub async fn new(
        paths: &RunnerPaths,
        cache: HomeImageCache,
        rootfs_hash: String,
        case: Arc<evidence::Case>,
        nonzero: bool,
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
                api_url: api.url.clone(),
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
            guest_duplex: runner_remote::guest_duplex::RunGuestChannels::default(),
            session_history_cpu: executor::SessionHistoryCpuPool::with_capacity(1),
            session_history_probe: executor::SessionHistoryProbe::default(),
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
        context.resume_session = Some(ResumeSession {
            cli_agent_session_id: THREAD.into(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: ResumeSessionHistoryRefKind::Blob,
                    hash: digest(history),
                    url: self.api.history_url(history)?,
                    encoding: ResumeSessionHistoryEncoding::Identity,
                    raw_size: history.len() as u64,
                    encoded_size: history.len() as u64,
                    download_source: None,
                },
            },
        });
        context.storage_manifest = Some(StorageManifest {
            storages: Vec::new(),
            artifacts: vec![ArtifactEntry {
                mount_path: "/home/user/workspace".into(),
                vas_storage_name: "workspace".into(),
                vas_storage_id: "native-workspace".into(),
                vas_version_id: "native-empty-version".into(),
                archive_url: None,
                archive_size: None,
                empty: Some(true),
                missing_root_policy: None,
            }],
        });
        let observation = format!("/home/user/native-continuation-{run}.json");
        let source = format!(
            "import hashlib,json,pathlib,subprocess; p=pathlib.Path({path:?}); z=pathlib.Path(str(p)+'.zst'); assert p.is_file()!=z.is_file(); data=p.read_bytes() if p.is_file() else subprocess.check_output(['zstd','-d','--stdout',str(z)]); prefix=data[:{size}]; assert hashlib.sha256(prefix).hexdigest()=={hash:?}; home=pathlib.Path('/home/user/guarded-idle-payload'); expected=({original:?}.encode()*2048)[:65536]; {home_action}; pathlib.Path({observation:?}).write_text(json.dumps({{'thread':{thread:?},'prefix_sha256':hashlib.sha256(prefix).hexdigest(),'prefix_bytes':len(prefix),'home_sha256':hashlib.sha256(home.read_bytes()).hexdigest()}}))",
            path = HISTORY_PATH,
            size = history.len(),
            hash = digest(history),
            original = original.to_string(),
            home_action = if continued {
                "assert home.read_bytes()==expected"
            } else {
                "home.write_bytes(expected)"
            },
            thread = THREAD,
        );
        context.prompt = format!(
            "@shell@\npython3 -I -c {}\n@end-shell@",
            quote_shell_arg(&source)
        );
        Ok(context)
    }

    pub async fn execute(self: &Arc<Self>, request: Execution<'_>) -> TestResult<Prepared> {
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
        let mut request = operations.request(inputs.replacement_plan()?)?;
        let permit = request.try_grant().await?;
        let context = self.context(run, &key, &history, original, continued)?;
        let storage = StorageFingerprints::from_manifest(
            context
                .storage_manifest
                .as_ref()
                .ok_or_else(|| io::Error::other("native storage manifest missing"))?,
        );
        let this = self.clone();
        let work = permit.spawn(move |mut operation| async move {
            let params = JobParams { profile_name: fixture::PROFILE.into(), vcpu: 2, memory_mb: 4096, home_disk_mb: 16384, rootfs_hash: this.rootfs_hash.clone(), restore_guest_state: true, device_rate_limits: None, home_image_prepare_lock_policy: Default::default() };
            let (mut outcome, _telemetry) = executor::execute_job_with_prepared_notifier(
                &**factory, context, NewSandboxDispatch { id, reuse_result: SandboxReuseResult::PoolMiss },
                &this.config, &params,
                runner_provider::RunCancellationSignals::from_hard_token(CancellationToken::new()),
                executor::ExecutionHooks {
                    sandbox_prepared: None, active_input_source: None, pre_spawn_timing: None,
                    session_history_restore_plan: executor::SessionHistoryRestorePlan::Default,
                },
            ).await;
            let checked: TestResult<(Vec<u8>, RestoredSessionIdentity)> = async {
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
                let complete = this.api.finalized_history(&run.to_string(), THREAD)?;
                if !complete.starts_with(&history) {
                    return Err(io::Error::other("native continuation lost complete original history bytes").into());
                }
                let identity = outcome.restored_session_identity.as_ref().ok_or_else(|| io::Error::other("native final verified session identity missing"))?;
                let verification = identity.final_metadata_verification().ok_or_else(|| io::Error::other("native final identity has no verifier provenance"))?;
                if verification.history_hash!=digest(&complete) || verification.history_size_bytes!=complete.len() as u64
                    || verification.session_id_hash!=digest(THREAD.as_bytes()) {
                    return Err(io::Error::other("native final identity does not bind complete bytes/thread").into());
                }
                let probe_path = format!("/home/user/native-continuation-{run}.json");
                let probe = fixture::exec(&**sandbox, &format!("cat {}", quote_shell_arg(&probe_path))).await?;
                let probe: Value = serde_json::from_slice(&probe)?;
                let home = fixture::home_payload(original);
                if probe != json!({"thread":THREAD,"prefix_sha256":digest(&history),"prefix_bytes":history.len(),"home_sha256":digest(&home)}) {
                    return Err(io::Error::other("native process did not observe original full prepared data").into());
                }
                Ok((complete, identity.clone()))
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
            if continued && (!home.is_cache_hit() || home.history_proof_binding().is_none()) {
                this.case.retain(sandbox); this.case.retain(home);
                return Err(io::Error::other("native continuation did not use verified saved home/history").into());
            }
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(Prepared { sandbox, home, identity, history, storage, exit_code })
        })?;
        work.join().await?
    }

    pub fn record_original(&self, run: RunId, prepared: &Prepared) -> TestResult<()> {
        self.case.continuation_witness("original_executor_completed", json!({
            "original_run_id":run.to_string(),"thread_id":THREAD,
            "seed_history_sha256":digest(SEED),"seed_history_bytes":SEED.len(),
            "original_history_sha256":digest(&prepared.history),"original_history_bytes":prepared.history.len(),
            "original_home_sha256":digest(&fixture::home_payload(run)),"original_home_bytes":fixture::PAYLOAD_BYTES,
            "exit_code":prepared.exit_code,"final_identity_verified":true,"full_original_prefix_verified":true,
            "preparation_observed_by_native_process":true,"original_full_lease_witness":true,
        }))?;
        Ok(())
    }

    pub async fn continue_and_save(self: &Arc<Self>, request: Saving<'_>) -> TestResult<()> {
        let Saving {
            factory,
            paths,
            cache,
            operations,
            inputs,
            budget,
            tracker,
            status,
            key,
            original,
            history,
        } = request;
        let lease = ResourceBudget::try_reserve_lease(budget, 2, 4096)
            .ok_or_else(|| io::Error::other("continued native full lease unavailable"))?;
        let next = RunId::new_v4();
        let id = SandboxId::new_v4();
        let result = self
            .execute(Execution {
                factory: factory.clone(),
                operations: operations.clone(),
                inputs,
                run: next,
                id,
                key: key.into(),
                history: history.to_vec(),
                original,
                continued: true,
            })
            .await;
        let mut prepared = match result {
            Ok(prepared) => prepared,
            Err(error) => {
                self.case.retain(lease);
                return Err(error);
            }
        };
        let checked: TestResult<()> = async {
        fixture::verify_saved_guest(&*prepared.sandbox, original).await?;
        self.case.continuation_witness("continued_executor_completed",json!({
            "continued_run_id":next.to_string(),"continued_sandbox_id":id.to_string(),
            "thread_id":THREAD,"restored_history_sha256":digest(history),"restored_history_bytes":history.len(),
            "continued_history_sha256":digest(&prepared.history),"continued_history_bytes":prepared.history.len(),
            "original_home_sha256":digest(&fixture::home_payload(original)),"original_home_bytes":fixture::PAYLOAD_BYTES,
            "exit_code":prepared.exit_code,"final_identity_verified":true,"full_original_prefix_verified":true,
            "preparation_observed_by_native_process":true,"home_cache_hit":true,"history_proof_bound":true,
        }))?;
        if prepared.sandbox.park().await? != SandboxParkOutcome::Reusable {
            return Err(io::Error::other("continued native Guest could not park").into());
        }
        Ok(())
        }.await;
        if let Err(error) = checked {
            self.case.retain(prepared);
            self.case.retain(lease);
            return Err(error);
        }
        let identity = prepared.identity.clone();
        let storage = prepared.storage.clone();
        let promotion = prepared
            .home
            .into_promotion_context(HomeImagePromotionRequest {
                run_id: next,
                sandbox_id: id,
                restored_session_identity: Some(&prepared.identity),
                terminal_status: HomeCacheTerminalStatus::Success,
                completed_at: chrono::Utc::now().to_rfc3339(),
                storage_fingerprints: prepared.storage,
            })
            .ok_or_else(|| io::Error::other("continued native required promotion unavailable"))?;
        let pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
            max_idle: 0,
        })));
        let mut candidate = ParkedIdleCandidateBuilder::new(key, lease)
            .with_sandbox(prepared.sandbox)
            .with_factory(factory.clone())
            .with_sandbox_id(id)
            .with_profile_name(fixture::PROFILE)
            .with_rootfs_hash(&self.rootfs_hash)
            .with_history_generation_run_id(next)
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
        let mut task = tracker
            .start_pool_retirement_batch(
                pool,
                status.clone(),
                operations.clone(),
                IdlePoolBatchRetirementRequest {
                    scope: IdleRetirementBatchScope::All,
                    envelope: inputs.envelope(),
                    context: "native_complete_continuation",
                },
            )
            .await?;
        if !task.join().await?.is_complete() {
            return Err(io::Error::other("continued native required saving incomplete").into());
        }
        let check_run = RunId::new_v4();
        let check_id = SandboxId::new_v4();
        let mut check_home =
            fixture::checkout(cache, check_run, check_id, key, &self.rootfs_hash).await;
        if !check_home.is_cache_hit() {
            return Err(io::Error::other("continued native home was not durably promoted").into());
        }
        // Verify all continued bytes from the saved image, not merely the first generation.
        let mut request = operations.request(inputs.replacement_plan()?)?;
        let permit = request.try_grant().await?;
        let check_lease = ResourceBudget::try_reserve_lease(budget, 2, 4096)
            .ok_or_else(|| io::Error::other("saved image check full logical lease unavailable"))?;
        let factory = factory.clone();
        let expected = prepared.history;
        let root = paths.base_dir().to_owned();
        let proof = self.case.clone();
        let operations = operations.clone();
        let tracker = tracker.clone();
        let status = status.clone();
        let key = key.to_owned();
        let rootfs = self.rootfs_hash.clone();
        let envelope = inputs.envelope();
        let work = permit.spawn(move |mut operation| async move {
            let created = factory
                .create(fixture::sandbox_config(check_id, &mut check_home))
                .await;
            let mut sandbox = match created {
                Ok(sandbox) => sandbox,
                Err(error) => {
                    proof.retain(check_home);
                    proof.retain(check_lease);
                    proof.retain(factory);
                    return Err::<(), Box<dyn std::error::Error + Send + Sync>>(error.into());
                }
            };
            let checked: TestResult<()> =
                async {
                    fixture::start_guest(&mut *sandbox, check_run).await?;
                    operation.bind_backing(sandbox.backing_process().ok_or_else(|| {
                        io::Error::other("continued image check has no backing")
                    })?)?;
                    runner_lifecycle::home_mount::ensure_home_drive_mounted(&*sandbox, check_run)
                        .await
                        .map_err(|e| e.error)?;
                    let actual = copy_history(&*sandbox, &root).await?;
                    if actual != expected {
                        return Err(io::Error::other(
                            "continued complete history bytes were not saved",
                        )
                        .into());
                    }
                    fixture::verify_saved_guest(&*sandbox, original).await?;
                    loop {
                        match operation.complete_phase().await {
                            Ok(()) => break,
                            Err(MemoryOperationError::AccountingChanged) => {
                                tokio::task::yield_now().await
                            }
                            Err(e) => return Err(e.into()),
                        }
                    }
                    Ok(())
                }
                .await;
            if let Err(error) = checked {
                proof.retain(sandbox);
                proof.retain(check_home);
                proof.retain(check_lease);
                return Err(error);
            }
            // This read-only validation assignment has no new agent identity.
            // Preserve its consumed saved image through the required saving owner.
            let parked = sandbox.park().await;
            if !matches!(parked, Ok(SandboxParkOutcome::Reusable)) {
                proof.retain(sandbox);
                proof.retain(check_home);
                proof.retain(check_lease);
                return Err(io::Error::other("saved image check Guest could not park").into());
            }
            let promotion = check_home
                .into_promotion_context(HomeImagePromotionRequest {
                    run_id: check_run,
                    sandbox_id: check_id,
                    restored_session_identity: None,
                    terminal_status: HomeCacheTerminalStatus::Success,
                    completed_at: chrono::Utc::now().to_rfc3339(),
                    storage_fingerprints: StorageFingerprints::default(),
                })
                .ok_or_else(|| io::Error::other("saved image check required promotion missing"))?;
            let pool = Arc::new(tokio::sync::Mutex::new(IdlePool::new(IdlePoolConfig {
                max_idle: 0,
            })));
            let mut candidate = ParkedIdleCandidateBuilder::new(&key, check_lease)
                .with_sandbox(sandbox)
                .with_factory(factory)
                .with_sandbox_id(check_id)
                .with_profile_name(fixture::PROFILE)
                .with_rootfs_hash(rootfs)
                .with_home_promotion(promotion)
                .build();
            if let Err(error) = candidate.capture_retirement_backing() {
                proof.retain(candidate);
                return Err(error.into());
            }
            match pool.lock().await.park(candidate) {
                ParkResult::Parked => {}
                other => {
                    proof.retain(other);
                    proof.retain(pool.clone());
                    return Err(
                        io::Error::other("saved image check required owner not parked").into(),
                    );
                }
            }
            proof.retain(pool.clone());
            let mut cleanup = tracker
                .start_pool_retirement_batch(
                    pool,
                    status,
                    operations,
                    IdlePoolBatchRetirementRequest {
                        scope: IdleRetirementBatchScope::All,
                        envelope,
                        context: "native_continued_image_check",
                    },
                )
                .await?;
            if !cleanup.join().await?.is_complete() {
                return Err(io::Error::other("saved image check cleanup incomplete").into());
            }
            Ok(())
        })?;
        work.join().await??;
        self.case.continuation_witness(
            "continued_saving_completed",
            json!({"required_cleanup_joined":true,"complete_continued_bytes_restored":true}),
        )?;
        Ok(())
    }

    pub async fn finish(self) -> TestResult<()> {
        self.api.finish().await
    }
}

pub fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

async fn copy_history(sandbox: &dyn Sandbox, root: &Path) -> TestResult<Vec<u8>> {
    let result=fixture::exec(sandbox,&format!("if test -f {HISTORY_PATH}; then printf plain; elif test -f {HISTORY_PATH}.zst; then printf zstd; else exit 1; fi")).await?;
    let (path, compressed) = match result.as_slice() {
        b"plain" => (HISTORY_PATH.to_string(), false),
        b"zstd" => (format!("{HISTORY_PATH}.zst"), true),
        _ => return Err(io::Error::other("saved native history format unavailable").into()),
    };
    let file = tempfile::NamedTempFile::new_in(root)?;
    sandbox
        .copy_file(
            &path,
            file.path(),
            CopyFileOptions {
                max_bytes: 4 * 1024 * 1024,
                timeout: Duration::from_secs(30),
                missing_ok: false,
            },
        )
        .await?;
    let bytes = std::fs::read(file.path())?;
    if compressed {
        Ok(zstd::decode_all(bytes.as_slice())?)
    } else {
        Ok(bytes)
    }
}
