use super::*;

const STALE_RECORD_PID: u32 = u32::MAX;
const STALE_RECORD_STARTTIME: u64 = 1;
const TEST_PROCFS_BOOT_ID: &str = "11111111-2222-3333-4444-555555555555";
const TEST_PROCFS_PID: u32 = 1234;
const TEST_PROCFS_STARTTIME: u64 = 123456;
const TEST_STARTED_AT: &str = "2026-01-01T00:00:00.000Z";

#[cfg(unix)]
struct ChildGuard(std::process::Child);

#[cfg(unix)]
impl ChildGuard {
    fn spawn() -> Self {
        Self(
            std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .unwrap(),
        )
    }

    fn pid(&self) -> u32 {
        self.0.id()
    }
}

#[cfg(unix)]
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct TestProcfs {
    dir: tempfile::TempDir,
}

impl TestProcfs {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let procfs = Self { dir };
        std::fs::create_dir_all(procfs.root().join("sys/kernel/random")).unwrap();
        std::fs::write(
            procfs.root().join("sys/kernel/random/boot_id"),
            TEST_PROCFS_BOOT_ID,
        )
        .unwrap();
        std::fs::create_dir_all(procfs.process_dir()).unwrap();
        procfs.write_stat('S', TEST_PROCFS_STARTTIME);
        procfs.write_status(current_euid());
        procfs
    }

    fn root(&self) -> &Path {
        self.dir.path()
    }

    fn process_dir(&self) -> PathBuf {
        self.root().join(TEST_PROCFS_PID.to_string())
    }

    fn stat_path(&self) -> PathBuf {
        self.process_dir().join("stat")
    }

    fn status_path(&self) -> PathBuf {
        self.process_dir().join("status")
    }

    fn liveness(&self) -> LivenessContext {
        LivenessContext::with_proc_root(self.root().to_path_buf())
    }

    fn write_stat(&self, state: char, starttime: u64) {
        let fields = [
            state.to_string(),
            "1".into(),
            TEST_PROCFS_PID.to_string(),
            "1".into(),
            "0".into(),
            "-1".into(),
            "4194560".into(),
            "0".into(),
            "0".into(),
            "0".into(),
            "0".into(),
            "0".into(),
            "0".into(),
            "0".into(),
            "0".into(),
            "20".into(),
            "0".into(),
            "1".into(),
            "0".into(),
            starttime.to_string(),
        ];
        std::fs::write(
            self.stat_path(),
            format!("{TEST_PROCFS_PID} (runner) {}", fields.join(" ")),
        )
        .unwrap();
    }

    fn write_status(&self, euid: u32) {
        std::fs::write(
            self.status_path(),
            format!("Name:\trunner\nUid:\t{euid}\t{euid}\t{euid}\t{euid}\n"),
        )
        .unwrap();
    }

    fn make_stat_unreadable(&self) {
        std::fs::remove_file(self.stat_path()).unwrap();
        std::fs::create_dir(self.stat_path()).unwrap();
    }

    fn make_status_unreadable(&self) {
        std::fs::remove_file(self.status_path()).unwrap();
        std::fs::create_dir(self.status_path()).unwrap();
    }
}

#[derive(Clone, Copy, Debug)]
enum InconclusiveProcfs {
    UnreadableStat,
    InvalidStat,
    UnreadableStatus,
    InvalidStatus,
}

impl InconclusiveProcfs {
    const ALL: [Self; 4] = [
        Self::UnreadableStat,
        Self::InvalidStat,
        Self::UnreadableStatus,
        Self::InvalidStatus,
    ];

