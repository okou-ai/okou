use super::*;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

use crate::factory::cleanup_group::FactoryCleanupGroup;

struct SandboxCreateResourcesWithoutCow {
    sandbox_paths: SandboxPaths,
    sock_paths: SockPaths,
    network: NetnsLease,
}

impl SandboxCreateTransaction {
    fn new(id: String) -> Self {
        Self::new_with_leak_tx(id, None)
    }

    fn track_workspace_for_test(&mut self, workspace: PathBuf) -> sandbox::Result<()> {
        if !matches!(self.workspace, WorkspaceOwnership::None) {
            return Err(create_transaction_invalid_state(&format!(
                "cannot track workspace while workspace state is {}",
                self.workspace.state_name()
            )));
        }
        self.workspace = WorkspaceOwnership::Workspace(workspace);
        Ok(())
    }

    fn track_test_cow_device_for_test(&mut self) {
        assert!(self.cow_device.is_none(), "test COW device already tracked");
        self.cow_device = Some(CreateTransactionCowDevice::Test);
    }

    fn commit_without_cow_for_test(&mut self) -> sandbox::Result<SandboxCreateResourcesWithoutCow> {
        self.validate_base_resources("test commit")?;
        let (workspace, sock_dir, network) = self.take_base_resources_after_validation()?;

        Ok(SandboxCreateResourcesWithoutCow {
            sandbox_paths: SandboxPaths::new(workspace),
            sock_paths: SockPaths::new(sock_dir),
            network,
        })
    }
}

fn test_network() -> NetnsLease {
    NetnsLease::new_for_test("test-ns")
}

struct WorkspaceSockFixture {
    _tmp: tempfile::TempDir,
    workspace: PathBuf,
    sock_dir: PathBuf,
}

impl WorkspaceSockFixture {
    async fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        let sock_dir = tmp.path().join("sock");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::create_dir_all(sock_dir.join("vsock"))
            .await
            .unwrap();

        Self {
            _tmp: tmp,
            workspace,
            sock_dir,
        }
    }

    fn track_on(&self, tx: &mut SandboxCreateTransaction) {
        tx.track_workspace_for_test(self.workspace.clone()).unwrap();
        tx.track_sock_dir(self.sock_dir.clone());
    }
}

struct RollbackTaskDropSignal(Option<tokio::sync::oneshot::Sender<()>>);

impl Drop for RollbackTaskDropSignal {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(());
        }
    }
}

#[derive(Clone, Default)]
struct CleanupEvents {
    events: Arc<Mutex<Vec<String>>>,
}

impl CleanupEvents {
    fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }

    fn record(&self, event: String) {
        self.events.lock().unwrap().push(event);
    }
}

#[derive(Default)]
struct RecordingCreateRollbackCleanup {
    events: CleanupEvents,
}

impl RecordingCreateRollbackCleanup {
    fn events(&self) -> Vec<String> {
        self.events.events()
    }

    fn record(&self, event: String) {
        self.events.record(event);
    }
}

#[derive(Default)]
struct FailingNetworkReleaseCleanup {
    events: CleanupEvents,
}

impl FailingNetworkReleaseCleanup {
    fn events(&self) -> Vec<String> {
        self.events.events()
    }

    fn record(&self, event: String) {
        self.events.record(event);
    }
}

struct CowOutcomeCreateRollbackCleanup {
    events: CleanupEvents,
    cow_outcome: CowCleanupOutcome,
    release_network: bool,
}

impl CowOutcomeCreateRollbackCleanup {
    fn releasing_network(cow_outcome: CowCleanupOutcome) -> Self {
        Self {
            events: CleanupEvents::default(),
            cow_outcome,
            release_network: true,
        }
    }

    fn failing_network(cow_outcome: CowCleanupOutcome) -> Self {
        Self {
            events: CleanupEvents::default(),
            cow_outcome,
            release_network: false,
        }
    }

    fn events(&self) -> Vec<String> {
        self.events.events()
    }

    fn record(&self, event: String) {
        self.events.record(event);
    }
}

#[derive(Clone, Default)]
struct BlockingRemoveDirCleanup {
    events: CleanupEvents,
    entered: Arc<AtomicUsize>,
    entered_notify: Arc<tokio::sync::Notify>,
    removed: Arc<AtomicUsize>,
    removed_notify: Arc<tokio::sync::Notify>,
    release: Arc<AtomicBool>,
    release_notify: Arc<tokio::sync::Notify>,
    task_aborts: Arc<Mutex<Vec<tokio::task::AbortHandle>>>,
}

struct BlockingRemoveDirCleanupScope {
    cleanup: BlockingRemoveDirCleanup,
}

impl Drop for BlockingRemoveDirCleanupScope {
    fn drop(&mut self) {
        self.cleanup.release();
        self.cleanup.abort_tasks();
    }
}

