use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use chrono::SecondsFormat;
use serde::{Deserialize, Serialize};
use tokio::sync::OnceCell;

use crate::error::{HostError, HostResult};
use crate::paths::HomePaths;
use crate::process;
use crate::state_file::OwnerCheck;

const LIVE_RUNNER_INSTANCE_RECORD_MAX_BYTES: u64 = 64 * 1024;

#[derive(Debug)]
pub struct LiveRunnerInstanceMetadata {
    pub config_path: PathBuf,
    pub base_dir: PathBuf,
    pub runner_group: String,
    pub subcommand: String,
}

#[derive(Debug)]
pub struct LiveRunnerInstanceHandle {
    path: PathBuf,
    identity: ProcessIdentity,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveRunnerInstance {
    pub pid: u32,
    pub starttime: u64,
    pub config_path: PathBuf,
    pub base_dir: PathBuf,
    pub runner_group: String,
    pub subcommand: String,
    pub started_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProcessIdentity {
    boot_id: String,
    pid: u32,
    starttime: u64,
    euid: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileProcessIdentity {
    pid: u32,
    starttime: u64,
}

struct LivenessContext {
    boot_id: OnceCell<String>,
    euid: u32,
    proc_root: PathBuf,
}

impl LivenessContext {
    fn new() -> Self {
        Self::with_proc_root(PathBuf::from("/proc"))
    }

    fn with_proc_root(proc_root: PathBuf) -> Self {
        Self {
            boot_id: OnceCell::new(),
            euid: current_euid(),
            proc_root,
        }
    }

    async fn boot_id(&self) -> HostResult<&str> {
        self.boot_id
            .get_or_try_init(|| read_boot_id(&self.proc_root))
            .await
            .map(String::as_str)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct LiveRunnerInstanceRecord {
    boot_id: String,
    pid: u32,
    starttime: u64,
    euid: u32,
    config_path: PathBuf,
    base_dir: PathBuf,
    runner_group: String,
    subcommand: String,
    started_at: String,
}

enum RecordForIdentity {
    Valid(LiveRunnerInstanceRecord),
    InvalidForLiveProcess,
    InvalidForStaleProcess,
}

enum RecordRead {
    Valid(LiveRunnerInstanceRecord),
    Missing,
    InvalidFile,
    NotLive,
}

pub async fn publish(
    home: &HomePaths,
    metadata: LiveRunnerInstanceMetadata,
) -> HostResult<LiveRunnerInstanceHandle> {
    let identity = current_process_identity().await?;
    let path = home.live_runner_instance_record_path(identity.pid, identity.starttime);
    let record = LiveRunnerInstanceRecord {
        boot_id: identity.boot_id.clone(),
        pid: identity.pid,
        starttime: identity.starttime,
        euid: identity.euid,
        config_path: metadata.config_path,
        base_dir: metadata.base_dir,
        runner_group: metadata.runner_group,
        subcommand: metadata.subcommand,
        started_at: chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    };
    let content = serde_json::to_vec_pretty(&record)
        .map_err(|e| HostError::Internal(format!("serialize live runner instance: {e}")))?;

    crate::host_file::ensure_dir(
        &home.live_runner_instances_dir(),
        crate::host_file::DirMode::Private,
        "live runner instances",
    )
    .map_err(|e| {
        HostError::Internal(format!(
            "ensure live runner instances {}: {e}",
            home.live_runner_instances_dir().display()
        ))
    })?;
    remove_stale_records(home).await;
    crate::state_file::write_private_atomic(&path, &content).await?;

    Ok(LiveRunnerInstanceHandle { path, identity })
}

pub async fn try_list(home: &HomePaths) -> HostResult<Vec<LiveRunnerInstance>> {
    let liveness = LivenessContext::new();
    try_list_with_liveness(home, &liveness).await
}

async fn try_list_with_liveness(
    home: &HomePaths,
    liveness: &LivenessContext,
) -> HostResult<Vec<LiveRunnerInstance>> {
    if !validate_existing_live_runner_instances_dir(home)? {
        return Ok(Vec::new());
    }

    let dir = home.live_runner_instances_dir();
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(HostError::Internal(format!(
                "scan live runner instances {}: {e}",
                dir.display()
            )));
        }
    };

    let mut instances = Vec::new();
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(e) => {
                return Err(HostError::Internal(format!(
                    "read live runner instance entry in {}: {e}",
                    dir.display()
                )));
            }
        };
        let file_name = entry.file_name();
        let path = entry.path();
        if let Some(identity) = stable_record_identity_from_file_name(&file_name) {
            let record = match read_record_for_identity(&path, identity, liveness).await? {
                RecordForIdentity::Valid(record) => record,
                RecordForIdentity::InvalidForStaleProcess => {
                    remove_stale_file(&path, "stale live runner instance record").await;
                    continue;
                }
                RecordForIdentity::InvalidForLiveProcess => {
                    return Err(HostError::Internal(format!(
                        "live runner instance record {} is invalid for a live process identity",
                        path.display()
                    )));
                }
            };
            instances.push(LiveRunnerInstance {
                pid: record.pid,
                starttime: record.starttime,
                config_path: record.config_path,
                base_dir: record.base_dir,
                runner_group: record.runner_group,
                subcommand: record.subcommand,
                started_at: record.started_at,
            });
            continue;
        }
        let Some(identity) = atomic_tmp_record_identity_from_file_name(&file_name) else {
            continue;
        };
        remove_stale_tmp_file(&path, identity, liveness).await;
    }

    instances.sort_by(|left, right| {
        left.config_path
            .cmp(&right.config_path)
            .then_with(|| left.pid.cmp(&right.pid))
            .then_with(|| left.starttime.cmp(&right.starttime))
    });
    Ok(instances)
}

fn validate_existing_live_runner_instances_dir(home: &HomePaths) -> HostResult<bool> {
    let dir = home.live_runner_instances_dir();
    match std::fs::symlink_metadata(&dir) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => {
            return Err(HostError::Internal(format!(
                "stat live runner instances {}: {e}",
                dir.display()
            )));
        }
    }

