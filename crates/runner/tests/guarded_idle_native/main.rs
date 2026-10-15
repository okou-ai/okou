#![cfg(target_os = "linux")]

//! Opt-in packaged-guest terminal saving fixture; see README.md in this directory.

mod continuation;
mod continuation_api;
mod evidence;
mod finalizing;
mod fixture;
mod optional;
mod pressure;
mod pressure_condition;
mod recovery;
mod recovery_source;
mod refusal;
mod tail;
mod transitions;

use std::{error::Error, io, path::PathBuf, sync::Arc};

use runner_host::paths::RunnerPaths;
use runner_lifecycle::home_image_cache::{
    HomeCacheTerminalStatus, HomeImageCache, HomeImagePromotionRequest,
};
use runner_lifecycle::home_mount::ensure_home_drive_mounted;
use runner_lifecycle::host_memory_operations::MemoryOperationError;
use runner_lifecycle::idle_pool::{
    DestroyOutcome, IdlePool, IdlePoolConfig, IdleRetirementBatchScope, ParkResult,
    test_support::ParkedIdleCandidateBuilder,
};
use runner_lifecycle::resource_budget::ResourceBudget;
use runner_lifecycle::status::StatusTracker;
use runner_storage::storage_fingerprints::StorageFingerprints;
use runner_supervisor::idle_lifecycle::{
    GuardedIdlePressureRequest, IdleDestroyTracker, IdlePoolBatchRetirementRequest,
    IdlePressureRequest, IdlePressureSelection, select_idle_entries_for_guarded_pressure,
};
use runner_types::ids::RunId;
use sandbox::{
    FactoryConfig, RuntimeConfig, SandboxFactory, SandboxId, SandboxParkOutcome, SandboxRuntime,
    SnapshotRef,
};
use sandbox_firecracker::FirecrackerRuntime;
use tokio::sync::Notify;

type TestResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Corpus {
    Terminal,
    Continuation,
    Optional,
}

const MISSING_GUEST_TIMEZONE: &str = "Etc/okou-test-missing-zone";

#[test]
fn native_report_consumer_validates_external_receipts() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/report_test.py"
        ))
        .output()
        .expect("native report contract tests require Python 3");
    assert!(
        output.status.success(),
        "native report contract failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_pressure_report_consumer_validates_external_receipts() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/pressure_report_test.py"
        ))
        .output()
        .expect("native pressure report contract tests require Python 3");
    assert!(
        output.status.success(),
        "native pressure report contract failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_optional_report_consumer_requires_complete_reads_and_joined_owners() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/optional_report_test.py"
        ))
        .output()
        .expect("native optional contract tests require Python 3");
    assert!(
        output.status.success(),
        "native optional report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_recovery_report_requires_real_gaps_pacing_and_joined_reads() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/recovery_report_test.py"
        ))
        .output()
        .expect("native recovery contract tests require Python 3");
    assert!(
        output.status.success(),
        "native recovery report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_continuation_report_consumer_validates_complete_session_receipts() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/continuation_report_test.py"
        ))
        .output()
        .expect("native continuation contract tests require Python 3");
    assert!(
        output.status.success(),
        "native continuation report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn native_continuation_peer_keeps_complete_history_across_both_listeners() -> TestResult<()> {
    let api = continuation_api::Api::bind(std::net::Ipv4Addr::new(127, 0, 0, 2)).await?;
    let client_config = |url| runner_provider::http::HttpClientConfig {
        api_url: url,
        vercel_bypass: None,
        client_session_id: "continuation-peer-regression".into(),
        runner_version: env!("CARGO_PKG_VERSION"),
    };
    runner_provider::http::HttpClient::new(client_config(api.host_url.clone()))?;
    assert!(
        runner_provider::http::HttpClient::new(client_config("http://10.0.0.1:1234".into()))
            .is_err()
    );
    let http = reqwest::Client::new();
    let url = api.history_url(continuation::SEED)?;
    let original = http
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    assert_eq!(original.as_ref(), continuation::SEED);
    let mut complete = original.to_vec();
    complete.extend_from_slice(b"\ncomplete original native fixture boundary\n");
    let hash = continuation::digest(&complete);
    let run = RunId::new_v4().to_string();
    let prepared: serde_json::Value = http
        .post(format!(
            "{}/api/webhooks/agent/session-history/prepare",
            api.host_url
        ))
        .bearer_auth(continuation_api::TOKEN)
        .json(&serde_json::json!({
            "runId":run,"hash":hash,"rawSize":complete.len(),
            "encodedSize":complete.len(),"encoding":"identity"
        }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let upload = prepared
        .get("presignedUrl")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| io::Error::other("native fixture upload preparation missing"))?;
    http.put(upload)
        .body(complete.clone())
        .send()
        .await?
        .error_for_status()?;
    http.post(format!("{}/api/webhooks/agent/complete", api.host_url))
        .bearer_auth(continuation_api::TOKEN)
        .json(&serde_json::json!({"runId":run,"exitCode":0,"completion":{
            "cliAgentSessionId":continuation::THREAD,"cliAgentSessionHistoryHash":hash
        }}))
        .send()
        .await?
        .error_for_status()?;
    assert_eq!(api.finalized_history(&run, continuation::THREAD)?, complete);
    api.finish().await
}

#[tokio::test]
async fn native_continuation_peer_rejects_oversized_stream_before_eof() -> TestResult<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let api = continuation_api::Api::bind(std::net::Ipv4Addr::new(127, 0, 0, 2)).await?;
    let mut stream = tokio::net::TcpStream::connect(
        api.host_url
            .strip_prefix("http://")
            .ok_or_else(|| io::Error::other("native fixture requires an HTTP listener"))?,
    )
    .await?;
    let response = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        stream
            .write_all(
                b"POST /api/webhooks/agent/events HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n",
            )
            .await?;
        let chunk = vec![b'x'; 64 * 1024];
        for _ in 0..64 {
            stream.write_all(b"10000\r\n").await?;
            stream.write_all(&chunk).await?;
            stream.write_all(b"\r\n").await?;
        }
        // Cross the 4 MiB limit without sending the terminating zero chunk.
        // Waiting for EOF before rejecting would retain an unbounded request.
        stream.write_all(b"1\r\nx\r\n").await?;
        let mut response = Vec::new();
        (&mut stream).take(1024).read_to_end(&mut response).await?;
        Ok::<_, io::Error>(response)
    })
    .await;
    drop(stream);
    let shutdown = api.finish().await;
    assert!(response??.starts_with(b"HTTP/1.1 400 "));
    assert!(shutdown.is_err(), "rejected native input must fail its run");
    Ok(())
}