    fn apply(self, procfs: &TestProcfs) {
        match self {
            Self::UnreadableStat => procfs.make_stat_unreadable(),
            Self::InvalidStat => std::fs::write(procfs.stat_path(), b"invalid stat").unwrap(),
            Self::UnreadableStatus => procfs.make_status_unreadable(),
            Self::InvalidStatus => {
                std::fs::write(procfs.status_path(), b"Uid:\t1000\tnot-a-uid\n").unwrap();
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum ConclusivelyStaleProcfs {
    MissingProcess,
    TerminalProcess,
    StarttimeMismatch,
    MissingStatus,
    EuidMismatch,
}

impl ConclusivelyStaleProcfs {
    const ALL: [Self; 5] = [
        Self::MissingProcess,
        Self::TerminalProcess,
        Self::StarttimeMismatch,
        Self::MissingStatus,
        Self::EuidMismatch,
    ];

    fn apply(self, procfs: &TestProcfs) {
        match self {
            Self::MissingProcess => std::fs::remove_dir_all(procfs.process_dir()).unwrap(),
            Self::TerminalProcess => procfs.write_stat('Z', TEST_PROCFS_STARTTIME),
            Self::StarttimeMismatch => procfs.write_stat('S', TEST_PROCFS_STARTTIME + 1),
            Self::MissingStatus => std::fs::remove_file(procfs.status_path()).unwrap(),
            Self::EuidMismatch => procfs.write_status(current_euid().wrapping_add(1)),
        }
    }
}

struct TestRegistry {
    dir: tempfile::TempDir,
    home: HomePaths,
}

impl TestRegistry {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().join("vm0-runner"));
        Self { dir, home }
    }

    fn root(&self) -> &Path {
        self.dir.path()
    }

    fn metadata(&self) -> LiveRunnerInstanceMetadata {
        LiveRunnerInstanceMetadata {
            config_path: self.root().join("runner.yaml"),
            base_dir: self.root().join("base"),
            runner_group: "vm0/test".into(),
            subcommand: "start".into(),
        }
    }

    fn ensure_dir(&self) {
        crate::host_file::ensure_dir(
            &self.home.live_runner_instances_dir(),
            crate::host_file::DirMode::Private,
            "live runner instances",
        )
        .unwrap();
    }

    async fn stale_record(&self) -> LiveRunnerInstanceRecord {
        LiveRunnerInstanceRecord {
            boot_id: current_boot_id().await.unwrap(),
            pid: STALE_RECORD_PID,
            starttime: STALE_RECORD_STARTTIME,
            euid: current_euid(),
            config_path: self.root().join("stale-runner.yaml"),
            base_dir: self.root().join("stale-base"),
            runner_group: "vm0/test".into(),
            subcommand: "start".into(),
            started_at: TEST_STARTED_AT.into(),
        }
    }

    async fn other_live_process_record(
        &self,
        pid: u32,
        starttime: u64,
    ) -> LiveRunnerInstanceRecord {
        LiveRunnerInstanceRecord {
            boot_id: current_boot_id().await.unwrap(),
            pid,
            starttime,
            euid: current_euid(),
            config_path: self.root().join("other-runner.yaml"),
            base_dir: self.root().join("other-base"),
            runner_group: "vm0/test".into(),
            subcommand: "start".into(),
            started_at: TEST_STARTED_AT.into(),
        }
    }

    fn procfs_record(&self) -> LiveRunnerInstanceRecord {
        LiveRunnerInstanceRecord {
            boot_id: TEST_PROCFS_BOOT_ID.into(),
            pid: TEST_PROCFS_PID,
            starttime: TEST_PROCFS_STARTTIME,
            euid: current_euid(),
            config_path: self.root().join("procfs-runner.yaml"),
            base_dir: self.root().join("procfs-base"),
            runner_group: "vm0/test".into(),
            subcommand: "start".into(),
            started_at: TEST_STARTED_AT.into(),
        }
    }

    fn record_path(&self, record: &LiveRunnerInstanceRecord) -> PathBuf {
        self.home
            .live_runner_instance_record_path(record.pid, record.starttime)
    }

    fn tmp_path_for_record(&self, record: &LiveRunnerInstanceRecord) -> PathBuf {
        self.home.live_runner_instances_dir().join(format!(
            ".{}-{}.json.test.tmp",
            record.pid, record.starttime
        ))
    }

    fn stale_tmp_path(&self) -> PathBuf {
        self.home.live_runner_instances_dir().join(format!(
            ".{}-{}.json.test.tmp",
            STALE_RECORD_PID, STALE_RECORD_STARTTIME
        ))
    }

    async fn write_record_at_identity(&self, record: &LiveRunnerInstanceRecord) -> PathBuf {
        let path = self.record_path(record);
        write_record(&path, record).await;
        path
    }
}

async fn write_record(path: &Path, record: &LiveRunnerInstanceRecord) {
    let content = serde_json::to_vec_pretty(record).unwrap();
    crate::state_file::write_private_atomic(path, &content)
        .await
        .unwrap();
}

fn serialize_record_without_subcommand(record: &LiveRunnerInstanceRecord) -> Vec<u8> {
    let mut value = serde_json::to_value(record).unwrap();
    value.as_object_mut().unwrap().remove("subcommand").unwrap();
    serde_json::to_vec_pretty(&value).unwrap()
}

#[tokio::test]
async fn publish_writes_private_record_without_secret_fields() {
    let registry = TestRegistry::new();

    let handle = publish(&registry.home, registry.metadata()).await.unwrap();

    let content = tokio::fs::read_to_string(&handle.path).await.unwrap();
    assert!(!content.contains("server"));
    assert!(!content.contains("token"));
    assert!(!content.contains("api_url"));
    let record: LiveRunnerInstanceRecord = serde_json::from_str(&content).unwrap();
    assert_eq!(record.pid, std::process::id());
    assert_eq!(record.euid, current_euid());
    assert_eq!(record.base_dir, registry.root().join("base"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let metadata = std::fs::symlink_metadata(&handle.path).unwrap();
        assert!(metadata.file_type().is_file());
        assert!(!metadata.file_type().is_symlink());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        assert_eq!(
            std::fs::metadata(registry.home.live_runner_instances_dir())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}

#[tokio::test]
async fn read_valid_record_accepts_matching_live_identity() {
    let registry = TestRegistry::new();
    let handle = publish(&registry.home, registry.metadata()).await.unwrap();

    let record = read_valid_record(&handle.path).await.unwrap();

    assert_eq!(record.boot_id, handle.identity.boot_id);
    assert_eq!(record.pid, handle.identity.pid);
    assert_eq!(record.starttime, handle.identity.starttime);
}

#[tokio::test]
async fn try_list_returns_empty_when_registry_dir_is_missing() {
    let registry = TestRegistry::new();

    let instances = try_list(&registry.home).await.unwrap();

    assert!(instances.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn try_list_rejects_symlinked_registry_dir() {
    use std::os::unix::fs::symlink;

    let registry = TestRegistry::new();
    std::fs::create_dir_all(registry.root().join("target")).unwrap();
    std::fs::create_dir_all(registry.root().join("vm0-runner")).unwrap();
    symlink(
        registry.root().join("target"),
        registry.home.live_runner_instances_dir(),
    )
    .unwrap();

    let error = match try_list(&registry.home).await {
        Ok(_) => panic!("expected symlinked registry dir to fail"),
        Err(error) => error,
    };

    assert!(
        error.to_string().contains("validate live runner instances"),
        "{error}"
    );
}

#[tokio::test]
async fn try_list_returns_valid_live_instance_metadata() {
    let registry = TestRegistry::new();
    let handle = publish(&registry.home, registry.metadata()).await.unwrap();

    let instances = try_list(&registry.home).await.unwrap();

    assert_eq!(instances.len(), 1);
    let instance = &instances[0];
    assert_eq!(instance.pid, handle.identity.pid);
    assert_eq!(instance.starttime, handle.identity.starttime);
    assert_eq!(instance.config_path, registry.root().join("runner.yaml"));
    assert_eq!(instance.base_dir, registry.root().join("base"));
    assert_eq!(instance.runner_group, "vm0/test");
    assert_eq!(instance.subcommand, "start");
    assert!(!instance.started_at.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn try_list_sorts_multiple_live_instances() {
    let registry = TestRegistry::new();
    let _handle = publish(&registry.home, registry.metadata()).await.unwrap();
    let child = ChildGuard::spawn();
    let child_stat = process::read_process_stat(child.pid()).await.unwrap();
    let child_record = registry
        .other_live_process_record(child.pid(), child_stat.starttime)
        .await;
    registry.write_record_at_identity(&child_record).await;

    let instances = try_list(&registry.home).await.unwrap();

    assert_eq!(
        instances
            .iter()
            .map(|instance| instance.config_path.clone())
            .collect::<Vec<_>>(),
        [
            registry.root().join("other-runner.yaml"),
            registry.root().join("runner.yaml"),
        ]
    );
}

#[tokio::test]
async fn try_list_fails_closed_for_missing_subcommand_with_live_file_identity() {
    let registry = TestRegistry::new();
    let handle = publish(&registry.home, registry.metadata()).await.unwrap();
    let record = read_valid_record(&handle.path).await.unwrap();
    crate::state_file::write_private_atomic(
        &handle.path,
        &serialize_record_without_subcommand(&record),
    )
    .await
    .unwrap();

    let error = match try_list(&registry.home).await {
        Ok(_) => panic!("expected missing subcommand for live record to fail"),
        Err(error) => error,
    };

    assert!(
        error.to_string().contains("live process identity"),
        "{error}"
    );
    assert!(handle.path.exists());
}

#[tokio::test]
async fn try_list_preserves_unknown_explicit_subcommand() {
    let registry = TestRegistry::new();
    let mut metadata = registry.metadata();
    metadata.subcommand = "future-subcommand".into();
    let _handle = publish(&registry.home, metadata).await.unwrap();

    let instances = try_list(&registry.home).await.unwrap();

    assert_eq!(instances.len(), 1);
    assert_eq!(instances[0].subcommand, "future-subcommand");
}

#[tokio::test]
async fn try_list_ignores_invalid_records_for_stale_file_identities() {
    let registry = TestRegistry::new();
    registry.ensure_dir();
    let stale_record = registry.stale_record().await;
    let stale_path = registry.record_path(&stale_record);
    crate::state_file::write_private_atomic(
        &stale_path,
        &serialize_record_without_subcommand(&stale_record),
    )
    .await
    .unwrap();
    crate::state_file::write_private_atomic(
        &registry.home.live_runner_instance_record_path(1, 1),
        b"{",
    )
    .await
    .unwrap();
    crate::state_file::write_private_atomic(
        &registry.home.live_runner_instance_record_path(2, 2),
        &vec![b'a'; (LIVE_RUNNER_INSTANCE_RECORD_MAX_BYTES + 1) as usize],
    )
    .await
    .unwrap();
    crate::state_file::write_private_atomic(
        &registry
            .home
            .live_runner_instances_dir()
            .join("not-a-record.json"),
        b"{}",
    )
    .await
    .unwrap();

    let instances = try_list(&registry.home).await.unwrap();

    assert!(instances.is_empty());
    assert!(!stale_path.exists());
}

#[tokio::test]
async fn try_list_fails_closed_for_invalid_record_with_live_file_identity() {
    let registry = TestRegistry::new();
    let handle = publish(&registry.home, registry.metadata()).await.unwrap();
    crate::state_file::write_private_atomic(&handle.path, b"{")
        .await
        .unwrap();

    let error = match try_list(&registry.home).await {
        Ok(_) => panic!("expected invalid live record to fail"),
        Err(error) => error,
    };

    assert!(
        error.to_string().contains("live process identity"),
        "{error}"
    );
    assert!(handle.path.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn try_list_fails_closed_for_unreadable_record_with_live_file_identity() {
    use std::os::unix::fs::symlink;

    let registry = TestRegistry::new();
    let handle = publish(&registry.home, registry.metadata()).await.unwrap();
    let target = registry.root().join("symlink-target");
    tokio::fs::write(&target, b"{}").await.unwrap();
    tokio::fs::remove_file(&handle.path).await.unwrap();
    symlink(&target, &handle.path).unwrap();

    let error = match try_list(&registry.home).await {
        Ok(_) => panic!("expected unreadable live record to fail"),
        Err(error) => error,
    };

    assert!(
        error.to_string().contains("live process identity"),
        "{error}"
    );
    assert!(
        std::fs::symlink_metadata(&handle.path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[tokio::test]
async fn try_list_ignores_records_with_mismatched_stale_file_identity() {
    let registry = TestRegistry::new();
    let handle = publish(&registry.home, registry.metadata()).await.unwrap();
    let record = read_valid_record(&handle.path).await.unwrap();
    tokio::fs::remove_file(&handle.path).await.unwrap();
    let mismatched_path = registry
        .home
        .live_runner_instance_record_path(record.pid, record.starttime + 1);
    write_record(&mismatched_path, &record).await;

    let instances = try_list(&registry.home).await.unwrap();

    assert!(instances.is_empty());
}

#[tokio::test]
async fn is_current_tracks_the_exact_registry_entry() {
    let registry = TestRegistry::new();
    let handle = publish(&registry.home, registry.metadata()).await.unwrap();
    let instance = try_list(&registry.home)
        .await
        .unwrap()
        .into_iter()
        .next()
        .unwrap();

    assert!(is_current(&registry.home, &instance).await.unwrap());

    tokio::fs::remove_file(&handle.path).await.unwrap();

    assert!(!is_current(&registry.home, &instance).await.unwrap());
}

#[tokio::test]
async fn read_valid_record_ignores_stale_pid() {
    let registry = TestRegistry::new();
    registry.ensure_dir();
    let record = registry.stale_record().await;
    let path = registry.write_record_at_identity(&record).await;

    let result = read_valid_record(&path).await;

    assert!(result.is_none());
}

#[tokio::test]
async fn read_valid_record_ignores_starttime_mismatch() {
    let registry = TestRegistry::new();
    let handle = publish(&registry.home, registry.metadata()).await.unwrap();
    let mut record = read_valid_record(&handle.path).await.unwrap();
    record.starttime += 1;
    write_record(&handle.path, &record).await;

    let result = read_valid_record(&handle.path).await;

    assert!(result.is_none());
}

#[tokio::test]
async fn read_valid_record_ignores_boot_id_mismatch() {
    let registry = TestRegistry::new();
    let handle = publish(&registry.home, registry.metadata()).await.unwrap();
    let mut record = read_valid_record(&handle.path).await.unwrap();
    record.boot_id = "00000000-0000-0000-0000-000000000000".into();
    write_record(&handle.path, &record).await;

    let result = read_valid_record(&handle.path).await;

    assert!(result.is_none());
}

#[tokio::test]
async fn read_valid_record_ignores_malformed_json() {
    let registry = TestRegistry::new();
    registry.ensure_dir();
    let path = registry
        .home
        .live_runner_instances_dir()
        .join("malformed.json");
    crate::state_file::write_private_atomic(&path, b"{")
        .await
        .unwrap();

    let result = read_valid_record(&path).await;

    assert!(result.is_none());
}

#[tokio::test]
async fn read_valid_record_ignores_oversized_file() {
    let registry = TestRegistry::new();
    registry.ensure_dir();
    let path = registry
        .home
        .live_runner_instances_dir()
        .join("oversized.json");
    crate::state_file::write_private_atomic(
        &path,
        &vec![b'a'; (LIVE_RUNNER_INSTANCE_RECORD_MAX_BYTES + 1) as usize],
    )
    .await
    .unwrap();

    let result = read_valid_record(&path).await;

    assert!(result.is_none());
}

#[tokio::test]
async fn publish_removes_stale_records() {
    let registry = TestRegistry::new();
    registry.ensure_dir();
    let stale_record = registry.stale_record().await;
    let stale_path = registry.write_record_at_identity(&stale_record).await;
    let stale_tmp_path = registry.stale_tmp_path();
    tokio::fs::write(&stale_tmp_path, b"partial").await.unwrap();

    let _handle = publish(&registry.home, registry.metadata()).await.unwrap();

    assert!(!stale_path.exists());
    assert!(!stale_tmp_path.exists());
}

#[tokio::test]
async fn try_list_removes_stale_records() {
    let registry = TestRegistry::new();
    let handle = publish(&registry.home, registry.metadata()).await.unwrap();
    let stale_record = registry.stale_record().await;
    let stale_path = registry.write_record_at_identity(&stale_record).await;
    let stale_tmp_path = registry.stale_tmp_path();
    tokio::fs::write(&stale_tmp_path, b"partial").await.unwrap();

    let instances = try_list(&registry.home).await.unwrap();

    assert_eq!(instances.len(), 1);
    assert_eq!(instances[0].pid, handle.identity.pid);
    assert!(!stale_path.exists());
    assert!(!stale_tmp_path.exists());
}

#[tokio::test]
async fn try_list_keeps_live_tmp_file() {
    let registry = TestRegistry::new();
    let handle = publish(&registry.home, registry.metadata()).await.unwrap();
    let record = read_valid_record(&handle.path).await.unwrap();
    let live_tmp_path = registry.tmp_path_for_record(&record);
    tokio::fs::write(&live_tmp_path, b"partial").await.unwrap();

    let instances = try_list(&registry.home).await.unwrap();

    assert_eq!(instances.len(), 1);
    assert!(live_tmp_path.exists());
}

#[tokio::test]
async fn try_list_preserves_record_when_procfs_observation_is_inconclusive() {
    for scenario in InconclusiveProcfs::ALL {
        let registry = TestRegistry::new();
        registry.ensure_dir();
        let procfs = TestProcfs::new();
        let record = registry.procfs_record();
        let record_path = registry.write_record_at_identity(&record).await;
        scenario.apply(&procfs);

        let result = try_list_with_liveness(&registry.home, &procfs.liveness()).await;

        assert!(result.is_err(), "{scenario:?}");
        assert!(record_path.exists(), "{scenario:?}");
    }
}

#[tokio::test]
async fn stale_cleanup_preserves_files_when_procfs_observation_is_inconclusive() {
    for scenario in InconclusiveProcfs::ALL {
        let registry = TestRegistry::new();
        registry.ensure_dir();
        let procfs = TestProcfs::new();
        let record = registry.procfs_record();
        let record_path = registry.write_record_at_identity(&record).await;
        let tmp_path = registry.tmp_path_for_record(&record);
        tokio::fs::write(&tmp_path, b"partial").await.unwrap();
        scenario.apply(&procfs);

        remove_stale_records_with_liveness(&registry.home, &procfs.liveness()).await;

        assert!(record_path.exists(), "{scenario:?}");
        assert!(tmp_path.exists(), "{scenario:?}");
    }
}

#[tokio::test]
async fn stale_cleanup_removes_files_for_conclusive_process_observations() {
    for scenario in ConclusivelyStaleProcfs::ALL {
        let registry = TestRegistry::new();
        registry.ensure_dir();
        let procfs = TestProcfs::new();
        let record = registry.procfs_record();
        let record_path = registry.write_record_at_identity(&record).await;
        let tmp_path = registry.tmp_path_for_record(&record);
        tokio::fs::write(&tmp_path, b"partial").await.unwrap();
        scenario.apply(&procfs);

        remove_stale_records_with_liveness(&registry.home, &procfs.liveness()).await;

        assert!(!record_path.exists(), "{scenario:?}");
        assert!(!tmp_path.exists(), "{scenario:?}");
    }
}

#[tokio::test]
async fn try_list_accepts_valid_procfs_identity_and_preserves_tmp_file() {
    let registry = TestRegistry::new();
    registry.ensure_dir();
    let procfs = TestProcfs::new();
    let record = registry.procfs_record();
    registry.write_record_at_identity(&record).await;
    let tmp_path = registry.tmp_path_for_record(&record);
    tokio::fs::write(&tmp_path, b"partial").await.unwrap();

    let instances = try_list_with_liveness(&registry.home, &procfs.liveness())
        .await
        .unwrap();

    assert_eq!(instances.len(), 1);
    assert_eq!(instances[0].pid, TEST_PROCFS_PID);
    assert_eq!(instances[0].starttime, TEST_PROCFS_STARTTIME);
    assert!(tmp_path.exists());
}

#[tokio::test]
async fn publish_removes_records_with_mismatched_file_identity() {
    let registry = TestRegistry::new();
    let handle = publish(&registry.home, registry.metadata()).await.unwrap();
    let record = read_valid_record(&handle.path).await.unwrap();
    tokio::fs::remove_file(&handle.path).await.unwrap();
    let mismatched_path = registry
        .home
        .live_runner_instance_record_path(record.pid, record.starttime + 1);
    write_record(&mismatched_path, &record).await;

    let _handle = publish(&registry.home, registry.metadata()).await.unwrap();

    assert!(!mismatched_path.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn publish_keeps_other_live_runner_instance_records() {
    let child = ChildGuard::spawn();
    let child_pid = child.pid();
    let registry = TestRegistry::new();
    registry.ensure_dir();
    let child_stat = process::read_process_stat(child_pid).await.unwrap();
    let live_record = registry
        .other_live_process_record(child_pid, child_stat.starttime)
        .await;
    let live_path = registry.write_record_at_identity(&live_record).await;
    let live_tmp_path = registry.tmp_path_for_record(&live_record);
    tokio::fs::write(&live_tmp_path, b"partial").await.unwrap();

    let _handle = publish(&registry.home, registry.metadata()).await.unwrap();

    assert!(live_path.exists());
    assert!(live_tmp_path.exists());
}

#[tokio::test]
async fn remove_if_current_removes_matching_record() {
    let registry = TestRegistry::new();
    let handle = publish(&registry.home, registry.metadata()).await.unwrap();

    let removed = handle.remove_if_current().await.unwrap();

    assert!(removed);
    assert!(!handle.path.exists());
}

#[tokio::test]
async fn remove_if_current_preserves_mismatched_record() {
    let registry = TestRegistry::new();
    let handle = publish(&registry.home, registry.metadata()).await.unwrap();
    let mut record = read_valid_record(&handle.path).await.unwrap();
    record.starttime += 1;
    write_record(&handle.path, &record).await;

    let removed = handle.remove_if_current().await.unwrap();

    assert!(!removed);
    assert!(handle.path.exists());
}

#[tokio::test]
async fn remove_if_current_removes_invalid_current_record() {
    let registry = TestRegistry::new();
    let handle = publish(&registry.home, registry.metadata()).await.unwrap();
    crate::state_file::write_private_atomic(&handle.path, b"{")
        .await
        .unwrap();

    let removed = handle.remove_if_current().await.unwrap();

    assert!(removed);
    assert!(!handle.path.exists());
}
