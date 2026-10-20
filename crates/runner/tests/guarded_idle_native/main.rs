#![cfg(target_os = "linux")]

//! Opt-in packaged-guest terminal saving fixture; see README.md in this directory.

mod batch_aba;
mod batch_repark;
mod batch_replacement;
mod claim_loss;
mod claim_peer;
mod claim_producer;
mod claim_restore;
mod claim_sample;
mod cleanup_progress;
mod continuation;
mod continuation_api;
mod create_cancellation;
mod critical;
mod critical_progress;
mod dual_history;
mod evidence;
mod fences;
mod finalizing;
mod fixed_restore;
mod fixture;
mod foreground;
mod foreground_growth;
mod foreground_io;
mod foreground_probe;
mod guarded_readers;
mod incoming_progress;
mod incoming_work;
mod later_parking;
mod logical_progress;
mod logical_work;
mod native_pause;
mod native_transition;
mod native_unpark;
mod observer_loss;
mod optional;
mod pressure;
mod pressure_condition;
mod read_cancellation;
mod read_revocation;
mod read_stop;
mod real_api_claims;
mod recovery;
mod recovery_source;
mod refusal;
mod returned_guest;
mod returned_guest_probe;
mod shared_reads;
mod snapshot_preparation;
mod speculative_fault;
mod startup;
mod status_failure;
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
    Fences,
    LogicalProgress,
    IncomingProgress,
    CriticalProgress,
    ReadCancellation,
    SharedReads,
    ReadRevocation,
    ReadStop,
    CreateCancellation,
    ReturnedGuest(sandbox_firecracker::GuestPreparationStage),
    ObserverLoss(bool),
    StatusFailure,
    LaterParking(bool),
    BatchAba,
    BatchRepark,
    BatchReplacement,
    ClaimLoss,
    SpeculativeFault(bool),
    NativeUnpark(native_unpark::Fault),
    NativePause(native_pause::Fault),
    FixedRestore(fixed_restore::Selection),
    DualHistory(bool),
    ClaimUnavailable(claim_peer::Outcome),
    ClaimProducerLost { cancelled: bool, restored: bool },
    RealApiClaims,
    RealApiClaimant(bool),
}

enum PreparationProbe<'a> {
    None,
    Create(&'a Arc<create_cancellation::Probe>),
    Returned(&'a Arc<returned_guest_probe::Probe>),
    Claim(&'a Arc<claim_restore::Probe>),
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
fn native_fence_report_requires_real_refusal_and_original_custody() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/fence_report_test.py"
        ))
        .output()
        .expect("native fence report requires Python 3");
    assert!(
        output.status.success(),
        "native fence report failed: {}",
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
fn native_critical_report_requires_bounded_waves_and_suppressed_reads() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/critical_report_test.py"
        ))
        .output()
        .expect("native Critical contract tests require Python 3");
    assert!(
        output.status.success(),
        "native Critical report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_startup_report_requires_complete_bytes_and_joined_producers() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/startup_report_test.py"
        ))
        .output()
        .expect("native startup contract tests require Python 3");
    assert!(
        output.status.success(),
        "native startup report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_foreground_report_requires_real_progress_and_original_custody() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/foreground_report_test.py"
        ))
        .output()
        .expect("native foreground contract tests require Python 3");
    assert!(
        output.status.success(),
        "native foreground report failed: {}",
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
    let run = RunId::new_v4().to_string();
    let thread = uuid::Uuid::new_v4().to_string();
    http.post(format!("{}/api/webhooks/agent/complete", api.host_url))
        .bearer_auth(continuation_api::TOKEN)
        .json(&serde_json::json!({"runId":run,"exitCode":0,"completion":{
            "cliAgentSessionId":thread,"cliAgentSessionHistoryDisposition":"native_only"
        }}))
        .send()
        .await?
        .error_for_status()?;
    assert_eq!(api.session(Some(&run))?, (thread, run));
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
    Critical,
    Startup,
    ForegroundFresh,
    ForegroundReuse,
    CallerOwned,
    SpeculativeGuestFailure,
    FinalizingParked,
    FinalizingRunning,
    Pressure,
    LaterParking,
}

fn native_budget(scope: NativeScope) -> Arc<ResourceBudget> {
    let (vcpu, memory) = match scope {
        NativeScope::Pressure => (6, 12288),
        // Three parked profiles plus one fitting foreground profile, after
        // ResourceBudget's host CPU reservation. This is logical fixture
        // capacity, not a measurement of available physical host CPUs.
        NativeScope::Critical => (10, 16384),
        NativeScope::Replacement
        | NativeScope::Restore
        | NativeScope::ForegroundFresh
        | NativeScope::LaterParking => (6, 12288),
        NativeScope::Aged | NativeScope::OptionalOrdinary | NativeScope::OptionalAged => {
            (12, 24576)
        }
        _ => (2, 4096),
    };
    Arc::new(ResourceBudget::new(vcpu, memory, 1.0, 0))
}