#[derive(Clone, Copy, Debug)]
enum NativeScope {
    Batch(IdleRetirementBatchScope),
    Logical,
    Replacement,
    Restore,
    Aged,
    OptionalOrdinary,
    OptionalAged,
    Recovery,
    CallerOwned,
    SpeculativeGuestFailure,
    FinalizingParked,
    FinalizingRunning,
    Pressure,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires root, KVM, NBD, packaged guest artifacts and supplied measured policy"]
async fn guarded_terminal_saving_restores_home_without_private_runtime_bytes() -> TestResult<()> {
    if !nix::unistd::getuid().is_root() {
        return Err(io::Error::other("native idle fixture requires root").into());
    }
    let inputs = fixture::Inputs::load()?;
    let base = PathBuf::from(std::env::var("OKOU_TEST_RPC_BASE_DIR")?);
    std::fs::create_dir_all(&base)?;
    let mut runtime = FirecrackerRuntime::new(RuntimeConfig {
        proxy_port: None,
        dns_port: None,
        host_cpu_placement: None,
    })
    .await?;
    let result = exercise_factories(&runtime, &base, &inputs).await;
    runtime.shutdown().await;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD artifacts, compiled source identity and P1 measurement"]
async fn native_terminal_corpus_records_data_and_phase_ownership() -> TestResult<()> {
    measured_corpus(&[
        NativeScope::Batch(IdleRetirementBatchScope::Exact),
        NativeScope::Batch(IdleRetirementBatchScope::All),
        NativeScope::CallerOwned,
        NativeScope::SpeculativeGuestFailure,
        NativeScope::FinalizingParked,
        NativeScope::FinalizingRunning,
    ])
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD artifacts, real Critical-policy observation and P1 measurement"]
async fn native_policy_pressure_records_saving_and_free_logical_capacity() -> TestResult<()> {
    measured_corpus(&[NativeScope::Pressure]).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD artifacts, real fitting headroom and P1 measurement"]
async fn native_logical_pressure_records_replacement_and_required_saving() -> TestResult<()> {
    measured_corpus(&[NativeScope::Logical]).await
}

async fn measured_corpus(scopes: &[NativeScope]) -> TestResult<()> {
    measured_selected_corpus(scopes, Corpus::Terminal).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD artifacts, complete snapshot reads, real Ready headroom and exact-source P1 proof"]
async fn native_optional_records_ready_preparation_prefetch_and_required_saving() -> TestResult<()>
{
    measured_selected_corpus(
        &[NativeScope::OptionalOrdinary, NativeScope::OptionalAged],
        Corpus::Optional,
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD artifacts, real observation gaps, complete reads and exact-source P1 proof"]
async fn native_recovery_records_stale_revocation_and_paced_snapshot_reads() -> TestResult<()> {
    measured_corpus(&[NativeScope::Recovery]).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD artifacts, synthetic native API, mock Codex and exact-source P1 proof"]
async fn native_continuation_records_complete_session_history_and_required_saving() -> TestResult<()>
{
    measured_selected_corpus(
        &[
            NativeScope::Batch(IdleRetirementBatchScope::Exact),
            NativeScope::Logical,
            NativeScope::Replacement,
            NativeScope::Restore,
            NativeScope::Aged,
        ],
        Corpus::Continuation,
    )
    .await
}

async fn measured_selected_corpus(scopes: &[NativeScope], corpus: Corpus) -> TestResult<()> {
    native_logging()?;
    if !nix::unistd::getuid().is_root() {
        return Err(io::Error::other("native terminal corpus requires root").into());
    }
    let artifacts = evidence::Artifacts::load_and_verify()?;
    let inputs = fixture::Inputs::load()?;
    if inputs.envelope().tail_growth_bytes < (evidence::TAIL_BYTES + 1024 * 1024) as u64 {
        return Err(
            io::Error::other("supplied tail bound cannot cover the complete fixture IO").into(),
        );
    }
    let base = PathBuf::from(std::env::var("OKOU_TEST_RPC_BASE_DIR")?);
    if !base.is_dir() || std::fs::symlink_metadata(&base)?.file_type().is_symlink() {
        return Err(
            io::Error::other("native terminal base must be an owned existing directory").into(),
        );
    }
    let mut runtime = FirecrackerRuntime::new(RuntimeConfig {
        proxy_port: None,
        dns_port: None,
        host_cpu_placement: None,
    })
    .await?;
    let result =
        exercise_selected_factories(&runtime, &base, &inputs, scopes, Some(&artifacts), corpus)
            .await;
    if result.is_ok() {
        runtime.shutdown().await;
    }
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "prepares a new matching snapshot from explicitly supplied disposable native artifacts"]
async fn prepare_native_terminal_snapshot() -> TestResult<()> {
    native_logging()?;
    if !nix::unistd::getuid().is_root() {
        return Err(io::Error::other("snapshot preparation requires root").into());
    }
    let output_dir = PathBuf::from(std::env::var("OKOU_TEST_RPC_SNAPSHOT_DIR")?);
    if output_dir.exists() {
        return Err(
            io::Error::other("snapshot preparation requires a new output directory").into(),
        );
    }
    sandbox_firecracker::create_snapshot(sandbox::SnapshotCreateConfig {
        id: std::env::var("OKOU_TEST_RPC_SNAPSHOT_HASH")?,
        binary_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_FIRECRACKER")?),
        kernel_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_KERNEL")?),
        rootfs_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_ROOTFS")?),
        output_dir,
        vcpu_count: 2,
        memory_mb: 4096,
        home_disk_mb: 16384,
    })
    .await?;
    Ok(())
}

fn native_logging() -> TestResult<()> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_ansi(false)
        .with_writer(io::stderr)
        .try_init()
        .map_err(|error| io::Error::other(error.to_string()))?;
    Ok(())
}

async fn exercise_factories(
    runtime: &FirecrackerRuntime,
    base: &std::path::Path,
    inputs: &fixture::Inputs,
) -> TestResult<()> {
    let scopes = [
        NativeScope::Batch(IdleRetirementBatchScope::Exact),
        NativeScope::Batch(IdleRetirementBatchScope::All),
        NativeScope::Logical,
        NativeScope::Replacement,
        NativeScope::Restore,
        NativeScope::Aged,
        NativeScope::OptionalOrdinary,
        NativeScope::OptionalAged,
        NativeScope::CallerOwned,
        NativeScope::SpeculativeGuestFailure,
        NativeScope::FinalizingParked,
        NativeScope::FinalizingRunning,
        NativeScope::Pressure,
    ];
    exercise_selected_factories(runtime, base, inputs, &scopes, None, Corpus::Terminal).await
}

async fn exercise_selected_factories(
    runtime: &FirecrackerRuntime,
    base: &std::path::Path,
    inputs: &fixture::Inputs,
    scopes: &[NativeScope],
    artifacts: Option<&evidence::Artifacts>,
    corpus: Corpus,
) -> TestResult<()> {
    for &scope in scopes {
        for restored in [false, true] {
            // Never share a production Runner directory or another invocation's cache.
            let owned = tempfile::tempdir_in(base)?.keep();
            let paths = RunnerPaths::new(owned.clone());
            let proof = artifacts
                .map(|artifacts| {
                    evidence::Case::new(
                        format!(
                            "{}-{}",
                            if corpus == Corpus::Continuation {
                                if matches!(scope, NativeScope::Batch(_)) {
                                    "ContinuationNonzero".into()
                                } else {
                                    format!("Continuation{scope:?}")
                                }
                            } else {
                                format!("{scope:?}")
                            },
                            if restored { "snapshot" } else { "fresh" }
                        ),
                        artifacts.clone(),
                    )
                })
                .transpose()?;
            let snapshot = if restored {
                Some(SnapshotRef {
                    output_dir: PathBuf::from(std::env::var("OKOU_TEST_RPC_SNAPSHOT_DIR")?),
                    hash: std::env::var("OKOU_TEST_RPC_SNAPSHOT_HASH")?,
                })
            } else {
                None
            };
            let factory = runtime
                .create_factory(FactoryConfig {
                    profile: fixture::PROFILE.into(),
                    binary_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_FIRECRACKER")?),
                    kernel_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_KERNEL")?),
                    rootfs_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_ROOTFS")?),
                    base_dir: owned.clone(),
                    snapshot,
                })
                .await?;
            let factory: Box<dyn SandboxFactory> = if let Some(proof) = &proof {
                Box::new(tail::MeasuredFactory {
                    inner: factory,
                    case: proof.clone(),
                    directory: owned.clone(),
                    physical: tokio_util::task::TaskTracker::new(),
                })
            } else {
                factory
            };
            let factory = Arc::new(factory);
            let result = exercise_retirement(
                factory.clone(),
                paths,
                inputs,
                scope,
                proof.as_ref(),
                corpus,
            )
            .await;
            // A failed measured case is not permission to tear down dependencies
            // or delete its files. Accepted cleanup retains its own factory owner.
            if proof.is_some() {
                result
                    .as_ref()
                    .map_err(|error| io::Error::other(error.to_string()))?;
            }
            if let Some(proof) = &proof {
                proof.release_completed_owners();
            }
            let mut factory = Arc::try_unwrap(factory)
                .map_err(|_| io::Error::other("native fixture lost its exclusive factory owner"))?;
            factory.shutdown().await;
            result?;
            if let Some(proof) = proof {
                proof.finish().await?;
            }
            // Only verified data/exit/physical tail and dependency teardown permit removal.
            std::fs::remove_dir_all(&owned)?;
            println!("GUARDED_IDLE_TERMINAL_PASS restored={restored} scope={scope:?}");
        }
    }
    Ok(())
}

async fn exercise_retirement(
    factory: Arc<Box<dyn SandboxFactory>>,
    paths: RunnerPaths,
    inputs: &fixture::Inputs,
    scope: NativeScope,
    proof: Option<&Arc<evidence::Case>>,
    corpus: Corpus,
) -> TestResult<()> {
    let status = Arc::new(StatusTracker::new(
        paths.base_dir().join("status.json"),
        1,
        None,
        None,
    ));
    status.write_initial().await?;
    let cache = HomeImageCache::new(paths.clone());
    let run_id = RunId::new_v4();
    let sandbox_id = SandboxId::new_v4();
    let reuse_key = format!("thread:native-guarded-{run_id}");
    let rootfs_hash = std::env::var("OKOU_TEST_IDLE_ROOTFS_HASH")?;
    if rootfs_hash.is_empty() {
        return Err(io::Error::other("packaged rootfs hash must be supplied").into());
    }
    let recovery_source =
        matches!(scope, NativeScope::Recovery).then(|| Arc::new(recovery_source::Source::new()));
    let operations = match &recovery_source {
        Some(source) => inputs.operations_with_source(source.clone())?,
        None => inputs.operations()?,
    };
    let (vcpu, memory) = match scope {
        NativeScope::Pressure => (6, 12288),
        NativeScope::Replacement | NativeScope::Restore => (6, 12288),
        NativeScope::Aged | NativeScope::OptionalOrdinary | NativeScope::OptionalAged => {
            (12, 24576)
        }
        _ => (2, 4096),
    };
    let budget = Arc::new(ResourceBudget::new(vcpu, memory, 1.0, 0));
    let mut first_lease = None;
    let mut session_identity = None;
    let mut original_history = Vec::new();
    let mut storage_fingerprints = StorageFingerprints::default();
    let mut original_exit = 0;
    let mut continuation_fixture = None;
    let (mut sandbox, home) = if corpus == Corpus::Continuation {
        let proof = proof
            .ok_or_else(|| io::Error::other("native continuation requires measured owners"))?;
        let lease = ResourceBudget::try_reserve_lease(&budget, 2, 4096)
            .ok_or_else(|| io::Error::other("native original full lease unavailable"))?;
        proof.bind_original_lease(&lease)?;
        proof.retain(operations.clone());
        proof.retain(factory.clone());
        let continuation = continuation::Fixture::new(
            &paths,
            cache.clone(),
            rootfs_hash.clone(),
            proof.clone(),
            matches!(scope, NativeScope::Batch(_)),
        )
        .await?;
        let result = continuation
            .execute(continuation::Execution {
                factory: factory.clone(),
                operations: operations.clone(),
                inputs,
                run: run_id,
                id: sandbox_id,
                key: reuse_key.clone(),
                history: continuation::SEED.to_vec(),
                original: run_id,
                continued: false,
                require_bound_history: false,
            })
            .await;
        let mut prepared = match result {
            Ok(prepared) => prepared,
            Err(error) => {
                proof.retain(lease);
                proof.retain(continuation);
                return Err(error);
            }
        };
        original_exit = prepared.exit_code;
        storage_fingerprints = prepared.storage.clone();
        session_identity = prepared.identity.clone();
        first_lease = Some(lease);
        let backing = prepared
            .sandbox
            .backing_process()
            .ok_or_else(|| io::Error::other("native original backing unavailable"))?;
        proof.bind(sandbox_id.to_string(), backing, budget.clone())?;
        continuation.record_original(run_id, &prepared)?;
        original_history = std::mem::take(&mut prepared.history);
        continuation_fixture = Some(continuation);
        (prepared.sandbox, prepared.home)
    } else {
        let mut home =
            fixture::checkout(&cache, run_id, sandbox_id, &reuse_key, &rootfs_hash).await;
        let mut sandbox = factory
            .create(fixture::sandbox_config(sandbox_id, &mut home))
            .await?;
        if let Err(error) = fixture::prepare_guest(&mut *sandbox, run_id).await {
            factory.destroy(sandbox).await;
            return Err(error);
        }
        (sandbox, home)
    };
    if corpus == Corpus::Continuation
        && let Err(error) = fixture::prepare_started_guest(&mut *sandbox, run_id).await
    {
        if let Some(proof) = proof {
            proof.retain(sandbox);
            proof.retain(home);
            proof.retain(first_lease);
        }
        return Err(error);
    }
    if let Some(proof) = proof
        && corpus != Corpus::Continuation
    {
        let backing = sandbox
            .backing_process()
            .ok_or_else(|| io::Error::other("native receipt has no backing"))?;
        proof.bind(sandbox_id.to_string(), backing, budget.clone())?;
    }
    if matches!(
        scope,
        NativeScope::FinalizingParked | NativeScope::FinalizingRunning
    ) {
        if let Some(proof) = proof {
            proof.event("terminal_started", serde_json::json!({}))?;
        }
        return finalizing::exercise(
            finalizing::Context {
                factory,
                cache,
                sandbox,
                home,
                budget,
                operations,
                rootfs_hash,
                run_id,
                sandbox_id,
                reuse_key,
            },
            inputs,
            matches!(scope, NativeScope::FinalizingRunning),
            proof,
        )
        .await;
    }
    let parked: TestResult<_> = async {
        let backing = sandbox
            .backing_process()
            .ok_or_else(|| io::Error::other("Firecracker supplied no exact backing capability"))?;
        if sandbox.park().await? != SandboxParkOutcome::Reusable {
            return Err(io::Error::other("native fixture could not physically park").into());
        }
        let lease = if corpus == Corpus::Continuation {
            first_lease.take()
        } else {
            ResourceBudget::try_reserve_lease(&budget, 2, 4096)
        }
        .ok_or_else(|| io::Error::other("native fixture could not acquire its logical lease"))?;
        Ok((backing, lease))
    }
    .await;
    let (backing, lease) = match parked {
        Ok(parked) => parked,
        Err(error) => {
            if let Some(proof) = proof {
                proof.retain(sandbox);
                proof.retain(home);
                proof.retain(first_lease);
            } else {
                factory.destroy(sandbox).await;
            }
            return Err(error);
        }
    };
    let promotion = home.into_promotion_context(HomeImagePromotionRequest {
        run_id,
        sandbox_id,
        restored_session_identity: session_identity.as_ref(),
        terminal_status: if original_exit == 0 {
            HomeCacheTerminalStatus::Success
        } else {
            HomeCacheTerminalStatus::NonzeroExit
        },
        completed_at: chrono::Utc::now().to_rfc3339(),
        storage_fingerprints: storage_fingerprints.clone(),
    });
    let Some(promotion) = promotion else {
        if let Some(proof) = proof {
            proof.retain(sandbox);
            proof.retain(lease);
        } else {
            factory.destroy(sandbox).await;
        }
        return Err(io::Error::other("native fixture could not own home saving").into());
    };
    let mut pool = IdlePool::new(IdlePoolConfig {
        max_idle: if matches!(scope, NativeScope::OptionalOrdinary) {
            2
        } else {
            1
        },
    });
    let tracker = IdleDestroyTracker::new(Arc::new(Notify::new()));
    if (corpus == Corpus::Optional || matches!(scope, NativeScope::Recovery))
        && let Some(proof) = proof
    {
        proof.bind_original_lease(&lease)?;
    }
    let candidate = ParkedIdleCandidateBuilder::new(&reuse_key, lease)
        .with_sandbox(sandbox)
        .with_factory(factory.clone())
        .with_sandbox_id(sandbox_id)
        .with_profile_name(fixture::PROFILE)
        .with_rootfs_hash(&rootfs_hash)
        .with_history_generation_run_id(run_id)
        .with_home_promotion(promotion)
        .with_storage_fingerprints(storage_fingerprints);
    let candidate = if let Some(identity) = session_identity {
        candidate.with_restored_session_identity(identity)
    } else {
        candidate
    };
    let mut candidate = candidate.build();
    if let Err(error) = candidate.capture_retirement_backing() {
        if let Some(proof) = proof {
            proof.retain(candidate);
            return Err(error.into());
        }
        // Explicit disposal of this invocation's native fixture, never a
        // production guarded-admission fallback.
        let (payload, lease) = candidate.into_active_destroy_parts();
        tracker
            .spawn_payload_retaining_lease(payload, lease, "native_fixture_capture_cleanup")
            .join()
            .await?;
        return Err(error.into());
    }
    let parked = if matches!(scope, NativeScope::Aged | NativeScope::OptionalAged) {
        pool.park_at_for_test(
            candidate,
            std::time::Instant::now() - std::time::Duration::from_secs(40 * 60),
        )
    } else {
        pool.park(candidate)
    };
    assert!(matches!(parked, ParkResult::Parked));
    let pool = Arc::new(tokio::sync::Mutex::new(pool));
    if let Some(proof) = proof {
        proof.retain(pool.clone());
        proof.retain(tracker.clone());
        proof.retain(operations.clone());
        if corpus == Corpus::Continuation {
            let policy = inputs.pressure_policy()?;
            let observation = operations.observe_pressure().await;
            let now = tokio::time::Instant::now();
            let available = observation.available_bytes_at(now, policy.max_sample_age)?;
            let required = policy
                .bounds
                .operating_floor_bytes
                .checked_add(policy.bounds.cleanup_reserve_bytes)
                .and_then(|v| v.checked_add(4 * 1024 * 1024 * 1024))
                .and_then(|v| v.checked_add(inputs.preparation_bytes()))
                .ok_or_else(|| io::Error::other("native continuation headroom overflow"))?;
            if available < required || available < policy.bounds.recovery_available_bytes {
                return Err(io::Error::other(
                    "actual native continuation lacks fitting supplied headroom",
                )
                .into());
            }
            proof.continuation_witness("scenario_observed",serde_json::json!({
                "policy":serde_json::to_value(inputs)?,"available_bytes":available,
                "age_ns":u64::try_from(observation.age_at(now).ok_or_else(||io::Error::other("native sample is in the future"))?.as_nanos())?,
                "read_duration_ns":u64::try_from(observation.read_duration().as_nanos())?,
                "allocated":budget.allocated(),"profile_can_fit":budget.can_afford(2,4096),
            }))?;
        }
        if corpus == Corpus::Terminal
            && matches!(scope, NativeScope::Pressure | NativeScope::Logical)
        {
            pressure_condition::observe(&operations, &budget, inputs, scope, proof).await?;
        }
        proof.event("terminal_started", serde_json::json!({}))?;
    }
    let retirement: TestResult<_> = async {
        match scope {
            NativeScope::Recovery => {
                recovery::exercise(transitions::Context {
                    factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                    operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                    rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                }, inputs, recovery_source.as_ref().ok_or_else(|| io::Error::other("native recovery source missing"))?, proof).await?;
                Ok(None)
            }
            NativeScope::OptionalOrdinary | NativeScope::OptionalAged => {
                optional::exercise(transitions::Context {
                    factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                    operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                    rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                }, inputs, matches!(scope, NativeScope::OptionalAged), proof).await?;
                Ok(None)
            }
            NativeScope::Pressure => {
                pressure::exercise(&pool, &status, &tracker, &operations, inputs, proof).await?;
                Ok(None)
            }
            NativeScope::FinalizingParked | NativeScope::FinalizingRunning => Err(io::Error::other("finalizing scope did not enter its producer transition").into()),
            NativeScope::CallerOwned | NativeScope::SpeculativeGuestFailure => {
                use runner_lifecycle::idle_pool::{
                    ActivationCleanupOutcome, GuardedSpeculativeIdleOwner, IdleActivationOwner,
                };
                // A successor cancelled before business activation still owns
                // its exact parked reservation and mandatory terminal saving.
                let reservation = pool
                    .lock()
                    .await
                    .take_reserved(&reuse_key)
                    .ok_or_else(|| io::Error::other("native caller reservation disappeared"))?;
                let mut owner = Some(if matches!(scope, NativeScope::SpeculativeGuestFailure) {
                    let mut speculative =
                        GuardedSpeculativeIdleOwner::new(reservation).map_err(|_| {
                            io::Error::other("native speculation received running handoff")
                        })?;
                    // Exercise a real fixed guest restore failure after unpark,
                    // before any business process. The deliberately absent zone
                    // must fail required timezone verification in the Executor.
                    let result = speculative
                        .prepare(RunId::new_v4(), |sandbox, _, _| {
                            Box::pin(async move {
                                runner_executor::executor::restore_guest_state_with_timezone(
                                    sandbox,
                                    MISSING_GUEST_TIMEZONE,
                                )
                                .await
                                .map_err(|e| e.to_string())
                            })
                        })
                        .await;
                    let expected_error = runner_executor::ExecutorError::Config(format!(
                        "guest timezone {MISSING_GUEST_TIMEZONE:?} is unavailable: /usr/share/zoneinfo/{MISSING_GUEST_TIMEZONE} is not a file"
                    ))
                    .to_string();
                    if result.as_ref().err() != Some(&expected_error) {
                        if let Some(proof) = proof {
                            proof.retain(speculative);
                        }
                        return Err(io::Error::other(format!(
                            "native speculative guest restore expected {expected_error:?}, got {result:?}"
                        ))
                        .into());
                    }
                    speculative.take_cleanup_owner()?
                } else {
                    IdleActivationOwner::new(reservation)
                        .map_err(|_| io::Error::other("native caller received running handoff"))?
                });
                let accepted = tracker
                    .retire_activation_owner(
                        &mut owner,
                        &operations,
                        inputs.envelope(),
                        "native_caller_cleanup",
                    )
                    .await;
                let mut task = match accepted {
                    Ok(task) => task,
                    Err(error) => {
                        if let Some(proof) = proof {
                            proof.retain(owner.take());
                        }
                        return Err(error.into());
                    }
                };
                assert!(owner.is_none());
                let outcome = task.join().await??;
                if !matches!(
                    outcome,
                    ActivationCleanupOutcome::Completed {
                        home_cache_promoted: true
                    }
                ) {
                    return Err(io::Error::other(format!(
                        "native caller required saving incomplete: {outcome:?}"
                    ))
                    .into());
                }
                tracker.close_and_wait().await;
                drop(task.take_completed_lease()?);
                if !tracker.take_retained_activation_owners()?.is_empty() {
                    return Err(io::Error::other("native caller retained uncertainty").into());
                }
                Ok(None)
            }
            NativeScope::Replacement | NativeScope::Restore | NativeScope::Aged => {
                transitions::exercise(
                    transitions::Context {
                        factory: factory.clone(),
                        pool: pool.clone(),
                        status: status.clone(),
                        operations: operations.clone(),
                        budget: budget.clone(),
                        tracker: tracker.clone(),
                        rootfs_hash: rootfs_hash.clone(),
                        reuse_key: reuse_key.clone(),
                    },
                    inputs,
                    scope,
                )
                .await?;
                Ok(None)
            }
            NativeScope::Batch(scope) => {
                let mut task = tracker
                    .start_pool_retirement_batch(
                        pool.clone(),
                        status.clone(),
                        operations.clone(),
                        IdlePoolBatchRetirementRequest {
                            scope,
                            envelope: inputs.envelope(),
                            context: "native_guarded_idle",
                        },
                    )
                    .await?;
                let result = task.join().await?;
                if !result.is_complete() {
                    return Err(io::Error::other(format!(
                        "native guarded batch incomplete: {result:?}"
                    ))
                    .into());
                }
                assert_eq!(
                    (result.selected, result.completed, result.uncertain),
                    (1, 1, 0)
                );
                Ok(None)
            }
            NativeScope::Logical => {
                // Same physical authority reserves real replacement growth before
                // accepting old retirement. Logical transfer supplies no credit.
                let mut replacement = operations.request(inputs.replacement_plan()?)?;
                let permit = replacement.try_grant().await?;
                let mut result = select_idle_entries_for_guarded_pressure(
                    &pool,
                    &status,
                    &tracker,
                    &budget,
                    &operations,
                    Vec::new(),
                    GuardedIdlePressureRequest {
                        selection: IdlePressureRequest {
                            run_id: RunId::new_v4(),
                            reuse_key: None,
                            profile_name: fixture::PROFILE,
                            device_rate_limits: &None,
                            history_generation_run_id: None,
                            allow_compatible_blank: false,
                            blank_pool_diagnostics: None,
                            vcpu: 2,
                            memory_mb: 4096,
                            context: "native_guarded_logical",
                        },
                        envelope: inputs.envelope(),
                    },
                )
                .await;
                if !result.not_started.is_empty() || result.status_error.is_some() {
                    return Err(io::Error::other(format!(
                        "native logical refusal/status failure: {:?} / {:?}",
                        result.not_started, result.status_error
                    ))
                    .into());
                }
                let IdlePressureSelection::Fresh(lease) = result.selection else {
                    return Err(io::Error::other(
                        "native logical substitution did not return a full lease",
                    )
                    .into());
                };
                assert_eq!((lease.vcpu(), lease.memory_mb()), (2, 4096));
                assert_eq!(result.retirements.len(), 1);
                let completed: TestResult<()> = async {
                    // Prepare a different guest before joining old cleanup;
                    // this adds no old-exit barrier or still-live overlap claim.
                    let next_factory = factory.clone();
                    let next_cache = cache.clone();
                    let next_rootfs = rootfs_hash.clone();
                    let next_proof = proof.cloned();
                    let work = permit.spawn(move |mut operation| async move {
                        let next_run = RunId::new_v4();
                        let next_id = SandboxId::new_v4();
                        let key = format!("thread:native-logical-replacement-{next_run}");
                        let mut home =
                            fixture::checkout(&next_cache, next_run, next_id, &key, &next_rootfs).await;
                        let mut next = next_factory
                            .create(fixture::sandbox_config(next_id, &mut home))
                            .await?;
                        let prepared: TestResult<()> = async {
                            // The Fresh operation covers startup; Firecracker exposes
                            // its backing only after the process has started.
                            fixture::start_guest(&mut *next, next_run).await?;
                            let backing = next
                                .backing_process()
                                .ok_or_else(|| io::Error::other("replacement supplied no backing"))?;
                            operation.bind_backing(backing)?;
                            fixture::prepare_started_guest(&mut *next, next_run).await?;
                            loop {
                                match operation.complete_phase().await {
                                    Ok(()) => break,
                                    Err(MemoryOperationError::AccountingChanged) => {
                                        tokio::task::yield_now().await
                                    }
                                    Err(error) => return Err(error.into()),
                                }
                            }
                            if let Some(proof) = &next_proof
                                && corpus == Corpus::Terminal {
                                proof.pressure_witness(
                                    "different_guest_prepared",
                                    serde_json::json!({
                                        "incoming_sandbox_id": next_id.to_string(),
                                        "admitted": true,
                                    }),
                                )?;
                                }
                            Ok(())
                        }
                        .await;
                        next_factory.destroy(next).await;
                        prepared
                    })?;
                    work.join().await??;
                    if let Some(proof) = proof
                        && corpus == Corpus::Terminal {
                        proof.pressure_witness(
                            "original_join_requested",
                            serde_json::json!({"retirements": result.retirements.len()}),
                        )?;
                        }
                    for task in &mut result.retirements {
                        let completion = task.join().await??;
                        if completion.outcome != DestroyOutcome::Completed
                            || !completion.home_cache_promoted
                        {
                            return Err(io::Error::other(
                                "native logical retirement did not prove complete saving",
                            )
                            .into());
                        }
                    }
                    Ok(())
                }
                .await;
                if let Err(error) = completed {
                    if let Some(proof) = proof {
                        // Accepted saving can outlive failed replacement work.
                        // Preserve its complete original lease with the owners.
                        proof.retain(lease);
                    }
                    return Err(error);
                }
                Ok(Some(lease))
            }
        }
    }
    .await;
    let logical_lease = match retirement {
        Ok(lease) => lease,
        Err(error) => {
            if proof.is_some() {
                // Real retained pool/tracker/operation owners above keep refusal
                // or uncertainty intact; raw destruction cannot prove saving.
                return Err(error);
            }
            let jobs = pool.lock().await.drain();
            for job in jobs {
                job.run_with_context("native_fixture_refused_batch_cleanup")
                    .await;
            }
            tracker.close_and_wait().await;
            return Err(error);
        }
    };
    assert!(pool.lock().await.is_empty());
    assert!(backing.exit_confirmed().await);
    tracker.close_and_wait().await;
    drop(logical_lease);
    assert_eq!(budget.allocated(), (0, 0, 0));
    if let Some(continuation) = continuation_fixture {
        let continued_tracker = IdleDestroyTracker::new(Arc::new(Notify::new()));
        if let Some(proof) = proof {
            proof.retain(continued_tracker.clone());
        }
        continuation
            .continue_and_save(continuation::Saving {
                factory: factory.clone(),
                operations: &operations,
                inputs,
                budget: &budget,
                tracker: &continued_tracker,
                status: &status,
                key: &reuse_key,
                original: run_id,
                history: &original_history,
            })
            .await?;
        continued_tracker.close_and_wait().await;
        let report = operations.close_and_wait().await?;
        assert_eq!((report.registered_operations, report.tracked_tasks), (0, 0));
        assert_eq!(budget.allocated(), (0, 0, 0));
        let continuation = Arc::try_unwrap(continuation)
            .map_err(|_| io::Error::other("native continuation still has accepted work"))?;
        continuation.finish().await?;
        return Ok(());
    }
    let report = operations.close_and_wait().await?;
    assert_eq!((report.registered_operations, report.tracked_tasks), (0, 0));
    let next_run = RunId::new_v4();
    let next_id = SandboxId::new_v4();
    let mut restored = fixture::checkout(&cache, next_run, next_id, &reuse_key, &rootfs_hash).await;
    assert!(restored.is_cache_hit());
    let mut sandbox = factory
        .create(fixture::sandbox_config(next_id, &mut restored))
        .await?;
    let checked = async {
        sandbox.bind_run_control(&next_run.to_string())?;
        sandbox.start().await?;
        ensure_home_drive_mounted(&*sandbox, next_run)
            .await
            .map_err(|failure| failure.error)?;
        fixture::verify_saved_guest(&*sandbox, run_id).await
    }
    .await;
    factory.destroy(sandbox).await;
    checked
}