    crate::host_file::validate_dir(
        &dir,
        crate::host_file::DirMode::Private,
        "live runner instances",
    )
    .map_err(|e| {
        HostError::Internal(format!(
            "validate live runner instances {}: {e}",
            dir.display()
        ))
    })?;
    Ok(true)
}

pub async fn is_current(home: &HomePaths, instance: &LiveRunnerInstance) -> HostResult<bool> {
    let liveness = LivenessContext::new();
    let identity = FileProcessIdentity {
        pid: instance.pid,
        starttime: instance.starttime,
    };
    let path = home.live_runner_instance_record_path(identity.pid, identity.starttime);
    let record = match read_record_for_identity(&path, identity, &liveness).await? {
        RecordForIdentity::Valid(record) => record,
        RecordForIdentity::InvalidForStaleProcess => return Ok(false),
        RecordForIdentity::InvalidForLiveProcess => {
            return Err(HostError::Internal(format!(
                "live runner instance record {} is invalid for a live process identity",
                path.display()
            )));
        }
    };
    Ok(record.config_path == instance.config_path
        && record.base_dir == instance.base_dir
        && record.runner_group == instance.runner_group
        && record.subcommand == instance.subcommand
        && record.started_at == instance.started_at)
}

impl LiveRunnerInstanceHandle {
    pub async fn remove_if_current(&self) -> HostResult<bool> {
        match read_record(&self.path).await? {
            RecordRead::Valid(record)
                if record.boot_id == self.identity.boot_id
                    && record.pid == self.identity.pid
                    && record.starttime == self.identity.starttime
                    && record.euid == self.identity.euid => {}
            RecordRead::InvalidFile => {}
            RecordRead::Missing | RecordRead::NotLive | RecordRead::Valid(_) => return Ok(false),
        }

        match tokio::fs::remove_file(&self.path).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(HostError::Internal(format!(
                "remove live runner instance record {}: {e}",
                self.path.display()
            ))),
        }
    }
}

#[cfg(test)]
async fn read_valid_record(path: &Path) -> Option<LiveRunnerInstanceRecord> {
    match read_record(path).await.expect("read live runner record") {
        RecordRead::Valid(record) => Some(record),
        RecordRead::Missing | RecordRead::InvalidFile | RecordRead::NotLive => None,
    }
}

async fn read_record(path: &Path) -> HostResult<RecordRead> {
    let liveness = LivenessContext::new();
    read_record_with_liveness(path, &liveness).await
}

async fn read_record_with_liveness(
    path: &Path,
    liveness: &LivenessContext,
) -> HostResult<RecordRead> {
    let content = match crate::state_file::read_to_string(
        path,
        LIVE_RUNNER_INSTANCE_RECORD_MAX_BYTES,
        OwnerCheck::CurrentEuid,
    )
    .await
    {
        Ok(Some(content)) => content,
        Ok(None) => return Ok(RecordRead::Missing),
        Err(e) => {
            tracing::info!(path = %path.display(), error = %e, "ignoring unreadable live runner instance record");
            return Ok(RecordRead::InvalidFile);
        }
    };
    let record: LiveRunnerInstanceRecord = match serde_json::from_str(&content) {
        Ok(record) => record,
        Err(e) => {
            tracing::info!(path = %path.display(), error = %e, "ignoring malformed live runner instance record");
            return Ok(RecordRead::InvalidFile);
        }
    };
    if record_is_live(&record, liveness).await? {
        Ok(RecordRead::Valid(record))
    } else {
        Ok(RecordRead::NotLive)
    }
}