#[test]
fn native_critical_budget_keeps_a_full_spare_profile_after_host_reservation() {
    let budget = native_budget(NativeScope::Critical);
    let mut leases = Vec::new();
    for _ in 0..3 {
        leases.push(ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap());
    }
    assert_eq!(budget.allocated(), (6, 12288, 3));
    assert!(budget.can_afford(2, 4096));
    leases.push(ResourceBudget::try_reserve_lease(&budget, 2, 4096).unwrap());
    assert_eq!(budget.allocated(), (8, 16384, 4));
    assert!(ResourceBudget::try_reserve_lease(&budget, 2, 4096).is_none());
    drop(leases);
    assert_eq!(budget.allocated(), (0, 0, 0));
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
#[ignore = "requires owned KVM/NBD artifacts, real supplied-Critical samples and exact-source P1 proof"]
async fn native_critical_records_bounded_waves_and_suppressed_snapshot_reads() -> TestResult<()> {
    measured_corpus(&[NativeScope::Critical]).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD artifacts, original snapshot bytes and exact-source P1 proof"]
async fn native_startup_records_complete_snapshot_reads_and_joined_owners() -> TestResult<()> {
    measured_corpus(&[NativeScope::Startup]).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs and exact-source foreground P1 proof"]
async fn native_foreground_records_fresh_and_exact_reuse_progress() -> TestResult<()> {
    measured_corpus(&[NativeScope::ForegroundFresh, NativeScope::ForegroundReuse]).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs, real grant expiry and exact-source P1 proof"]
async fn native_foreground_records_retirement_fences_before_detach() -> TestResult<()> {
    measured_selected_corpus(
        &[NativeScope::ForegroundFresh, NativeScope::ForegroundReuse],
        Corpus::Fences,
    )
    .await
}

#[test]
fn native_logical_progress_report_requires_physical_coverage_and_real_waits() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/logical_report_test.py"
        ))
        .output()
        .expect("native logical progress report requires Python 3");
    assert!(
        output.status.success(),
        "native logical report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs, full-budget logical transfer and exact-source P1 proof"]
async fn native_logical_records_reader_heartbeat_and_cleanup_contention() -> TestResult<()> {
    measured_selected_corpus(&[NativeScope::Logical], Corpus::LogicalProgress).await
}

#[test]
fn native_incoming_report_requires_path_specific_progress_and_full_custody() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/incoming_report_test.py"
        ))
        .output()
        .expect("native incoming report requires Python 3");
    assert!(
        output.status.success(),
        "native incoming report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs, incoming ownership and exact-source P1 proof"]
async fn native_incoming_records_reader_heartbeat_and_cleanup_contention() -> TestResult<()> {
    measured_selected_corpus(
        &[
            NativeScope::Replacement,
            NativeScope::Restore,
            NativeScope::Aged,
        ],
        Corpus::IncomingProgress,
    )
    .await
}

#[test]
fn native_critical_progress_report_requires_complete_contention_and_custody() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/critical_progress_report_test.py"
        ))
        .output()
        .expect("native Critical progress report requires Python3");
    assert!(
        output.status.success(),
        "Critical progress report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs and final-source Critical contention P1 proof"]
async fn native_critical_records_independent_contention_progress() -> TestResult<()> {
    measured_selected_corpus(&[NativeScope::Critical], Corpus::CriticalProgress).await
}

#[test]
fn native_observer_loss_report_requires_joined_saving_and_independent_progress() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/observer_loss_report_test.py"
        ))
        .output()
        .expect("native observer loss report requires Python3");
    assert!(
        output.status.success(),
        "observer loss report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_status_failure_report_requires_saved_data_and_current_retry() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/status_failure_report_test.py"
        ))
        .output()
        .expect("native status failure report requires Python3");
    assert!(
        output.status.success(),
        "status failure report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_later_parking_report_requires_fixed_selection_and_current_inventory() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/later_parking_report_test.py"
        ))
        .output()
        .expect("native later parking report requires Python3");
    assert!(
        output.status.success(),
        "later parking report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs and submitted-source later-parking P1 proof"]
async fn native_fixed_batch_preserves_later_exact_and_blank_inventory() -> TestResult<()> {
    measured_selected_corpora(
        &[NativeScope::LaterParking],
        &[Corpus::LaterParking(false), Corpus::LaterParking(true)],
    )
    .await
}

#[test]
fn native_batch_aba_report_requires_old_refusal_and_new_guarded_recovery() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/batch_aba_report_test.py"
        ))
        .output()
        .expect("native batch ABA report requires Python3");
    assert!(
        output.status.success(),
        "batch ABA report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs and submitted-source insertion-ABA P1 proof"]
async fn native_fixed_batch_refuses_restored_insertion_and_recovers_original() -> TestResult<()> {
    measured_selected_corpus(
        &[NativeScope::Batch(IdleRetirementBatchScope::All)],
        Corpus::BatchAba,
    )
    .await
}

#[test]
fn native_repark_report_requires_physical_history_and_guarded_recovery() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/batch_repark_report_test.py"
        ))
        .output()
        .expect("native repark report requires Python3");
    assert!(
        output.status.success(),
        "repark report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs and submitted-source physical repark P1 proof"]
async fn native_speculative_repark_preserves_history_and_batch_recovery() -> TestResult<()> {
    measured_selected_corpus(
        &[NativeScope::Batch(IdleRetirementBatchScope::All)],
        Corpus::BatchRepark,
    )
    .await
}

#[test]
fn native_replacement_report_requires_old_refusal_and_distinct_incoming_custody() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/batch_replacement_report_test.py"
        ))
        .output()
        .expect("native replacement report requires Python3");
    assert!(
        output.status.success(),
        "replacement report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs and submitted-source same-key replacement P1 proof"]
async fn native_same_key_replacement_fences_captured_batch_and_preserves_incoming() -> TestResult<()>
{
    measured_selected_corpus(&[NativeScope::Replacement], Corpus::BatchReplacement).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs, mock Codex and exact-source dual-history P1 proof"]
async fn native_same_entry_replacement_preserves_both_required_histories() -> TestResult<()> {
    measured_selected_corpora(
        &[NativeScope::Replacement],
        &[Corpus::DualHistory(false), Corpus::DualHistory(true)],
    )
    .await
}

#[test]
fn native_dual_history_report_requires_complete_bytes_and_same_entry_generations() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/dual_history_report_test.py"
        ))
        .output()
        .expect("native dual history report requires Python3");
    assert!(
        output.status.success(),
        "dual history report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_claim_rejection_report_requires_actual_request_and_original_custody() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/claim_loss_report_test.py"
        ))
        .output()
        .expect("native claim report requires Python3");
    assert!(
        output.status.success(),
        "claim rejection report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs and submitted-source provider404/rollback P1 proof"]
async fn native_provider_claim_rejection_preserves_guarded_rollback_and_required_saving()
-> TestResult<()> {
    measured_selected_corpus(
        &[NativeScope::Batch(IdleRetirementBatchScope::All)],
        Corpus::ClaimLoss,
    )
    .await
}

