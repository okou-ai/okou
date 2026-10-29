use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU32, Ordering},
};
use std::time::Duration;

use runner_host::lock;

const SNAPSHOT_PUBLISH_SCENARIO_TIMEOUT: Duration = Duration::from_secs(5);
const SNAPSHOT_PUBLISH_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);
const SNAPSHOT_LOCK_POLL_INTERVAL: Duration = Duration::from_millis(10);

type SnapshotPublishWaiter = tokio::task::JoinHandle<RunnerResult<sandbox::SnapshotOutput>>;

#[derive(Debug, PartialEq, Eq)]
enum SnapshotLockState {
    Held,
    Available,
    ProbeFailed(String),
}

impl std::fmt::Display for SnapshotLockState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Held => f.write_str("held"),
            Self::Available => f.write_str("available"),
            Self::ProbeFailed(error) => write!(f, "probe failed: {error}"),
        }
    }
}

#[derive(Debug)]
struct SnapshotPublishPhaseTimeout {
    phase: &'static str,
    lock_state: SnapshotLockState,
}

#[derive(Debug, PartialEq, Eq)]
struct SnapshotPublishScenarioTimeout {
    phase: &'static str,
    lock_state: SnapshotLockState,
    cleanup_lock_state: SnapshotLockState,
}

impl std::fmt::Display for SnapshotPublishScenarioTimeout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "timed out waiting for snapshot publish phase '{}'; snapshot lock was {} before cleanup and {} after cleanup",
            self.phase, self.lock_state, self.cleanup_lock_state
        )
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CommitGateBehavior {
    Release,
    WithholdForTimeout,
}

struct RecordingPendingSnapshotPublish {
    output_dir: PathBuf,
    committed: Arc<AtomicBool>,
}

#[async_trait::async_trait]
impl sandbox::PendingSnapshotPublish for RecordingPendingSnapshotPublish {
    async fn commit(&mut self) -> Result<sandbox::SnapshotOutput, sandbox::SnapshotError> {
        self.committed.store(true, Ordering::SeqCst);
        let output = sandbox::SnapshotOutput {
            snapshot_path: self.output_dir.join("snapshot.bin"),
            memory_path: self.output_dir.join("memory.bin"),
            cow_path: self.output_dir.join("cow.img"),
        };
        tokio::fs::write(&output.snapshot_path, b"snapshot").await?;
        tokio::fs::write(&output.memory_path, b"memory").await?;
        tokio::fs::write(&output.cow_path, b"cow").await?;
        Ok(output)
    }

    async fn discard(&mut self) -> Result<(), sandbox::SnapshotError> {
        Ok(())
    }
}

struct RecordingSnapshotProvider {
    create_uncommitted_called: Arc<AtomicBool>,
    create_snapshot_called: Arc<AtomicBool>,
    committed: Arc<AtomicBool>,
    home_disk_mb: Arc<AtomicU32>,
}

#[async_trait::async_trait]
impl SnapshotProvider for RecordingSnapshotProvider {
    async fn create_uncommitted_snapshot(
        &self,
        config: sandbox::SnapshotCreateConfig,
    ) -> Result<Box<dyn sandbox::PendingSnapshotPublish>, sandbox::SnapshotError> {
        self.create_uncommitted_called.store(true, Ordering::SeqCst);
        self.home_disk_mb
            .store(config.home_disk_mb, Ordering::SeqCst);
        Ok(Box::new(RecordingPendingSnapshotPublish {
            output_dir: config.output_dir,
            committed: Arc::clone(&self.committed),
        }))
    }

    async fn create_snapshot(
        &self,
        _config: sandbox::SnapshotCreateConfig,
    ) -> Result<sandbox::SnapshotOutput, sandbox::SnapshotError> {
        self.create_snapshot_called.store(true, Ordering::SeqCst);
        Err(sandbox::SnapshotError::Setup(
            "build_snapshot should use create_uncommitted_snapshot".into(),
        ))
    }

    fn config_hash(&self) -> String {
        "recording-provider".into()
    }

    async fn is_complete(&self, _output_dir: &Path) -> Result<bool, sandbox::SnapshotError> {
        Ok(false)
    }
}