async fn remove_stale_records(home: &HomePaths) {
    let liveness = LivenessContext::new();
    remove_stale_records_with_liveness(home, &liveness).await;
}

async fn remove_stale_records_with_liveness(home: &HomePaths, liveness: &LivenessContext) {
    let dir = home.live_runner_instances_dir();
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(entries) => entries,
        Err(e) => {
            tracing::info!(path = %dir.display(), error = %e, "cannot scan live runner instances");
            return;
        }
    };

    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(e) => {
                tracing::info!(path = %dir.display(), error = %e, "cannot read live runner instance entry");
                break;
            }
        };
        let file_name = entry.file_name();
        let path = entry.path();
        if let Some(identity) = stable_record_identity_from_file_name(&file_name) {
            match read_record_for_identity(&path, identity, liveness).await {
                Err(e) => {
                    tracing::info!(
                        path = %path.display(),
                        error = %e,
                        "preserving live runner instance record after liveness check failed"
                    );
                }
                Ok(RecordForIdentity::Valid(_)) | Ok(RecordForIdentity::InvalidForLiveProcess) => {}
                Ok(RecordForIdentity::InvalidForStaleProcess) => {
                    remove_stale_file(&path, "stale live runner instance record").await;
                }
            }
            continue;
        }
        let Some(identity) = atomic_tmp_record_identity_from_file_name(&file_name) else {
            continue;
        };
        remove_stale_tmp_file(&path, identity, liveness).await;
    }
}

async fn read_record_for_identity(
    path: &Path,
    identity: FileProcessIdentity,
    liveness: &LivenessContext,
) -> HostResult<RecordForIdentity> {
    let record = match read_record_with_liveness(path, liveness).await? {
        RecordRead::Valid(record) => record,
        RecordRead::Missing => return Ok(RecordForIdentity::InvalidForStaleProcess),
        RecordRead::InvalidFile | RecordRead::NotLive => {
            return invalid_record_for_identity(identity, liveness).await;
        }
    };
    if record.pid == identity.pid && record.starttime == identity.starttime {
        Ok(RecordForIdentity::Valid(record))
    } else {
        tracing::info!(
            path = %path.display(),
            record_pid = record.pid,
            record_starttime = record.starttime,
            file_pid = identity.pid,
            file_starttime = identity.starttime,
            "ignoring live runner instance record whose contents do not match file name"
        );
        invalid_record_for_identity(identity, liveness).await
    }
}

async fn invalid_record_for_identity(
    identity: FileProcessIdentity,
    liveness: &LivenessContext,
) -> HostResult<RecordForIdentity> {
    if file_process_identity_is_live(identity, liveness).await? {
        Ok(RecordForIdentity::InvalidForLiveProcess)
    } else {
        Ok(RecordForIdentity::InvalidForStaleProcess)
    }
}

async fn remove_stale_tmp_file(
    path: &Path,
    identity: FileProcessIdentity,
    liveness: &LivenessContext,
) {
    match file_process_identity_is_live(identity, liveness).await {
        Ok(true) => {}
        Ok(false) => {
            remove_stale_file(path, "stale live runner instance tmp file").await;
        }
        Err(e) => {
            tracing::info!(
                path = %path.display(),
                error = %e,
                "preserving live runner instance tmp file after liveness check failed"
            );
        }
    }
}

async fn remove_stale_file(path: &Path, reason: &'static str) {
    match tokio::fs::remove_file(path).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            tracing::info!(path = %path.display(), reason, error = %e, "cannot remove stale live runner instance file");
        }
    }
}

fn stable_record_identity_from_file_name(name: &OsStr) -> Option<FileProcessIdentity> {
    stable_record_identity_from_str(name.to_str()?)
}

fn stable_record_identity_from_str(name: &str) -> Option<FileProcessIdentity> {
    let stem = name.strip_suffix(".json")?;
    let (pid, starttime) = stem.split_once('-')?;
    Some(FileProcessIdentity {
        pid: pid.parse().ok()?,
        starttime: starttime.parse().ok()?,
    })
}

fn atomic_tmp_record_identity_from_file_name(name: &OsStr) -> Option<FileProcessIdentity> {
    let name = name.to_str()?;
    let tmp_body = name.strip_prefix('.')?.strip_suffix(".tmp")?;
    let (stable_name, _tmp_id) = tmp_body.rsplit_once('.')?;
    stable_record_identity_from_str(stable_name)
}