#[test]
fn native_real_api_claim_report_requires_both_native_owners_and_public_authority() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/real_api_claim_report_test.py"
        ))
        .output()
        .expect("native real API claim report requires Python3");
    assert!(
        output.status.success(),
        "real API claim report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an invocation-owned real API/PostgreSQL and two native Guest owners"]
async fn native_real_api_competing_claims_preserve_both_owners() -> TestResult<()> {
    measured_selected_corpus(
        &[NativeScope::Batch(IdleRetirementBatchScope::All)],
        Corpus::RealApiClaims,
    )
    .await
}

#[test]
fn native_speculative_fault_report_requires_uncertainty_and_complete_saving() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/speculative_fault_report_test.py"
        ))
        .output()
        .expect("speculative fault report requires Python3");
    assert!(
        output.status.success(),
        "speculative fault report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs and exact-source callback drop/panic required-saving proof"]
async fn native_speculative_callback_loss_preserves_uncertain_owner_and_required_saving()
-> TestResult<()> {
    measured_selected_corpora(
        &[NativeScope::Batch(IdleRetirementBatchScope::All)],
        &[
            Corpus::SpeculativeFault(false),
            Corpus::SpeculativeFault(true),
        ],
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs and exact-source provider failure P1 proof"]
async fn native_provider_failures_preserve_guarded_rollback_and_required_saving() -> TestResult<()>
{
    measured_selected_corpora(
        &[NativeScope::Batch(IdleRetirementBatchScope::All)],
        &[
            Corpus::ClaimUnavailable(claim_peer::Outcome::Decode),
            Corpus::ClaimUnavailable(claim_peer::Outcome::Disconnect),
        ],
    )
    .await
}

#[test]
fn native_claim_failure_readers_keep_unavailable_and_uncertainty_separate() {
    for file in [
        "claim_failure_report_test.py",
        "claim_producer_report_test.py",
    ] {
        let output = std::process::Command::new("python3")
            .arg(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/guarded_idle_native")
                    .join(file),
            )
            .output()
            .expect("claim failure readers require Python3");
        assert!(
            output.status.success(),
            "{file}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "preserves a failed native producer outcome and original data; requires owned KVM/NBD"]
async fn native_claim_producer_loss_retains_original_fresh() -> TestResult<()> {
    measured_selected_corpus(
        &[NativeScope::Batch(IdleRetirementBatchScope::All)],
        Corpus::ClaimProducerLost {
            cancelled: false,
            restored: false,
        },
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "preserves a failed native producer outcome and original data; requires owned KVM/NBD"]
async fn native_claim_producer_loss_retains_original_snapshot() -> TestResult<()> {
    measured_selected_corpus(
        &[NativeScope::Batch(IdleRetirementBatchScope::All)],
        Corpus::ClaimProducerLost {
            cancelled: false,
            restored: true,
        },
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "preserves cancelled observation and failed producer outcome; requires owned KVM/NBD"]
async fn native_cancelled_claim_observer_retains_original_fresh() -> TestResult<()> {
    measured_selected_corpus(
        &[NativeScope::Batch(IdleRetirementBatchScope::All)],
        Corpus::ClaimProducerLost {
            cancelled: true,
            restored: false,
        },
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "preserves cancelled observation and failed producer outcome; requires owned KVM/NBD"]
async fn native_cancelled_claim_observer_retains_original_snapshot() -> TestResult<()> {
    measured_selected_corpus(
        &[NativeScope::Batch(IdleRetirementBatchScope::All)],
        Corpus::ClaimProducerLost {
            cancelled: true,
            restored: true,
        },
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs and submitted-source status-failure P1 proof"]
async fn native_status_failure_preserves_saving_and_retries_current_inventory() -> TestResult<()> {
    measured_selected_corpus(
        &[NativeScope::Batch(IdleRetirementBatchScope::All)],
        Corpus::StatusFailure,
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs and submitted-source observer-loss P1 proof"]
async fn native_observer_loss_keeps_required_saving_and_independent_progress() -> TestResult<()> {
    measured_selected_corpora(
        &[NativeScope::Batch(IdleRetirementBatchScope::All)],
        &[Corpus::ObserverLoss(false), Corpus::ObserverLoss(true)],
    )
    .await
}

#[test]
fn native_read_cancellation_report_requires_actual_bytes_and_retained_custody() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/read_cancellation_report_test.py"
        ))
        .output()
        .expect("native read cancellation report requires Python3");
    assert!(
        output.status.success(),
        "read cancellation report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs and exact-source accepted read cancellation P1 proof"]
async fn native_read_cancellation_retains_actual_io_through_drain() -> TestResult<()> {
    measured_selected_corpus(&[NativeScope::Startup], Corpus::ReadCancellation).await
}

#[tokio::test]
#[ignore = "requires explicit packaged Guest artifacts, KVM, original supplied bounds and P1 collector"]
async fn native_read_revocation_retains_accepted_custody_through_recovery() -> TestResult<()> {
    measured_selected_corpus(&[NativeScope::Startup], Corpus::ReadRevocation).await
}

#[tokio::test]
#[ignore = "requires explicit packaged Guest artifacts, KVM, original supplied bounds and P1 collector"]
async fn native_pressure_shutdown_retains_independent_accepted_reads() -> TestResult<()> {
    measured_selected_corpus(&[NativeScope::Startup], Corpus::ReadStop).await
}

#[test]
fn native_read_stop_report_requires_separate_sampler_and_file_joins() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/read_stop_report_test.py"
        ))
        .output()
        .expect("native read stop requires Python 3");
    assert!(
        output.status.success(),
        "native read stop report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_read_revocation_report_requires_stale_recovery_and_retained_custody() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/read_revocation_report_test.py"
        ))
        .output()
        .expect("native read revocation requires Python 3");
    assert!(
        output.status.success(),
        "native read revocation report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn native_shared_reads_report_requires_aggregate_custody_and_independent_completion() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/shared_reads_report_test.py"
        ))
        .output()
        .expect("shared read report requires Python3");
    assert!(
        output.status.success(),
        "shared read report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs and final-source concurrent read P1 proof"]
async fn native_shared_reads_retain_independent_physical_custody() -> TestResult<()> {
    measured_selected_corpus(&[NativeScope::Startup], Corpus::SharedReads).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs and exact-source actual create cancellation proof"]
async fn native_create_cancellation_retains_actual_transaction_through_rollback() -> TestResult<()>
{
    measured_selected_corpus(&[NativeScope::OptionalOrdinary], Corpus::CreateCancellation).await
}

#[test]
fn native_create_report_requires_real_bytes_and_positive_rollback() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/create_cancellation_report_test.py"
        ))
        .output()
        .expect("create report requires Python3");
    assert!(
        output.status.success(),
        "create report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires owned KVM/NBD inputs and exact-source actual returned Guest proof"]
async fn native_returned_guest_cancellation_retains_actual_stages_and_late_cleanup()
-> TestResult<()> {
    use sandbox_firecracker::GuestPreparationStage::{Mount, Park, Start};
    measured_selected_corpora(
        &[NativeScope::OptionalOrdinary],
        &[
            Corpus::ReturnedGuest(Start),
            Corpus::ReturnedGuest(Mount),
            Corpus::ReturnedGuest(Park),
        ],
    )
    .await
}

#[test]
fn native_returned_guest_report_requires_actual_late_results_and_cleanup() {
    let output = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/guarded_idle_native/returned_guest_report_test.py"
        ))
        .output()
        .expect("returned Guest report requires Python3");
    assert!(
        output.status.success(),
        "returned Guest report failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
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
    measured_selected_corpora(scopes, &[corpus]).await
}

async fn measured_selected_corpora(scopes: &[NativeScope], corpora: &[Corpus]) -> TestResult<()> {
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
    let result = async {
        for corpus in corpora {
            if *corpus == Corpus::RealApiClaims {
                let claimant = |second| {
                    let (runtime, base, inputs, artifacts) = (&runtime, &base, &inputs, &artifacts);
                    async move {
                        let result = exercise_selected_factories(
                            runtime,
                            base,
                            inputs,
                            scopes,
                            Some(artifacts),
                            Corpus::RealApiClaimant(second),
                        )
                        .await;
                        if result.is_err() {
                            real_api_claims::release_failed_gates()?;
                        }
                        result
                    }
                };
                let (a, b) = tokio::join!(claimant(false), claimant(true));
                a?;
                b?;
                continue;
            }
            exercise_selected_factories(
                &runtime,
                &base,
                &inputs,
                scopes,
                Some(&artifacts),
                *corpus,
            )
            .await?;
        }
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    }
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
    snapshot_preparation::prepare(sandbox::SnapshotCreateConfig {
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
            if let Corpus::FixedRestore(selected) = corpus
                && selected.restored != restored
            {
                continue;
            }
            if let Corpus::ClaimProducerLost {
                restored: selected, ..
            } = corpus
                && selected != restored
            {
                continue;
            }
            // Never share a production Runner directory or another invocation's cache.
            let owned = tempfile::tempdir_in(base)?.keep();
            let paths = RunnerPaths::new(owned.clone());
            let proof = artifacts
                .map(|artifacts| {
                    evidence::Case::new(
                        format!(
                            "{}-{}",
                            if corpus == Corpus::LogicalProgress {
                                "LogicalProgress".into()
                            } else if corpus == Corpus::IncomingProgress {
                                format!("Incoming{scope:?}")
                            } else if corpus == Corpus::CriticalProgress {
                                "CriticalProgress".into()
                            } else if corpus == Corpus::ReadCancellation {
                                "ReadCancellation".into()
                            } else if corpus == Corpus::ReadRevocation {
                                "ReadRevocation".into()
                            } else if corpus == Corpus::ReadStop {
                                "ReadStop".into()
                            } else if corpus == Corpus::SharedReads {
                                "SharedReads".into()
                            } else if corpus == Corpus::CreateCancellation {
                                "CreateCancellation".into()
                            } else if let Corpus::ObserverLoss(panic) = corpus {
                                format!("Observer{}", if panic { "Panic" } else { "Drop" })
                            } else if corpus == Corpus::StatusFailure {
                                "StatusFailure".into()
                            } else if let Corpus::LaterParking(blank) = corpus {
                                format!("Later{}", if blank { "Blank" } else { "Exact" })
                            } else if corpus == Corpus::BatchAba {
                                "BatchAba".into()
                            } else if corpus == Corpus::BatchRepark {
                                "BatchRepark".into()
                            } else if corpus == Corpus::BatchReplacement {
                                "BatchReplacement".into()
                            } else if let Corpus::DualHistory(nonzero) = corpus {
                                format!(
                                    "DualHistory{}",
                                    if nonzero { "Nonzero" } else { "Success" }
                                )
                            } else if corpus == Corpus::ClaimLoss {
                                "ClaimLoss".into()
                            } else if let Corpus::SpeculativeFault(panic) = corpus {
                                format!("Speculative{}", if panic { "Panic" } else { "Drop" })
                            } else if let Corpus::ClaimUnavailable(outcome) = corpus {
                                format!("ClaimUnavailable-{}", outcome.label())
                            } else if let Corpus::ClaimProducerLost { cancelled, .. } = corpus {
                                format!(
                                    "ClaimProducerLost-{}",
                                    if cancelled { "cancelled" } else { "observed" }
                                )
                            } else if let Corpus::RealApiClaimant(second) = corpus {
                                format!(
                                    "RealClaim-{}-{}",
                                    real_api_claims::order()?,
                                    if second { "b" } else { "a" }
                                )
                            } else if let Corpus::NativeUnpark(fault) = corpus {
                                fault.name().into()
                            } else if let Corpus::NativePause(fault) = corpus {
                                fault.pause_name().into()
                            } else if let Corpus::FixedRestore(selected) = corpus {
                                selected.label()
                            } else if let Corpus::ReturnedGuest(stage) = corpus {
                                format!("ReturnedGuest-{}", stage.label())
                            } else if corpus == Corpus::Continuation {
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
            let config = FactoryConfig {
                home_drive_pressure: None,
                profile: fixture::PROFILE.into(),
                binary_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_FIRECRACKER")?),
                kernel_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_KERNEL")?),
                rootfs_path: PathBuf::from(std::env::var("OKOU_TEST_RPC_ROOTFS")?),
                base_dir: owned.clone(),
                snapshot,
            };
            let create_probe = (corpus == Corpus::CreateCancellation)
                .then(create_cancellation::Probe::new)
                .transpose()?
                .map(Arc::new);
            let returned_probe = if let Corpus::ReturnedGuest(stage) = corpus {
                Some(Arc::new(returned_guest_probe::Probe::new(
                    stage,
                    owned.clone(),
                )?))
            } else {
                None
            };
            let claim_probe =
                matches!(corpus, Corpus::ClaimProducerLost { .. }).then(claim_restore::Probe::new);
            let factory = if let Some(probe) = &create_probe {
                let inner = runtime
                    .create_factory_with_home_checkpoint_for_test(config, probe.checkpoint())
                    .await?;
                Box::new(create_cancellation::Factory {
                    inner,
                    probe: probe.clone(),
                    directory: owned.clone(),
                }) as Box<dyn SandboxFactory>
            } else if let Some(probe) = &returned_probe {
                let inner = runtime
                    .create_factory_with_guest_checkpoint_for_test(config, probe.checkpoint())
                    .await?;
                Box::new(returned_guest_probe::Factory {
                    inner,
                    probe: probe.clone(),
                }) as Box<dyn SandboxFactory>
            } else if let Some(probe) = &claim_probe {
                runtime
                    .create_factory_with_guest_checkpoint_for_test(config, probe.checkpoint())
                    .await?
            } else {
                runtime.create_factory(config).await?
            };
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
                CaseMode { corpus, restored },
                if let Some(probe) = &create_probe {
                    PreparationProbe::Create(probe)
                } else if let Some(probe) = &returned_probe {
                    PreparationProbe::Returned(probe)
                } else if let Some(probe) = &claim_probe {
                    PreparationProbe::Claim(probe)
                } else {
                    PreparationProbe::None
                },
            )
            .await;
            // A failed measured case is not permission to tear down dependencies
            // or delete its files. Accepted cleanup retains its own factory owner.
            let result = match result {
                Err(error) if proof.is_some() => return Err(error),
                result => result,
            };
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

struct CaseMode {
    corpus: Corpus,
    restored: bool,
}

async fn exercise_retirement(
    factory: Arc<Box<dyn SandboxFactory>>,
    paths: RunnerPaths,
    inputs: &fixture::Inputs,
    scope: NativeScope,
    proof: Option<&Arc<evidence::Case>>,
    mode: CaseMode,
    preparation_probe: PreparationProbe<'_>,
) -> TestResult<()> {
    let CaseMode { corpus, restored } = mode;
    let status = Arc::new(StatusTracker::new(
        paths.base_dir().join("status.json"),
        1,
        None,
        None,
    ));
    status.write_initial().await?;
    let cache = HomeImageCache::new(paths.clone()).with_actual_fs_stats_for_test();
    let real_claim = if let Corpus::RealApiClaimant(second) = corpus {
        Some(real_api_claims::Input::load(second, restored)?)
    } else {
        None
    };
    let run_id = real_claim
        .as_ref()
        .map(|input| input.original_run_id)
        .unwrap_or_else(RunId::new_v4);
    let sandbox_id = SandboxId::new_v4();
    let fixed_probe = matches!(corpus, Corpus::FixedRestore(_))
        .then(|| fixed_restore::Probe::new(sandbox_id.to_string()))
        .transpose()?;
    let full_session = corpus == Corpus::Continuation || fixed_probe.is_some();
    let reuse_key = real_claim
        .as_ref()
        .map(|input| input.reuse_key.clone())
        .unwrap_or_else(|| format!("thread:native-guarded-{run_id}"));
    let rootfs_hash = std::env::var("OKOU_TEST_IDLE_ROOTFS_HASH")?;
    if rootfs_hash.is_empty() {
        return Err(io::Error::other("packaged rootfs hash must be supplied").into());
    }
    let recovery_source = (matches!(
        corpus,
        Corpus::LogicalProgress
            | Corpus::IncomingProgress
            | Corpus::CreateCancellation
            | Corpus::ReturnedGuest(_)
            | Corpus::BatchAba
            | Corpus::BatchRepark
            | Corpus::BatchReplacement
            | Corpus::DualHistory(_)
    ) || matches!(
        scope,
        NativeScope::Recovery
            | NativeScope::Critical
            | NativeScope::Startup
            | NativeScope::ForegroundFresh
            | NativeScope::ForegroundReuse
    ))
    .then(|| Arc::new(recovery_source::Source::new()));
    let operations = match &recovery_source {
        Some(source) => inputs.operations_with_source(source.clone())?,
        None => inputs.operations()?,
    };
    let budget = native_budget(scope);
    if let Corpus::DualHistory(nonzero) = corpus {
        return dual_history::exercise(dual_history::Setup {
            factory,
            paths,
            cache,
            status,
            budget,
            operations,
            source: recovery_source
                .as_deref()
                .ok_or_else(|| io::Error::other("dual history source missing"))?,
            proof: proof.ok_or_else(|| io::Error::other("dual history proof missing"))?,
            inputs,
            rootfs: rootfs_hash,
            original: run_id,
            id: sandbox_id,
            key: reuse_key,
            nonzero,
        })
        .await;
    }
    let mut first_lease = None;
    let mut session_identity = None;
    let mut original_history = Vec::new();
    let mut storage_fingerprints = StorageFingerprints::default();
    let mut original_exit = 0;
    let mut continuation_fixture = None;
    let (mut sandbox, home) = if full_session {
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
            corpus == Corpus::Continuation && matches!(scope, NativeScope::Batch(_)),
        )
        .await?;
        let execution = continuation.execute(continuation::Execution {
            factory: factory.clone(),
            operations: operations.clone(),
            inputs,
            run: run_id,
            id: sandbox_id,
            key: reuse_key.clone(),
            history: continuation::SEED.to_vec(),
            original: run_id,
            continued: false,
        });
        let result = match &fixed_probe {
            Some(probe) => probe.scope.scope(execution).await,
            None => execution.await,
        };
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
        if fixed_probe.is_some() {
            proof.fixed_restore_witness("original_session", serde_json::json!({
                "history_run_id":run_id,"thread_id":continuation.session()?.0,
                "history_hex":hex::encode(&prepared.history),
                "history_sha256":continuation::digest(&prepared.history),
                "history_bytes":prepared.history.len(),"final_identity_verified":prepared.identity.is_some(),
                "physical_history":fixed_restore::session_file(&*prepared.sandbox,&continuation.session()?.0).await?,
                "executor_completed":true,"exit_code":prepared.exit_code,
            }))?;
        }
        original_history = std::mem::take(&mut prepared.history);
        continuation_fixture = Some(continuation);
        (prepared.sandbox, prepared.home)
    } else {
        let mut home =
            fixture::checkout(&cache, run_id, sandbox_id, &reuse_key, &rootfs_hash).await;
        let mut sandbox = factory
            .create(fixture::sandbox_config(sandbox_id, &mut home).await?)
            .await?;
        if let Err(error) = fixture::prepare_guest(&mut *sandbox, run_id).await {
            factory.destroy(sandbox).await;
            return Err(error);
        }
        (sandbox, home)
    };
    if full_session && let Err(error) = fixture::prepare_started_guest(&mut *sandbox, run_id).await
    {
        if let Some(proof) = proof {
            proof.retain(sandbox);
            proof.retain(home);
            proof.retain(first_lease);
        }
        return Err(error);
    }
    if let Some(proof) = proof
        && !full_session
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
        if matches!(
            corpus,
            Corpus::ClaimProducerLost { .. } | Corpus::FixedRestore(_)
        ) {
            let digest = fixture::verify_speculative_guest(&*sandbox, run_id).await?;
            fixture::exec(&*sandbox, "sync").await?;
            let proof = proof.ok_or_else(|| io::Error::other("request loss proof absent"))?;
            let value = serde_json::json!({
                "history_run_id": run_id, "payload_sha256": digest,
                "payload_bytes": fixture::PAYLOAD_BYTES, "original_private_and_home_verified": true,
                "guest_sync_completed": true,
            });
            if fixed_probe.is_some() {
                proof.fixed_restore_witness("original_data_durable", value)?;
            } else {
                proof.claim_producer_witness("original_data_durable", value)?;
            }
        }
        let backing = sandbox
            .backing_process()
            .ok_or_else(|| io::Error::other("Firecracker supplied no exact backing capability"))?;
        if sandbox.park().await? != SandboxParkOutcome::Reusable {
            return Err(io::Error::other("native fixture could not physically park").into());
        }
        let lease = if full_session {
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
        max_idle: match scope {
            NativeScope::Critical => 3,
            NativeScope::OptionalOrdinary => 2,
            _ => 1,
        },
    });
    let tracker = IdleDestroyTracker::new(Arc::new(Notify::new()));
    if (matches!(
        corpus,
        Corpus::Optional
            | Corpus::CreateCancellation
            | Corpus::ReturnedGuest(_)
            | Corpus::ObserverLoss(_)
            | Corpus::StatusFailure
            | Corpus::LaterParking(_)
            | Corpus::BatchAba
            | Corpus::BatchRepark
            | Corpus::BatchReplacement
            | Corpus::ClaimLoss
            | Corpus::SpeculativeFault(_)
            | Corpus::ClaimUnavailable(_)
            | Corpus::ClaimProducerLost { .. }
            | Corpus::RealApiClaimant(_)
            | Corpus::NativeUnpark(_)
            | Corpus::NativePause(_)
    ) || matches!(corpus, Corpus::LogicalProgress | Corpus::IncomingProgress)
        || matches!(
            scope,
            NativeScope::Recovery
                | NativeScope::Critical
                | NativeScope::Startup
                | NativeScope::ForegroundFresh
                | NativeScope::ForegroundReuse
        ))
        && let Some(proof) = proof
    {
        proof.bind_original_lease(&lease)?;
    }
    let candidate = ParkedIdleCandidateBuilder::new(&reuse_key, lease)
        .with_source_run_id(run_id)
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
    let candidate = if let Some(input) = &real_claim {
        candidate
            .with_last_completed_at(input.original_completed_at.clone())
            .with_guest_timezone_intent(
                runner_lifecycle::guest_timezone::GuestTimezoneIntent::from_context(
                    &input.predecessor_context,
                ),
            )
    } else if matches!(
        corpus,
        Corpus::ClaimLoss | Corpus::ClaimUnavailable(_) | Corpus::ClaimProducerLost { .. }
    ) {
        candidate.with_last_completed_at(chrono::Utc::now().to_rfc3339())
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
            NativeScope::Replacement if corpus == Corpus::BatchReplacement => {
                batch_replacement::exercise(transitions::Context {
                    factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                    operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                    rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                }, inputs, recovery_source.as_deref().ok_or_else(|| io::Error::other("replacement source missing"))?,
                   proof.ok_or_else(|| io::Error::other("replacement proof missing"))?, paths.base_dir(), backing.clone(), None).await?;
                Ok(None)
            }
            NativeScope::LaterParking => {
                let Corpus::LaterParking(blank) = corpus else {
                    return Err(io::Error::other("later parking corpus missing").into());
                };
                later_parking::exercise(transitions::Context {
                    factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                    operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                    rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                }, inputs, proof.ok_or_else(|| io::Error::other("later parking proof missing"))?,
                    paths.base_dir(), backing.clone(), blank).await?;
                Ok(None)
            }
            NativeScope::ForegroundFresh | NativeScope::ForegroundReuse => {
                foreground::exercise(foreground::Request { context: transitions::Context {
                    factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                    operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                    rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                }, inputs, source: recovery_source.as_ref().ok_or_else(|| io::Error::other("native foreground source missing"))?,
                proof, directory: paths.base_dir(), backing: backing.clone(), original_run: run_id,
                fresh: matches!(scope, NativeScope::ForegroundFresh), fences: corpus == Corpus::Fences }).await?;
                Ok(None)
            }
            NativeScope::Startup => {
                if corpus == Corpus::ReadStop {
                    read_stop::exercise(transitions::Context {
                        factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                        operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                        rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                    }, inputs, recovery_source.as_ref().ok_or_else(|| io::Error::other("read stop source missing"))?, proof, paths.base_dir()).await?;
                    return Ok(None);
                }
                if corpus == Corpus::ReadRevocation {
                    read_revocation::exercise(transitions::Context {
                        factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                        operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                        rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                    }, inputs, recovery_source.as_ref().ok_or_else(|| io::Error::other("shared read source missing"))?, proof, paths.base_dir()).await?;
                    return Ok(None);
                }
                if corpus == Corpus::SharedReads {
                    shared_reads::exercise(transitions::Context {
                        factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                        operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                        rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                    }, inputs, recovery_source.as_ref().ok_or_else(|| io::Error::other("shared read source missing"))?, proof, paths.base_dir()).await?;
                    return Ok(None);
                }
                if corpus == Corpus::ReadCancellation {
                    read_cancellation::exercise(transitions::Context {
                        factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                        operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                        rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                    }, inputs, recovery_source.as_ref().ok_or_else(|| io::Error::other("read cancellation source missing"))?, proof, paths.base_dir()).await?;
                    return Ok(None);
                }
                startup::exercise(transitions::Context {
                    factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                    operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                    rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                }, inputs, recovery_source.as_ref().ok_or_else(|| io::Error::other("native startup source missing"))?, proof).await?;
                Ok(None)
            }
            NativeScope::Critical => {
                critical::exercise(transitions::Context {
                    factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                    operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                    rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                }, inputs, recovery_source.as_ref().ok_or_else(|| io::Error::other("native Critical source missing"))?, proof,
                    (corpus == Corpus::CriticalProgress).then(|| critical_progress::Request {
                        directory: paths.base_dir(), backing: backing.clone(), original: run_id,
                    })).await?;
                Ok(None)
            }
            NativeScope::Recovery => {
                recovery::exercise(transitions::Context {
                    factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                    operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                    rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                }, inputs, paths.base_dir(), recovery_source.as_ref().ok_or_else(|| io::Error::other("native recovery source missing"))?, proof).await?;
                Ok(None)
            }
            NativeScope::OptionalOrdinary | NativeScope::OptionalAged => {
                if matches!(corpus, Corpus::ReturnedGuest(_)) {
                    let PreparationProbe::Returned(probe) = preparation_probe else {
                        return Err(io::Error::other("returned Guest probe absent").into());
                    };
                    returned_guest::exercise(transitions::Context {
                        factory:factory.clone(),pool:pool.clone(),status:status.clone(),operations:operations.clone(),
                        budget:budget.clone(),tracker:tracker.clone(),rootfs_hash:rootfs_hash.clone(),reuse_key:reuse_key.clone(),
                    },inputs,recovery_source.as_ref().ok_or_else(||io::Error::other("returned Guest source absent"))?,
                    proof.ok_or_else(||io::Error::other("returned Guest proof absent"))?, paths.base_dir(),
                    probe).await?;
                    return Ok(None);
                }
                if corpus == Corpus::CreateCancellation {
                    let PreparationProbe::Create(probe) = preparation_probe else {
                        return Err(io::Error::other("create probe absent").into());
                    };
                    create_cancellation::exercise(transitions::Context {
                        factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                        operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                        rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                    }, inputs, recovery_source.as_ref().ok_or_else(|| io::Error::other("create source absent"))?,
                    proof, paths.base_dir(), probe).await?;
                    return Ok(None);
                }
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
                if corpus == Corpus::IncomingProgress {
                    let lease = incoming_progress::exercise(incoming_progress::Request {
                        context: transitions::Context {
                            factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                            operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                            rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                        }, inputs, source: recovery_source.as_ref().ok_or_else(|| io::Error::other("incoming source missing"))?,
                        proof: proof.ok_or_else(|| io::Error::other("incoming proof missing"))?,
                        directory: paths.base_dir(), backing: backing.clone(), scope,
                    }).await?;
                    return Ok(Some(lease));
                }
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
                if let Corpus::FixedRestore(selected) = corpus {
                    let proof = proof.ok_or_else(|| io::Error::other("fixed restore proof absent"))?;
                    proof.retain(continuation_fixture.take());
                    return fixed_restore::exercise(fixed_restore::Request {
                        context: transitions::Context {
                            factory:factory.clone(),pool:pool.clone(),status:status.clone(),
                            operations:operations.clone(),budget:budget.clone(),tracker:tracker.clone(),
                            rootfs_hash:rootfs_hash.clone(),reuse_key:reuse_key.clone(),
                        }, inputs, proof, directory:paths.base_dir(), backing:backing.clone(),
                        history:run_id, selection:selected, cache:&cache,
                        probe:fixed_probe.as_ref().ok_or_else(||io::Error::other("fixed connection missing"))?,
                    }).await.map(|()| None);
                }
                let speculative_injection = match corpus {
                    Corpus::SpeculativeFault(panic) => Some(speculative_fault::Injection::Callback(panic)),
                    Corpus::NativeUnpark(fault) => Some(speculative_fault::Injection::Native(fault)),
                    Corpus::NativePause(fault) => Some(speculative_fault::Injection::NativePause(fault)),
                    _ => None,
                };
                if let Some(injection) = speculative_injection {
                    speculative_fault::exercise(transitions::Context {
                        factory:factory.clone(),pool:pool.clone(),status:status.clone(),
                        operations:operations.clone(),budget:budget.clone(),tracker:tracker.clone(),
                        rootfs_hash:rootfs_hash.clone(),reuse_key:reuse_key.clone(),
                    },inputs,proof.ok_or_else(||io::Error::other("speculative fault proof missing"))?,
                    paths.base_dir(),backing.clone(),run_id,injection).await?;
                    return Ok(None);
                }
                if let Corpus::ClaimProducerLost { cancelled, .. } = corpus {
                    let PreparationProbe::Claim(restore) = preparation_probe else {
                        return Err(io::Error::other("native claim restore observation missing").into());
                    };
                    return claim_producer::exercise(claim_producer::Request {
                        context: transitions::Context {
                            factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                            operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                            rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                        }, inputs, proof: proof.ok_or_else(|| io::Error::other("claim producer proof absent"))?,
                        directory: paths.base_dir(), backing: backing.clone(), history: run_id,
                        restore, cancelled, cache: &cache,
                    }).await.map(|()| None);
                }
                if let Corpus::ClaimUnavailable(outcome) = corpus {
                    claim_loss::exercise_failure(transitions::Context {
                        factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                        operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                        rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                    }, inputs, proof.ok_or_else(|| io::Error::other("claim failure proof absent"))?,
                    paths.base_dir(), backing.clone(), run_id, outcome).await?;
                    return Ok(None);
                }
                if let Some(input) = &real_claim {
                    real_api_claims::exercise(transitions::Context {
                        factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                        operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                        rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                    }, inputs, proof.ok_or_else(|| io::Error::other("real claim proof missing"))?,
                        paths.base_dir(), backing.clone(), input).await?;
                    return Ok(None);
                }
                if corpus == Corpus::ClaimLoss {
                    claim_loss::exercise(transitions::Context {
                        factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                        operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                        rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                    }, inputs, proof.ok_or_else(|| io::Error::other("claim proof missing"))?,
                    paths.base_dir(), backing.clone(), run_id).await?;
                    return Ok(None);
                }
                if matches!(corpus, Corpus::BatchAba | Corpus::BatchRepark) {
                    batch_aba::exercise(
                        transitions::Context {
                            factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                            operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                            rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                        }, inputs,
                        recovery_source.as_ref().ok_or_else(|| io::Error::other("batch ABA source missing"))?,
                        proof.ok_or_else(|| io::Error::other("batch ABA proof missing"))?,
                        paths.base_dir(), backing.clone(),
                        (corpus == Corpus::BatchRepark).then_some(run_id),
                    ).await?;
                    return Ok(None);
                }
                if corpus == Corpus::StatusFailure {
                    status_failure::exercise(
                        transitions::Context {
                            factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                            operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                            rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                        }, inputs, proof.ok_or_else(|| io::Error::other("status failure proof missing"))?,
                        paths.base_dir(),
                    ).await?;
                    return Ok(None);
                }
                if let Corpus::ObserverLoss(panic) = corpus {
                    observer_loss::exercise(
                        transitions::Context {
                            factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                            operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                            rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                        }, inputs, proof.ok_or_else(|| io::Error::other("observer loss proof missing"))?,
                        paths.base_dir(), panic,
                    ).await?;
                    return Ok(None);
                }
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
            NativeScope::Logical if corpus == Corpus::LogicalProgress => {
                let lease = logical_progress::exercise(logical_progress::Request {
                    context: transitions::Context {
                        factory: factory.clone(), pool: pool.clone(), status: status.clone(),
                        operations: operations.clone(), budget: budget.clone(), tracker: tracker.clone(),
                        rootfs_hash: rootfs_hash.clone(), reuse_key: reuse_key.clone(),
                    }, inputs, source: recovery_source.as_ref().ok_or_else(|| io::Error::other("logical source missing"))?,
                    proof: proof.ok_or_else(|| io::Error::other("logical proof missing"))?,
                    directory: paths.base_dir(), backing: backing.clone(),
                }).await?;
                Ok(Some(lease))
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
                            .create(fixture::sandbox_config(next_id, &mut home).await?)
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
    if matches!(
        corpus,
        Corpus::CreateCancellation | Corpus::ReturnedGuest(_)
    ) {
        assert_eq!(
            (
                report.registered_operations,
                report.tracked_tasks,
                report.started,
                report.uncertain
            ),
            (1, 0, 0, 1)
        );
        assert_eq!(
            report.ordinary_growth_bytes,
            4096 * 1024 * 1024 + inputs.preparation_bytes()
        );
        assert_eq!(report.cleanup_growth_bytes, 0);
        if let Some(proof) = proof {
            let evidence = serde_json::json!({
                "registered_operations": report.registered_operations, "tracked_tasks": report.tracked_tasks,
                "started": report.started, "uncertain": report.uncertain,
                "ordinary_growth_bytes": report.ordinary_growth_bytes, "cleanup_growth_bytes": report.cleanup_growth_bytes,
                "closed": report.closed, "allocated": budget.allocated(),
            });
            if matches!(corpus, Corpus::ReturnedGuest(_)) {
                proof.returned_guest_witness("accounting_closed", evidence)?;
            } else {
                proof.create_cancellation_witness("accounting_closed", evidence)?;
            }
        }
    } else {
        assert_eq!((report.registered_operations, report.tracked_tasks), (0, 0));
    }
    let next_run = RunId::new_v4();
    let next_id = SandboxId::new_v4();
    let mut restored = fixture::checkout(&cache, next_run, next_id, &reuse_key, &rootfs_hash).await;
    assert!(restored.is_cache_hit());
    let mut sandbox = factory
        .create(fixture::sandbox_config(next_id, &mut restored).await?)
        .await?;
    let checked = async {
        sandbox.bind_run_control(&next_run.to_string())?;
        sandbox.start().await?;
        ensure_home_drive_mounted(&*sandbox, next_run)
            .await
            .map_err(|failure| failure.error)?;
        fixture::verify_saved_guest(&*sandbox, run_id).await?;
        if let Some(input) = &real_claim {
            real_api_claims::verify_saved(
                &*sandbox,
                paths.base_dir(),
                input,
                proof.ok_or_else(|| io::Error::other("saved real claim proof missing"))?,
            )
            .await?;
        }
        Ok::<(), Box<dyn Error + Send + Sync>>(())
    }
    .await;
    factory.destroy(sandbox).await;
    checked
}