struct FailingPendingSnapshotPublish {
    discarded: Arc<AtomicBool>,
    discard_error: Option<&'static str>,
}

#[async_trait::async_trait]
impl sandbox::PendingSnapshotPublish for FailingPendingSnapshotPublish {
    async fn commit(&mut self) -> Result<sandbox::SnapshotOutput, sandbox::SnapshotError> {
        Err(sandbox::SnapshotError::Teardown("publish failed".into()))
    }

    async fn discard(&mut self) -> Result<(), sandbox::SnapshotError> {
        self.discarded.store(true, Ordering::SeqCst);
        match self.discard_error {
            Some(message) => Err(sandbox::SnapshotError::Teardown(message.into())),
            None => Ok(()),
        }
    }
}

struct FailingSnapshotProvider {
    discarded: Arc<AtomicBool>,
    discard_error: Option<&'static str>,
}

#[async_trait::async_trait]
impl SnapshotProvider for FailingSnapshotProvider {
    async fn create_uncommitted_snapshot(
        &self,
        _config: sandbox::SnapshotCreateConfig,
    ) -> Result<Box<dyn sandbox::PendingSnapshotPublish>, sandbox::SnapshotError> {
        Ok(Box::new(FailingPendingSnapshotPublish {
            discarded: Arc::clone(&self.discarded),
            discard_error: self.discard_error,
        }))
    }

    fn config_hash(&self) -> String {
        "failing-provider".into()
    }

    async fn is_complete(&self, _output_dir: &Path) -> Result<bool, sandbox::SnapshotError> {
        Ok(false)
    }
}

enum ControlledCommitOutcome {
    Success,
    Failure,
}

struct ControlledPendingSnapshotPublish {
    output_dir: PathBuf,
    commit_outcome: ControlledCommitOutcome,
    commit_entered: Option<tokio::sync::oneshot::Sender<()>>,
    commit_release: Option<tokio::sync::oneshot::Receiver<()>>,
    commit_done: Option<tokio::sync::oneshot::Sender<()>>,
    discard_entered: Option<tokio::sync::oneshot::Sender<()>>,
    discard_release: Option<tokio::sync::oneshot::Receiver<()>>,
    discard_done: Option<tokio::sync::oneshot::Sender<()>>,
}

#[async_trait::async_trait]
impl sandbox::PendingSnapshotPublish for ControlledPendingSnapshotPublish {
    async fn commit(&mut self) -> Result<sandbox::SnapshotOutput, sandbox::SnapshotError> {
        if let Some(tx) = self.commit_entered.take() {
            let _ = tx.send(());
        }
        if let Some(rx) = self.commit_release.take() {
            let _ = rx.await;
        }
        if let Some(tx) = self.commit_done.take() {
            let _ = tx.send(());
        }

        match self.commit_outcome {
            ControlledCommitOutcome::Success => Ok(sandbox::SnapshotOutput {
                snapshot_path: self.output_dir.join("snapshot.bin"),
                memory_path: self.output_dir.join("memory.bin"),
                cow_path: self.output_dir.join("cow.img"),
            }),
            ControlledCommitOutcome::Failure => {
                Err(sandbox::SnapshotError::Teardown("publish failed".into()))
            }
        }
    }

    async fn discard(&mut self) -> Result<(), sandbox::SnapshotError> {
        if let Some(tx) = self.discard_entered.take() {
            let _ = tx.send(());
        }
        if let Some(rx) = self.discard_release.take() {
            let _ = rx.await;
        }
        if let Some(tx) = self.discard_done.take() {
            let _ = tx.send(());
        }
        Ok(())
    }
}

async fn acquire_test_snapshot_lock(home: &HomePaths, snapshot_hash: &str) -> Flock<File> {
    lock::acquire(home.snapshot_lock(snapshot_hash))
        .await
        .expect("acquire test snapshot lock")
}

async fn snapshot_lock_state(lock_path: &Path) -> SnapshotLockState {
    match lock::try_acquire_or_busy(lock_path.to_path_buf()).await {
        Ok(lock::TryLock::Acquired(guard)) => {
            drop(guard);
            SnapshotLockState::Available
        }
        Ok(lock::TryLock::Busy) => SnapshotLockState::Held,
        Err(error) => SnapshotLockState::ProbeFailed(error.to_string()),
    }
}