async fn record_is_live(
    record: &LiveRunnerInstanceRecord,
    liveness: &LivenessContext,
) -> HostResult<bool> {
    process_identity_is_live(
        ProcessIdentity {
            boot_id: record.boot_id.clone(),
            pid: record.pid,
            starttime: record.starttime,
            euid: record.euid,
        },
        liveness,
    )
    .await
}

async fn file_process_identity_is_live(
    identity: FileProcessIdentity,
    liveness: &LivenessContext,
) -> HostResult<bool> {
    let boot_id = liveness.boot_id().await?;
    let identity = ProcessIdentity {
        boot_id: boot_id.to_owned(),
        pid: identity.pid,
        starttime: identity.starttime,
        euid: liveness.euid,
    };
    process_identity_is_live_for_boot(&identity, boot_id, liveness.euid, &liveness.proc_root).await
}

async fn process_identity_is_live(
    identity: ProcessIdentity,
    liveness: &LivenessContext,
) -> HostResult<bool> {
    let boot_id = liveness.boot_id().await?;
    process_identity_is_live_for_boot(&identity, boot_id, liveness.euid, &liveness.proc_root).await
}

async fn process_identity_is_live_for_boot(
    identity: &ProcessIdentity,
    boot_id: &str,
    euid: u32,
    proc_root: &Path,
) -> HostResult<bool> {
    if identity.boot_id != boot_id {
        return Ok(false);
    }
    if identity.euid != euid {
        return Ok(false);
    }
    let before = match process::read_process_stat_checked_from(proc_root, identity.pid).await {
        process::ProcessStatRead::Found(stat) => stat,
        process::ProcessStatRead::Missing => return Ok(false),
        process::ProcessStatRead::Unreadable(error) => {
            return Err(HostError::Internal(format!(
                "read initial process stat for live runner pid {}: {error}",
                identity.pid
            )));
        }
        process::ProcessStatRead::Invalid => {
            return Err(HostError::Internal(format!(
                "parse initial process stat for live runner pid {}",
                identity.pid
            )));
        }
    };
    if !process::process_stat_is_live(&before) || before.starttime != identity.starttime {
        return Ok(false);
    }
    let Some(euid) = read_process_euid(proc_root, identity.pid).await? else {
        return Ok(false);
    };
    if euid != identity.euid {
        return Ok(false);
    }
    let after = match process::read_process_stat_checked_from(proc_root, identity.pid).await {
        process::ProcessStatRead::Found(stat) => stat,
        process::ProcessStatRead::Missing => return Ok(false),
        process::ProcessStatRead::Unreadable(error) => {
            return Err(HostError::Internal(format!(
                "read final process stat for live runner pid {}: {error}",
                identity.pid
            )));
        }
        process::ProcessStatRead::Invalid => {
            return Err(HostError::Internal(format!(
                "parse final process stat for live runner pid {}",
                identity.pid
            )));
        }
    };
    Ok(process::process_stat_is_live(&after) && after.starttime == identity.starttime)
}

async fn current_process_identity() -> HostResult<ProcessIdentity> {
    let pid = std::process::id();
    let stat = process::read_process_stat(pid)
        .await
        .ok_or_else(|| HostError::Internal(format!("read current process stat for pid {pid}")))?;
    if !process::process_stat_is_live(&stat) {
        return Err(HostError::Internal(format!(
            "current process pid {pid} is not live"
        )));
    }
    Ok(ProcessIdentity {
        boot_id: current_boot_id().await?,
        pid,
        starttime: stat.starttime,
        euid: current_euid(),
    })
}

async fn current_boot_id() -> HostResult<String> {
    read_boot_id(Path::new("/proc")).await
}

async fn read_boot_id(proc_root: &Path) -> HostResult<String> {
    let path = proc_root.join("sys/kernel/random/boot_id");
    let content = tokio::fs::read_to_string(path)
        .await
        .map_err(|e| HostError::Internal(format!("read boot id: {e}")))?;
    let boot_id = content.trim();
    if boot_id.is_empty() || !boot_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(HostError::Internal("read boot id: invalid format".into()));
    }
    Ok(boot_id.to_owned())
}

async fn read_process_euid(proc_root: &Path, pid: u32) -> HostResult<Option<u32>> {
    let path = proc_root.join(pid.to_string()).join("status");
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(HostError::Internal(format!(
                "read process status for live runner pid {pid}: {error}"
            )));
        }
    };
    let euid = content
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .and_then(|value| value.split_whitespace().nth(1))
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| {
            HostError::Internal(format!(
                "parse process status effective uid for live runner pid {pid}"
            ))
        })?;
    Ok(Some(euid))
}

#[cfg(unix)]
fn current_euid() -> u32 {
    nix::unistd::geteuid().as_raw()
}

#[cfg(not(unix))]
fn current_euid() -> u32 {
    0
}

#[cfg(test)]
mod tests;