impl BlockingRemoveDirCleanup {
    fn events(&self) -> Vec<String> {
        self.events.events()
    }

    fn record(&self, event: String) {
        self.events.record(event);
    }

    fn record_filesystem_cleanup_step(&self, step: &CreateRollbackFilesystemCleanupStep) {
        match step {
            CreateRollbackFilesystemCleanupStep::RemoveDir { kind, path } => {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("<unknown>");
                self.record(format!("remove_dir:{kind}:{name}"));
            }
        }
    }

    fn run_filesystem_cleanup_step(&self, step: CreateRollbackFilesystemCleanupStep) {
        match step {
            CreateRollbackFilesystemCleanupStep::RemoveDir { path, .. } => {
                let _ = std::fs::remove_dir_all(path);
            }
        }
        self.removed.fetch_add(1, Ordering::SeqCst);
        self.removed_notify.notify_waiters();
    }

    async fn wait_entered(&self, expected: usize) {
        loop {
            let notified = self.entered_notify.notified();
            if self.entered.load(Ordering::SeqCst) >= expected {
                return;
            }
            notified.await;
        }
    }

    async fn wait_removed(&self, expected: usize, fixture: &WorkspaceSockFixture) {
        let wait = async {
            loop {
                let notified = self.removed_notify.notified();
                if self.removed.load(Ordering::SeqCst) >= expected {
                    return;
                }
                notified.await;
            }
        };

        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), wait)
                .await
                .is_ok(),
            "timed out waiting for create rollback filesystem cleanup: expected_removals={expected}, observed_removals={}, events={:?}, workspace_exists={}, sock_dir_exists={}",
            self.removed.load(Ordering::SeqCst),
            self.events(),
            fixture.workspace.exists(),
            fixture.sock_dir.exists(),
        );
    }

    fn release(&self) {
        self.release.store(true, Ordering::SeqCst);
        self.release_notify.notify_waiters();
    }

    fn scope(&self) -> BlockingRemoveDirCleanupScope {
        BlockingRemoveDirCleanupScope {
            cleanup: self.clone(),
        }
    }

    fn lock_task_aborts(&self) -> std::sync::MutexGuard<'_, Vec<tokio::task::AbortHandle>> {
        match self.task_aborts.lock() {
            Ok(task_aborts) => task_aborts,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn track_task<T>(&self, task: &tokio::task::JoinHandle<T>) {
        self.lock_task_aborts().push(task.abort_handle());
    }

    fn abort_tasks(&self) {
        let task_aborts = std::mem::take(&mut *self.lock_task_aborts());
        for task_abort in task_aborts {
            task_abort.abort();
        }
    }

    async fn wait_until_released(&self) {
        loop {
            let notified = self.release_notify.notified();
            if self.release.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Clone, Default)]
struct BlockingCowCleanup {
    events: CleanupEvents,
    entered: Arc<AtomicBool>,
    entered_notify: Arc<tokio::sync::Notify>,
}

impl BlockingCowCleanup {
    fn events(&self) -> Vec<String> {
        self.events.events()
    }

    fn record(&self, event: String) {
        self.events.record(event);
    }

    async fn wait_entered(&self) {
        loop {
            let notified = self.entered_notify.notified();
            if self.entered.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Clone)]
struct BlockingNetworkAfterCowCleanup {
    events: CleanupEvents,
    cow_outcome: CowCleanupOutcome,
    entered: Arc<AtomicBool>,
    entered_notify: Arc<tokio::sync::Notify>,
}

impl BlockingNetworkAfterCowCleanup {
    fn new(cow_outcome: CowCleanupOutcome) -> Self {
        Self {
            events: CleanupEvents::default(),
            cow_outcome,
            entered: Arc::new(AtomicBool::new(false)),
            entered_notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    fn events(&self) -> Vec<String> {
        self.events.events()
    }

    fn record(&self, event: String) {
        self.events.record(event);
    }

    async fn wait_entered(&self) {
        loop {
            let notified = self.entered_notify.notified();
            if self.entered.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}

fn assert_test_cow_device(cow_device: CreateTransactionCowDevice) {
    match cow_device {
        CreateTransactionCowDevice::Test => {}
        CreateTransactionCowDevice::Real(_) => {
            panic!("test cleanup should not receive a real COW device")
        }
    }
}

#[async_trait]
impl CreateRollbackCleanup for BlockingRemoveDirCleanup {
    async fn destroy_cow_device(
        &self,
        _cow_device: CreateTransactionCowDevice,
    ) -> CowCleanupOutcome {
        panic!("test cleanup should not receive a real COW device");
    }

    async fn release_network(&self, network: &mut Option<NetnsLease>) {
        let network = network.take().expect("test network lease");
        self.record(format!("release_network:{}", network.name()));
        let _ = network.into_info_for_test();
    }

    fn start_filesystem_cleanup(
        &self,
        cleanup: CreateRollbackFilesystemCleanup,
    ) -> CreateRollbackFilesystemCleanupWaiter {
        let runner = self.clone();
        let task = tokio::spawn(async move {
            let step_count = cleanup.steps.len();
            for step in &cleanup.steps {
                runner.record_filesystem_cleanup_step(step);
            }
            runner.entered.fetch_add(step_count, Ordering::SeqCst);
            runner.entered_notify.notify_waiters();

            runner.wait_until_released().await;

            for step in cleanup.steps {
                runner.run_filesystem_cleanup_step(step);
            }
        });
        self.track_task(&task);
        CreateRollbackFilesystemCleanupWaiter::new(async move {
            let _ = task.await;
        })
    }
}

#[async_trait]
impl CreateRollbackCleanup for FailingNetworkReleaseCleanup {
    async fn destroy_cow_device(
        &self,
        _cow_device: CreateTransactionCowDevice,
    ) -> CowCleanupOutcome {
        panic!("test cleanup should not receive a real COW device");
    }

    async fn release_network(&self, network: &mut Option<NetnsLease>) {
        self.record(format!(
            "release_network:{}",
            network.as_ref().expect("test network lease").name()
        ));
    }

    fn start_filesystem_cleanup(
        &self,
        _cleanup: CreateRollbackFilesystemCleanup,
    ) -> CreateRollbackFilesystemCleanupWaiter {
        panic!("network release failure should keep filesystem cleanup in transaction");
    }
}

#[async_trait]
impl CreateRollbackCleanup for RecordingCreateRollbackCleanup {
    async fn destroy_cow_device(
        &self,
        _cow_device: CreateTransactionCowDevice,
    ) -> CowCleanupOutcome {
        panic!("test cleanup should not receive a real COW device");
    }

    async fn release_network(&self, network: &mut Option<NetnsLease>) {
        let network = network.take().expect("test network lease");
        self.record(format!("release_network:{}", network.name()));
        let _ = network.into_info_for_test();
    }

    fn start_filesystem_cleanup(
        &self,
        cleanup: CreateRollbackFilesystemCleanup,
    ) -> CreateRollbackFilesystemCleanupWaiter {
        for step in cleanup.steps {
            match step {
                CreateRollbackFilesystemCleanupStep::RemoveDir { kind, path } => {
                    let name = path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("<unknown>");
                    self.record(format!("remove_dir:{kind}:{name}"));
                    remove_create_rollback_dir_sync("sandbox", kind, path);
                }
            }
        }
        CreateRollbackFilesystemCleanupWaiter::ready()
    }
}

#[async_trait]
impl CreateRollbackCleanup for CowOutcomeCreateRollbackCleanup {
    async fn destroy_cow_device(
        &self,
        cow_device: CreateTransactionCowDevice,
    ) -> CowCleanupOutcome {
        assert_test_cow_device(cow_device);
        self.record("destroy_cow_device".into());
        self.cow_outcome
    }

    async fn release_network(&self, network: &mut Option<NetnsLease>) {
        let network_name = network
            .as_ref()
            .expect("test network lease")
            .name()
            .to_owned();
        self.record(format!("release_network:{network_name}"));
        if self.release_network {
            let network = network.take().expect("test network lease");
            let _ = network.into_info_for_test();
        }
    }

    fn start_filesystem_cleanup(
        &self,
        cleanup: CreateRollbackFilesystemCleanup,
    ) -> CreateRollbackFilesystemCleanupWaiter {
        for step in cleanup.steps {
            match step {
                CreateRollbackFilesystemCleanupStep::RemoveDir { kind, path } => {
                    let name = path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("<unknown>");
                    self.record(format!("remove_dir:{kind}:{name}"));
                    remove_create_rollback_dir_sync("sandbox", kind, path);
                }
            }
        }
        CreateRollbackFilesystemCleanupWaiter::ready()
    }
}

#[async_trait]
impl CreateRollbackCleanup for BlockingCowCleanup {
    async fn destroy_cow_device(
        &self,
        cow_device: CreateTransactionCowDevice,
    ) -> CowCleanupOutcome {
        assert_test_cow_device(cow_device);
        self.record("destroy_cow_device".into());
        self.entered.store(true, Ordering::SeqCst);
        self.entered_notify.notify_waiters();
        std::future::pending::<CowCleanupOutcome>().await
    }

    async fn release_network(&self, _network: &mut Option<NetnsLease>) {
        panic!("blocked COW cleanup should prevent network release");
    }

    fn start_filesystem_cleanup(
        &self,
        _cleanup: CreateRollbackFilesystemCleanup,
    ) -> CreateRollbackFilesystemCleanupWaiter {
        panic!("blocked COW cleanup should prevent filesystem cleanup");
    }
}

#[async_trait]
impl CreateRollbackCleanup for BlockingNetworkAfterCowCleanup {
    async fn destroy_cow_device(
        &self,
        cow_device: CreateTransactionCowDevice,
    ) -> CowCleanupOutcome {
        assert_test_cow_device(cow_device);
        self.record("destroy_cow_device".into());
        self.cow_outcome
    }

    async fn release_network(&self, network: &mut Option<NetnsLease>) {
        let network_name = network
            .as_ref()
            .expect("test network lease")
            .name()
            .to_owned();
        self.record(format!("release_network:{network_name}"));
        self.entered.store(true, Ordering::SeqCst);
        self.entered_notify.notify_waiters();
        std::future::pending::<()>().await;
    }

    fn start_filesystem_cleanup(
        &self,
        _cleanup: CreateRollbackFilesystemCleanup,
    ) -> CreateRollbackFilesystemCleanupWaiter {
        panic!("blocked network release should prevent filesystem cleanup");
    }
}

fn test_leaked_resource(sandbox_id: &str) -> LeakedResources {
    LeakedResources {
        sandbox_id: sandbox_id.into(),
        process_exit: None,
        cow_device: None,
        network: None,
        sock_dir: PathBuf::from("/nonexistent"),
        workspace: PathBuf::from("/nonexistent"),
        delete_workspace: true,
    }
}

#[tokio::test]
async fn create_transaction_rollback_after_sock_dir_removes_sock_then_workspace() {
    let fixture = WorkspaceSockFixture::new().await;

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    fixture.track_on(&mut tx);
    let cleanup = RecordingCreateRollbackCleanup::default();

    tx.rollback(&cleanup).await;

    assert!(!fixture.workspace.exists());
    assert!(!fixture.sock_dir.exists());
    assert_eq!(
        cleanup.events(),
        vec!["remove_dir:sock:sock", "remove_dir:workspace:workspace"]
    );
}

#[tokio::test]
async fn create_transaction_rollback_preserves_previously_unsafe_workspace() {
    let fixture = WorkspaceSockFixture::new().await;

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    fixture.track_on(&mut tx);
    tx.preserve_workspace_on_leak_cleanup();
    let cleanup = RecordingCreateRollbackCleanup::default();

    tx.rollback(&cleanup).await;

    assert!(fixture.workspace.exists());
    assert!(!fixture.sock_dir.exists());
    assert_eq!(cleanup.events(), vec!["remove_dir:sock:sock"]);
}

#[tokio::test]
async fn create_transaction_rollback_missing_dirs_are_best_effort() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = tmp.path().join("missing-workspace");
    let sock_dir = tmp.path().join("missing-sock");

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    tx.track_workspace_for_test(workspace.clone()).unwrap();
    tx.track_sock_dir(sock_dir.clone());
    let cleanup = RecordingCreateRollbackCleanup::default();

    tx.rollback(&cleanup).await;

    assert!(!workspace.exists());
    assert!(!sock_dir.exists());
    assert_eq!(
        cleanup.events(),
        vec![
            "remove_dir:sock:missing-sock",
            "remove_dir:workspace:missing-workspace"
        ]
    );
}

#[tokio::test]
async fn create_transaction_rollback_remove_dir_error_is_best_effort() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = tmp.path().join("workspace");
    let sock_file = tmp.path().join("sock-file");
    tokio::fs::create_dir_all(&workspace).await.unwrap();
    tokio::fs::write(&sock_file, b"not a dir").await.unwrap();

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    tx.track_workspace_for_test(workspace.clone()).unwrap();
    tx.track_sock_dir(sock_file.clone());
    let cleanup = RecordingCreateRollbackCleanup::default();

    tx.rollback(&cleanup).await;

    assert!(sock_file.exists());
    assert!(!workspace.exists());
    assert_eq!(
        cleanup.events(),
        vec![
            "remove_dir:sock:sock-file",
            "remove_dir:workspace:workspace"
        ]
    );
}

#[tokio::test]
async fn create_transaction_rollback_releases_network_before_dirs() {
    let fixture = WorkspaceSockFixture::new().await;

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    fixture.track_on(&mut tx);
    tx.track_network(test_network());
    let cleanup = RecordingCreateRollbackCleanup::default();

    tx.rollback(&cleanup).await;

    assert!(!fixture.workspace.exists());
    assert!(!fixture.sock_dir.exists());
    assert_eq!(
        cleanup.events(),
        vec![
            "release_network:test-ns",
            "remove_dir:sock:sock",
            "remove_dir:workspace:workspace"
        ]
    );
}

#[tokio::test]
async fn create_transaction_rollback_safe_cow_cleanup_removes_workspace() {
    let fixture = WorkspaceSockFixture::new().await;

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    fixture.track_on(&mut tx);
    tx.track_network(test_network());
    tx.track_test_cow_device_for_test();
    let cleanup = CowOutcomeCreateRollbackCleanup::releasing_network(
        CowCleanupOutcome::BackingFilesSafeToDelete,
    );

    tx.rollback(&cleanup).await;

    assert!(!fixture.workspace.exists());
    assert!(!fixture.sock_dir.exists());
    assert_eq!(
        cleanup.events(),
        vec![
            "destroy_cow_device",
            "release_network:test-ns",
            "remove_dir:sock:sock",
            "remove_dir:workspace:workspace"
        ]
    );
}

#[tokio::test]
async fn create_transaction_rollback_unsafe_cow_cleanup_preserves_workspace() {
    let fixture = WorkspaceSockFixture::new().await;

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    fixture.track_on(&mut tx);
    tx.track_network(test_network());
    tx.track_test_cow_device_for_test();
    let cleanup = CowOutcomeCreateRollbackCleanup::releasing_network(
        CowCleanupOutcome::DeviceMayStillReferenceBackingFiles,
    );

    tx.rollback(&cleanup).await;

    assert!(fixture.workspace.exists());
    assert!(!fixture.sock_dir.exists());
    assert_eq!(
        cleanup.events(),
        vec![
            "destroy_cow_device",
            "release_network:test-ns",
            "remove_dir:sock:sock"
        ]
    );
}

#[tokio::test]
async fn create_transaction_rollback_unsafe_cow_cleanup_marks_leaked_workspace_preserved() {
    let fixture = WorkspaceSockFixture::new().await;

    let (leak_tx, mut leak_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut tx = SandboxCreateTransaction::new_with_leak_tx("sandbox".into(), Some(leak_tx));
    fixture.track_on(&mut tx);
    tx.track_network(test_network());
    tx.track_test_cow_device_for_test();
    let cleanup = CowOutcomeCreateRollbackCleanup::failing_network(
        CowCleanupOutcome::DeviceMayStillReferenceBackingFiles,
    );

    tx.rollback(&cleanup).await;

    assert!(fixture.workspace.exists());
    assert!(fixture.sock_dir.exists());
    assert_eq!(
        cleanup.events(),
        vec!["destroy_cow_device", "release_network:test-ns"]
    );

    drop(tx);
    let mut leaked = leak_rx.recv().await.unwrap();
    assert!(leaked.cow_device.is_none());
    assert!(!leaked.delete_workspace);
    let network = leaked.network.take().unwrap();
    assert_eq!(network.name(), "test-ns");
    let _ = network.into_info_for_test();
    assert_eq!(leaked.sock_dir, fixture.sock_dir);
    assert_eq!(leaked.workspace, fixture.workspace);
}

#[tokio::test]
async fn create_transaction_rollback_safe_cow_cleanup_marks_leaked_workspace_deletable() {
    let fixture = WorkspaceSockFixture::new().await;

    let (leak_tx, mut leak_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut tx = SandboxCreateTransaction::new_with_leak_tx("sandbox".into(), Some(leak_tx));
    fixture.track_on(&mut tx);
    tx.track_network(test_network());
    tx.track_test_cow_device_for_test();
    let cleanup = CowOutcomeCreateRollbackCleanup::failing_network(
        CowCleanupOutcome::BackingFilesSafeToDelete,
    );

    tx.rollback(&cleanup).await;

    assert!(fixture.workspace.exists());
    assert!(fixture.sock_dir.exists());
    assert_eq!(
        cleanup.events(),
        vec!["destroy_cow_device", "release_network:test-ns"]
    );

    drop(tx);
    let mut leaked = leak_rx.recv().await.unwrap();
    assert!(leaked.cow_device.is_none());
    assert!(leaked.delete_workspace);
    let network = leaked.network.take().unwrap();
    assert_eq!(network.name(), "test-ns");
    let _ = network.into_info_for_test();
    assert_eq!(leaked.sock_dir, fixture.sock_dir);
    assert_eq!(leaked.workspace, fixture.workspace);
}

#[tokio::test]
async fn create_transaction_rollback_cancellation_during_cow_cleanup_preserves_workspace() {
    let fixture = WorkspaceSockFixture::new().await;

    let (leak_tx, mut leak_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut tx = SandboxCreateTransaction::new_with_leak_tx("sandbox".into(), Some(leak_tx));
    fixture.track_on(&mut tx);
    tx.track_network(test_network());
    tx.track_test_cow_device_for_test();

    let cleanup = BlockingCowCleanup::default();
    let rollback_cleanup = cleanup.clone();
    let rollback = tokio::spawn(async move {
        let mut tx = tx;
        tx.rollback(&rollback_cleanup).await;
    });

    tokio::time::timeout(std::time::Duration::from_secs(1), cleanup.wait_entered())
        .await
        .unwrap();
    assert!(fixture.workspace.exists());
    assert!(fixture.sock_dir.exists());

    rollback.abort();
    assert!(rollback.await.unwrap_err().is_cancelled());

    let mut leaked = tokio::time::timeout(std::time::Duration::from_secs(1), leak_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(leaked.cow_device.is_none());
    assert!(!leaked.delete_workspace);
    let network = leaked.network.take().unwrap();
    assert_eq!(network.name(), "test-ns");
    let _ = network.into_info_for_test();
    assert_eq!(leaked.sock_dir, fixture.sock_dir);
    assert_eq!(leaked.workspace, fixture.workspace);
    assert_eq!(cleanup.events(), vec!["destroy_cow_device"]);
}

#[tokio::test]
async fn create_rollback_cancel_after_safe_cow_marks_leak_workspace_deletable() {
    let fixture = WorkspaceSockFixture::new().await;

    let (leak_tx, mut leak_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut tx = SandboxCreateTransaction::new_with_leak_tx("sandbox".into(), Some(leak_tx));
    fixture.track_on(&mut tx);
    tx.track_network(test_network());
    tx.track_test_cow_device_for_test();

    let cleanup = BlockingNetworkAfterCowCleanup::new(CowCleanupOutcome::BackingFilesSafeToDelete);
    let rollback_cleanup = cleanup.clone();
    let rollback = tokio::spawn(async move {
        let mut tx = tx;
        tx.rollback(&rollback_cleanup).await;
    });

    tokio::time::timeout(std::time::Duration::from_secs(1), cleanup.wait_entered())
        .await
        .unwrap();

    rollback.abort();
    assert!(rollback.await.unwrap_err().is_cancelled());

    let mut leaked = tokio::time::timeout(std::time::Duration::from_secs(1), leak_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(leaked.cow_device.is_none());
    assert!(leaked.delete_workspace);
    let network = leaked.network.take().unwrap();
    assert_eq!(network.name(), "test-ns");
    let _ = network.into_info_for_test();
    assert_eq!(leaked.sock_dir, fixture.sock_dir);
    assert_eq!(leaked.workspace, fixture.workspace);
    assert_eq!(
        cleanup.events(),
        vec!["destroy_cow_device", "release_network:test-ns"]
    );
}

#[tokio::test]
async fn create_rollback_cancel_after_unsafe_cow_marks_leak_workspace_preserved() {
    let fixture = WorkspaceSockFixture::new().await;

    let (leak_tx, mut leak_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut tx = SandboxCreateTransaction::new_with_leak_tx("sandbox".into(), Some(leak_tx));
    fixture.track_on(&mut tx);
    tx.track_network(test_network());
    tx.track_test_cow_device_for_test();

    let cleanup =
        BlockingNetworkAfterCowCleanup::new(CowCleanupOutcome::DeviceMayStillReferenceBackingFiles);
    let rollback_cleanup = cleanup.clone();
    let rollback = tokio::spawn(async move {
        let mut tx = tx;
        tx.rollback(&rollback_cleanup).await;
    });

    tokio::time::timeout(std::time::Duration::from_secs(1), cleanup.wait_entered())
        .await
        .unwrap();

    rollback.abort();
    assert!(rollback.await.unwrap_err().is_cancelled());

    let mut leaked = tokio::time::timeout(std::time::Duration::from_secs(1), leak_rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(leaked.cow_device.is_none());
    assert!(!leaked.delete_workspace);
    let network = leaked.network.take().unwrap();
    assert_eq!(network.name(), "test-ns");
    let _ = network.into_info_for_test();
    assert_eq!(leaked.sock_dir, fixture.sock_dir);
    assert_eq!(leaked.workspace, fixture.workspace);
    assert_eq!(
        cleanup.events(),
        vec!["destroy_cow_device", "release_network:test-ns"]
    );
}

#[tokio::test]
async fn create_transaction_rollback_keeps_dirs_when_network_release_fails() {
    let fixture = WorkspaceSockFixture::new().await;

    let (leak_tx, mut leak_rx) = tokio::sync::mpsc::unbounded_channel();
    let mut tx = SandboxCreateTransaction::new_with_leak_tx("sandbox".into(), Some(leak_tx));
    fixture.track_on(&mut tx);
    tx.track_network(test_network());
    let cleanup = FailingNetworkReleaseCleanup::default();

    tx.rollback(&cleanup).await;

    assert!(fixture.workspace.exists());
    assert!(fixture.sock_dir.exists());
    assert_eq!(cleanup.events(), vec!["release_network:test-ns"]);

    drop(tx);
    let mut leaked = leak_rx.recv().await.unwrap();
    let network = leaked.network.take().unwrap();
    assert_eq!(network.name(), "test-ns");
    let _ = network.into_info_for_test();
    assert_eq!(leaked.sock_dir, fixture.sock_dir);
    assert_eq!(leaked.workspace, fixture.workspace);
}

#[tokio::test]
async fn create_transaction_commit_disarms_rollback() {
    let fixture = WorkspaceSockFixture::new().await;

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    fixture.track_on(&mut tx);
    tx.track_network(test_network());

    let resources = tx.commit_without_cow_for_test().unwrap();
    drop(tx);

    assert_eq!(
        resources.sandbox_paths.workspace(),
        fixture.workspace.as_path()
    );
    assert_eq!(resources.sock_paths.dir(), fixture.sock_dir.as_path());
    let network = resources.network;
    assert_eq!(network.name(), "test-ns");
    let _ = network.into_info_for_test();
    assert!(fixture.workspace.exists());
    assert!(fixture.sock_dir.exists());
}

#[tokio::test]
async fn create_transaction_commit_rejects_test_cow_without_losing_base_resources() {
    let fixture = WorkspaceSockFixture::new().await;
    let (leak_tx, mut leak_rx) = tokio::sync::mpsc::unbounded_channel();

    let mut tx = SandboxCreateTransaction::new_with_leak_tx("sandbox".into(), Some(leak_tx));
    fixture.track_on(&mut tx);
    tx.track_network(test_network());
    tx.track_test_cow_device_for_test();

    assert!(tx.commit().is_err());

    drop(tx);
    let mut leaked = leak_rx.recv().await.unwrap();
    assert!(leaked.cow_device.is_none());
    assert!(leaked.delete_workspace);
    let network = leaked.network.take().unwrap();
    assert_eq!(network.name(), "test-ns");
    let _ = network.into_info_for_test();
    assert_eq!(leaked.sock_dir, fixture.sock_dir);
    assert_eq!(leaked.workspace, fixture.workspace);
}

#[tokio::test]
async fn create_transaction_drop_without_async_resources_removes_dirs() {
    let fixture = WorkspaceSockFixture::new().await;

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    fixture.track_on(&mut tx);

    drop(tx);

    assert!(!fixture.workspace.exists());
    assert!(!fixture.sock_dir.exists());
}

#[tokio::test]
async fn create_transaction_drop_with_test_cow_only_does_not_send_empty_leak_work() {
    let fixture = WorkspaceSockFixture::new().await;
    let (leak_tx, mut leak_rx) = tokio::sync::mpsc::unbounded_channel();

    let mut tx = SandboxCreateTransaction::new_with_leak_tx("sandbox".into(), Some(leak_tx));
    fixture.track_on(&mut tx);
    tx.track_test_cow_device_for_test();

    drop(tx);

    assert!(matches!(
        leak_rx.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)
    ));
    assert!(!fixture.workspace.exists());
    assert!(!fixture.sock_dir.exists());
}

#[tokio::test]
async fn create_transaction_drop_with_closed_leak_channel_falls_back_to_sync_dirs() {
    let fixture = WorkspaceSockFixture::new().await;
    let (leak_tx, leak_rx) = tokio::sync::mpsc::unbounded_channel();
    drop(leak_rx);

    let mut tx = SandboxCreateTransaction::new_with_leak_tx("sandbox".into(), Some(leak_tx));
    fixture.track_on(&mut tx);
    tx.track_network(test_network());

    assert!(!tx.send_async_leaked_resources());
    let network = tx.network.take().unwrap();
    assert_eq!(network.name(), "test-ns");
    let _ = network.into_info_for_test();

    drop(tx);

    assert!(!fixture.workspace.exists());
    assert!(!fixture.sock_dir.exists());
}

#[tokio::test]
async fn create_transaction_drop_sync_fallback_respects_workspace_preservation() {
    let fixture = WorkspaceSockFixture::new().await;

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    fixture.track_on(&mut tx);
    tx.delete_workspace_on_leak_cleanup = false;

    drop(tx);

    assert!(fixture.workspace.exists());
    assert!(!fixture.sock_dir.exists());
}

#[tokio::test]
async fn create_transaction_drop_does_not_drop_queued_leak_cleanup_work() {
    let fixture = WorkspaceSockFixture::new().await;
    let (leak_tx, mut leak_rx) = tokio::sync::mpsc::unbounded_channel();
    leak_tx.send(test_leaked_resource("queued")).unwrap();

    let mut tx = SandboxCreateTransaction::new_with_leak_tx("sandbox".into(), Some(leak_tx));
    fixture.track_on(&mut tx);
    tx.track_network(test_network());

    drop(tx);

    let queued = leak_rx.recv().await.unwrap();
    assert_eq!(queued.sandbox_id, "queued");
    assert!(queued.network.is_none());
    let mut leaked = leak_rx.recv().await.unwrap();
    assert_eq!(leaked.sandbox_id, "sandbox");
    let network = leaked.network.take().unwrap();
    assert_eq!(network.name(), "test-ns");
    let _ = network.into_info_for_test();
    assert_eq!(leaked.sock_dir, fixture.sock_dir);
    assert_eq!(leaked.workspace, fixture.workspace);
}

#[tokio::test]
async fn create_transaction_drop_sends_async_resources_to_leak_cleaner() {
    let fixture = WorkspaceSockFixture::new().await;
    let (leak_tx, mut leak_rx) = tokio::sync::mpsc::unbounded_channel();

    let mut tx = SandboxCreateTransaction::new_with_leak_tx("sandbox".into(), Some(leak_tx));
    fixture.track_on(&mut tx);
    tx.track_network(test_network());

    drop(tx);

    let mut leaked = leak_rx.recv().await.unwrap();
    assert_eq!(leaked.sandbox_id, "sandbox");
    assert!(leaked.cow_device.is_none());
    let network = leaked.network.take().unwrap();
    assert_eq!(network.name(), "test-ns");
    let _ = network.into_info_for_test();
    assert_eq!(leaked.sock_dir, fixture.sock_dir);
    assert_eq!(leaked.workspace, fixture.workspace);
}

#[tokio::test]
async fn create_transaction_rollback_continues_after_waiter_abort() {
    let fixture = WorkspaceSockFixture::new().await;

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    fixture.track_on(&mut tx);

    let cleanup = BlockingRemoveDirCleanup::default();
    let _cleanup_scope = cleanup.scope();
    let cleanup_group = Arc::new(FactoryCleanupGroup::new());
    let rollback_group = Arc::clone(&cleanup_group);
    let rollback_cleanup = cleanup.clone();
    let waiter = tokio::spawn(async move {
        rollback_create_transaction(tx, rollback_cleanup, &rollback_group).await;
    });
    cleanup.track_task(&waiter);

    tokio::time::timeout(std::time::Duration::from_secs(1), cleanup.wait_entered(1))
        .await
        .unwrap();
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());

    let shutdown_group = Arc::clone(&cleanup_group);
    let shutdown_task = tokio::spawn(async move {
        shutdown_group.shutdown().await;
    });
    cleanup.track_task(&shutdown_task);
    tokio::task::yield_now().await;
    assert!(!shutdown_task.is_finished());

    cleanup.release();
    tokio::time::timeout(std::time::Duration::from_secs(1), shutdown_task)
        .await
        .unwrap()
        .unwrap();
    cleanup.wait_removed(2, &fixture).await;

    assert!(!fixture.sock_dir.exists());
    assert!(!fixture.workspace.exists());
    assert_eq!(
        cleanup.events(),
        vec!["remove_dir:sock:sock", "remove_dir:workspace:workspace"]
    );
}

#[tokio::test]
async fn create_transaction_rollback_filesystem_cleanup_survives_task_abort() {
    let fixture = WorkspaceSockFixture::new().await;

    let mut tx = SandboxCreateTransaction::new("sandbox".into());
    fixture.track_on(&mut tx);

    let cleanup = BlockingRemoveDirCleanup::default();
    let _cleanup_scope = cleanup.scope();
    let cleanup_group = FactoryCleanupGroup::new();
    let rollback_cleanup = cleanup.clone();
    let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel();
    let rollback_waiter =
        cleanup_group.spawn(FactoryCleanupTaskKind::Rollback, "sandbox", async move {
            let _drop_signal = RollbackTaskDropSignal(Some(dropped_tx));
            let mut tx = tx;
            tx.rollback(&rollback_cleanup).await;
        });
    drop(rollback_waiter);

    tokio::time::timeout(std::time::Duration::from_secs(1), cleanup.wait_entered(2))
        .await
        .unwrap();
    assert!(fixture.workspace.exists());
    assert!(fixture.sock_dir.exists());

    drop(cleanup_group);
    tokio::time::timeout(std::time::Duration::from_secs(1), dropped_rx)
        .await
        .unwrap()
        .unwrap();

    assert!(fixture.workspace.exists());
    assert!(fixture.sock_dir.exists());

    cleanup.release();
    cleanup.wait_removed(2, &fixture).await;

    assert!(!fixture.workspace.exists());
    assert!(!fixture.sock_dir.exists());
    assert_eq!(
        cleanup.events(),
        vec!["remove_dir:sock:sock", "remove_dir:workspace:workspace"]
    );
}