async fn observe_phase_timeout(
    phase: &'static str,
    lock_path: &Path,
) -> SnapshotPublishPhaseTimeout {
    SnapshotPublishPhaseTimeout {
        phase,
        lock_state: snapshot_lock_state(lock_path).await,
    }
}

async fn wait_for_snapshot_publish_phase(
    deadline: tokio::time::Instant,
    phase: &'static str,
    receiver: tokio::sync::oneshot::Receiver<()>,
    lock_path: &Path,
) -> Result<(), SnapshotPublishPhaseTimeout> {
    match tokio::time::timeout_at(deadline, receiver).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => panic!("snapshot publish phase '{phase}' closed before signaling"),
        Err(_) => Err(observe_phase_timeout(phase, lock_path).await),
    }
}

async fn cancel_snapshot_publish_waiter(
    deadline: tokio::time::Instant,
    waiter: &mut Option<SnapshotPublishWaiter>,
    lock_path: &Path,
) -> Result<(), SnapshotPublishPhaseTimeout> {
    let result = {
        let waiter = waiter
            .as_mut()
            .expect("snapshot publish waiter should exist");
        waiter.abort();
        tokio::time::timeout_at(deadline, waiter).await
    };

    match result {
        Ok(Err(error)) if error.is_cancelled() => {
            waiter.take();
            Ok(())
        }
        Ok(Ok(Ok(_))) => panic!("snapshot publish waiter completed before cancellation"),
        Ok(Ok(Err(error))) => {
            panic!("snapshot publish waiter failed before cancellation: {error}")
        }
        Ok(Err(error)) => panic!("snapshot publish waiter ended unexpectedly: {error}"),
        Err(_) => Err(observe_phase_timeout("waiter cancellation", lock_path).await),
    }
}

async fn assert_lock_blocked(lock_path: &Path) {
    assert_eq!(
        snapshot_lock_state(lock_path).await,
        SnapshotLockState::Held,
        "snapshot lock should still be held"
    );
}

async fn wait_until_lock_available(
    deadline: tokio::time::Instant,
    phase: &'static str,
    lock_path: &Path,
) -> Result<(), SnapshotPublishPhaseTimeout> {
    let wait = async {
        loop {
            match snapshot_lock_state(lock_path).await {
                SnapshotLockState::Available => break,
                SnapshotLockState::Held => {
                    tokio::time::sleep(SNAPSHOT_LOCK_POLL_INTERVAL).await;
                }
                SnapshotLockState::ProbeFailed(error) => {
                    panic!("failed to probe snapshot lock while waiting for {phase}: {error}")
                }
            }
        }
    };

    match tokio::time::timeout_at(deadline, wait).await {
        Ok(()) => Ok(()),
        Err(_) => Err(observe_phase_timeout(phase, lock_path).await),
    }
}

async fn cleanup_snapshot_lock_state(
    cleanup_deadline: tokio::time::Instant,
    lock_path: &Path,
) -> SnapshotLockState {
    loop {
        let state = snapshot_lock_state(lock_path).await;
        match state {
            SnapshotLockState::Held if tokio::time::Instant::now() < cleanup_deadline => {
                let next_poll = (tokio::time::Instant::now() + SNAPSHOT_LOCK_POLL_INTERVAL)
                    .min(cleanup_deadline);
                tokio::time::sleep_until(next_poll).await;
            }
            state => return state,
        }
    }
}

async fn finish_snapshot_publish_scenario(
    result: Result<(), SnapshotPublishPhaseTimeout>,
    waiter: &mut Option<SnapshotPublishWaiter>,
    commit_release: &mut Option<tokio::sync::oneshot::Sender<()>>,
    discard_release: &mut Option<tokio::sync::oneshot::Sender<()>>,
    lock_path: &Path,
) -> Result<(), SnapshotPublishScenarioTimeout> {
    let Err(timeout) = result else {
        return Ok(());
    };

    let cleanup_deadline = tokio::time::Instant::now() + SNAPSHOT_PUBLISH_CLEANUP_TIMEOUT;
    let waiter = waiter.take();
    if let Some(waiter) = &waiter {
        waiter.abort();
    }
    drop(commit_release.take());
    drop(discard_release.take());

    if let Some(waiter) = waiter {
        let _ = tokio::time::timeout_at(cleanup_deadline, waiter).await;
    }
    let cleanup_lock_state = cleanup_snapshot_lock_state(cleanup_deadline, lock_path).await;

    Err(SnapshotPublishScenarioTimeout {
        phase: timeout.phase,
        lock_state: timeout.lock_state,
        cleanup_lock_state,
    })
}

#[tokio::test]
async fn build_snapshot_uses_explicit_pending_publish_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let rootfs_paths = RootfsPaths::new(&home, "rootfs-hash");
    tokio::fs::create_dir_all(rootfs_paths.dir()).await.unwrap();
    tokio::fs::write(rootfs_paths.rootfs(), b"rootfs")
        .await
        .unwrap();
    let snapshot_dir = dir.path().join("snapshot");
    let create_uncommitted_called = Arc::new(AtomicBool::new(false));
    let create_snapshot_called = Arc::new(AtomicBool::new(false));
    let committed = Arc::new(AtomicBool::new(false));
    let home_disk_mb = Arc::new(AtomicU32::new(0));
    let provider = RecordingSnapshotProvider {
        create_uncommitted_called: Arc::clone(&create_uncommitted_called),
        create_snapshot_called: Arc::clone(&create_snapshot_called),
        committed: Arc::clone(&committed),
        home_disk_mb: Arc::clone(&home_disk_mb),
    };
    let def = profile::ProfileDef {
        vcpu: 1,
        memory_mb: 128,
        rootfs_disk_mb: 8,
        home_disk_mb: 16,
    };

    build_snapshot(
        &home,
        &rootfs_paths,
        "snapshot-hash",
        &snapshot_dir,
        &def,
        &provider,
        acquire_test_snapshot_lock(&home, "snapshot-hash").await,
    )
    .await
    .unwrap();

    assert!(create_uncommitted_called.load(Ordering::SeqCst));
    assert!(committed.load(Ordering::SeqCst));
    assert_eq!(
        home_disk_mb.load(Ordering::SeqCst),
        16,
        "snapshot home disk size must use home_disk_mb, not rootfs_disk_mb"
    );
    assert!(
        !create_snapshot_called.load(Ordering::SeqCst),
        "build_snapshot should not use the compatibility create_snapshot path"
    );
    assert!(snapshot_dir.join("snapshot.bin").exists());
    assert!(snapshot_dir.join("memory.bin").exists());
    assert!(snapshot_dir.join("cow.img").exists());
}

#[tokio::test]
async fn build_snapshot_discards_pending_publish_after_commit_failure() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let rootfs_paths = RootfsPaths::new(&home, "rootfs-hash");
    tokio::fs::create_dir_all(rootfs_paths.dir()).await.unwrap();
    tokio::fs::write(rootfs_paths.rootfs(), b"rootfs")
        .await
        .unwrap();
    let snapshot_dir = dir.path().join("snapshot");
    let discarded = Arc::new(AtomicBool::new(false));
    let provider = FailingSnapshotProvider {
        discarded: Arc::clone(&discarded),
        discard_error: None,
    };
    let def = profile::ProfileDef {
        vcpu: 1,
        memory_mb: 128,
        rootfs_disk_mb: 8,
        home_disk_mb: 16,
    };

    let err = build_snapshot(
        &home,
        &rootfs_paths,
        "snapshot-hash",
        &snapshot_dir,
        &def,
        &provider,
        acquire_test_snapshot_lock(&home, "snapshot-hash").await,
    )
    .await
    .expect_err("snapshot publish should fail");

    assert!(
        matches!(err, RunnerError::Snapshot(sandbox::SnapshotError::Teardown(ref message)) if message == "publish failed"),
        "got: {err:?}"
    );
    assert!(
        discarded.load(Ordering::SeqCst),
        "build_snapshot should explicitly discard after commit failure"
    );
}

#[tokio::test]
async fn build_snapshot_preserves_commit_error_when_discard_fails() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let rootfs_paths = RootfsPaths::new(&home, "rootfs-hash");
    tokio::fs::create_dir_all(rootfs_paths.dir()).await.unwrap();
    tokio::fs::write(rootfs_paths.rootfs(), b"rootfs")
        .await
        .unwrap();
    let snapshot_dir = dir.path().join("snapshot");
    let discarded = Arc::new(AtomicBool::new(false));
    let provider = FailingSnapshotProvider {
        discarded: Arc::clone(&discarded),
        discard_error: Some("discard failed"),
    };
    let def = profile::ProfileDef {
        vcpu: 1,
        memory_mb: 128,
        rootfs_disk_mb: 8,
        home_disk_mb: 16,
    };

    let err = build_snapshot(
        &home,
        &rootfs_paths,
        "snapshot-hash",
        &snapshot_dir,
        &def,
        &provider,
        acquire_test_snapshot_lock(&home, "snapshot-hash").await,
    )
    .await
    .expect_err("snapshot publish should fail");

    assert!(
        matches!(err, RunnerError::Snapshot(sandbox::SnapshotError::Teardown(ref message)) if message == "publish failed"),
        "discard failure must not mask the publish failure, got: {err:?}"
    );
    assert!(
        discarded.load(Ordering::SeqCst),
        "build_snapshot should still try discard after commit failure"
    );
}

async fn run_commit_cancellation_scenario(
    gate_behavior: CommitGateBehavior,
) -> Result<(), SnapshotPublishScenarioTimeout> {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let snapshot_hash = "snapshot-hash";
    let snapshot_lock_path = home.snapshot_lock(snapshot_hash);
    let snapshot_lock = lock::acquire(snapshot_lock_path.clone())
        .await
        .expect("acquire snapshot lock");
    let snapshot_dir = dir.path().join("snapshot");
    let (commit_entered_tx, commit_entered_rx) = tokio::sync::oneshot::channel();
    let (commit_release_tx, commit_release_rx) = tokio::sync::oneshot::channel();
    let (commit_done_tx, commit_done_rx) = tokio::sync::oneshot::channel();
    let pending = ControlledPendingSnapshotPublish {
        output_dir: snapshot_dir.clone(),
        commit_outcome: ControlledCommitOutcome::Success,
        commit_entered: Some(commit_entered_tx),
        commit_release: Some(commit_release_rx),
        commit_done: Some(commit_done_tx),
        discard_entered: None,
        discard_release: None,
        discard_done: None,
    };

    let deadline = tokio::time::Instant::now() + SNAPSHOT_PUBLISH_SCENARIO_TIMEOUT;
    let mut waiter = Some(tokio::spawn(shielded_snapshot_publish(
        Box::new(pending),
        snapshot_lock,
        snapshot_hash.to_string(),
        snapshot_dir,
    )));
    let mut commit_release_tx = Some(commit_release_tx);
    let mut discard_release_tx = None;

    let result = async {
        wait_for_snapshot_publish_phase(
            deadline,
            "commit entry",
            commit_entered_rx,
            &snapshot_lock_path,
        )
        .await?;
        cancel_snapshot_publish_waiter(deadline, &mut waiter, &snapshot_lock_path).await?;

        assert_lock_blocked(&snapshot_lock_path).await;

        if gate_behavior == CommitGateBehavior::Release {
            commit_release_tx
                .take()
                .expect("commit release gate should exist")
                .send(())
                .expect("release commit waiter after cancellation");
        }
        wait_for_snapshot_publish_phase(
            deadline,
            "commit completion",
            commit_done_rx,
            &snapshot_lock_path,
        )
        .await?;
        wait_until_lock_available(
            deadline,
            "snapshot lock release after commit",
            &snapshot_lock_path,
        )
        .await
    }
    .await;

    finish_snapshot_publish_scenario(
        result,
        &mut waiter,
        &mut commit_release_tx,
        &mut discard_release_tx,
        &snapshot_lock_path,
    )
    .await
}

async fn run_discard_cancellation_scenario() -> Result<(), SnapshotPublishScenarioTimeout> {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let snapshot_hash = "snapshot-hash";
    let snapshot_lock_path = home.snapshot_lock(snapshot_hash);
    let snapshot_lock = lock::acquire(snapshot_lock_path.clone())
        .await
        .expect("acquire snapshot lock");
    let snapshot_dir = dir.path().join("snapshot");
    let (commit_entered_tx, commit_entered_rx) = tokio::sync::oneshot::channel();
    let (commit_release_tx, commit_release_rx) = tokio::sync::oneshot::channel();
    let (discard_entered_tx, discard_entered_rx) = tokio::sync::oneshot::channel();
    let (discard_release_tx, discard_release_rx) = tokio::sync::oneshot::channel();
    let (discard_done_tx, discard_done_rx) = tokio::sync::oneshot::channel();
    let pending = ControlledPendingSnapshotPublish {
        output_dir: snapshot_dir.clone(),
        commit_outcome: ControlledCommitOutcome::Failure,
        commit_entered: Some(commit_entered_tx),
        commit_release: Some(commit_release_rx),
        commit_done: None,
        discard_entered: Some(discard_entered_tx),
        discard_release: Some(discard_release_rx),
        discard_done: Some(discard_done_tx),
    };

    let deadline = tokio::time::Instant::now() + SNAPSHOT_PUBLISH_SCENARIO_TIMEOUT;
    let mut waiter = Some(tokio::spawn(shielded_snapshot_publish(
        Box::new(pending),
        snapshot_lock,
        snapshot_hash.to_string(),
        snapshot_dir,
    )));
    let mut commit_release_tx = Some(commit_release_tx);
    let mut discard_release_tx = Some(discard_release_tx);

    let result = async {
        wait_for_snapshot_publish_phase(
            deadline,
            "commit entry",
            commit_entered_rx,
            &snapshot_lock_path,
        )
        .await?;
        cancel_snapshot_publish_waiter(deadline, &mut waiter, &snapshot_lock_path).await?;

        assert_lock_blocked(&snapshot_lock_path).await;

        commit_release_tx
            .take()
            .expect("commit release gate should exist")
            .send(())
            .expect("release failing commit after cancellation");
        wait_for_snapshot_publish_phase(
            deadline,
            "discard entry",
            discard_entered_rx,
            &snapshot_lock_path,
        )
        .await?;
        assert_lock_blocked(&snapshot_lock_path).await;

        discard_release_tx
            .take()
            .expect("discard release gate should exist")
            .send(())
            .expect("release discard after cancellation");
        wait_for_snapshot_publish_phase(
            deadline,
            "discard completion",
            discard_done_rx,
            &snapshot_lock_path,
        )
        .await?;
        wait_until_lock_available(
            deadline,
            "snapshot lock release after discard",
            &snapshot_lock_path,
        )
        .await
    }
    .await;

    finish_snapshot_publish_scenario(
        result,
        &mut waiter,
        &mut commit_release_tx,
        &mut discard_release_tx,
        &snapshot_lock_path,
    )
    .await
}

#[tokio::test]
async fn shielded_snapshot_publish_keeps_lock_after_waiter_cancelled_until_commit_finishes() {
    run_commit_cancellation_scenario(CommitGateBehavior::Release)
        .await
        .unwrap_or_else(|error| panic!("{error}"));
}

#[tokio::test]
async fn shielded_snapshot_publish_keeps_lock_after_waiter_cancelled_until_discard_finishes() {
    run_discard_cancellation_scenario()
        .await
        .unwrap_or_else(|error| panic!("{error}"));
}

#[tokio::test(start_paused = true)]
async fn shielded_snapshot_publish_phase_timeout_reports_lock_and_releases_gate() {
    let started_at = tokio::time::Instant::now();
    let error = run_commit_cancellation_scenario(CommitGateBehavior::WithholdForTimeout)
        .await
        .expect_err("withheld commit should reach the scenario timeout");
    let elapsed = tokio::time::Instant::now().duration_since(started_at);

    assert_eq!(error.phase, "commit completion");
    assert_eq!(error.lock_state, SnapshotLockState::Held);
    assert_eq!(error.cleanup_lock_state, SnapshotLockState::Available);
    assert!(
        elapsed >= SNAPSHOT_PUBLISH_SCENARIO_TIMEOUT,
        "phase timeout returned before the scenario deadline: {elapsed:?}"
    );
    assert!(
        elapsed <= SNAPSHOT_PUBLISH_SCENARIO_TIMEOUT + SNAPSHOT_PUBLISH_CLEANUP_TIMEOUT,
        "phase timeout cleanup exceeded its local budget: {elapsed:?}"
    );
}
