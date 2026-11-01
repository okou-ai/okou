use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::time::Instant;
use tracing::{info, warn};

use super::types::{ActiveInputEntry, JobRequest, JobResponse};
use runner_types::ids::RunId;

#[derive(Clone)]
pub struct LocalDiscoveredJob {
    pub run_id: RunId,
    pub profile_name: String,
    pub job_path: PathBuf,
    pub reuse_key: Option<String>,
}

#[derive(serde::Deserialize)]
struct LocalDiscoveryMetadata {
    #[serde(default)]
    reuse_key: Option<String>,
}

pub enum LocalClaimResult {
    Claimed { request: Box<JobRequest> },
    NotClaimed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CancelTargetState {
    Pending,
    NotPending,
    Unknown,
}

pub struct LocalCancelMarker {
    pub run_id: RunId,
    pub target_state: CancelTargetState,
}

/// Shared file-state checks for the local queue protocol.
///
/// Clones share transient retry deadlines when an invalid job's failure result
/// cannot be published. These deadlines are local to this queue instance and
/// reset on restart; the persisted job, claim, and result protocol is unchanged.
#[derive(Clone)]
pub struct LocalQueue {
    group_dir: Arc<PathBuf>,
    failed_claim_retries: Arc<Mutex<HashMap<RunId, Instant>>>,
}

const DISCOVERY_SNAPSHOT_CANDIDATE_THRESHOLD: usize = 32;
const FAILED_CLAIM_RETRY_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct DiscoveryCandidate {
    run_id: RunId,
    path: PathBuf,
}

impl PartialEq for DiscoveryCandidate {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path
    }
}

impl Eq for DiscoveryCandidate {}

impl PartialOrd for DiscoveryCandidate {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for DiscoveryCandidate {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.path.cmp(&other.path)
    }
}

struct DiscoveryStateSnapshot {
    occupied_claims: HashSet<RunId>,
    completed_results: HashSet<RunId>,
}

enum DiscoveryResultState {
    Terminal,
    Retryable,
    Unknown,
}

enum CancelTargetLookup {
    Resolved(CancelTargetState),
    NeedsJobFile,
}

enum JobFileScan {
    Complete(Vec<PathBuf>),
    ScanFailed(Vec<PathBuf>),
}

struct JobProfileDirScan {
    paths: Vec<PathBuf>,
    complete: bool,
}

struct JobPresenceScan {
    found: HashSet<RunId>,
    complete: bool,
}

impl JobPresenceScan {
    fn target_state(&self, run_id: RunId) -> CancelTargetState {
        if self.found.contains(&run_id) {
            CancelTargetState::Pending
        } else if self.complete {
            CancelTargetState::NotPending
        } else {
            CancelTargetState::Unknown
        }
    }
}

impl LocalQueue {
    pub fn new(group_dir: PathBuf) -> Self {
        Self {
            group_dir: Arc::new(group_dir),
            failed_claim_retries: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn group_dir(&self) -> &Path {
        self.group_dir.as_ref()
    }

    fn lock_claim_retries(&self) -> MutexGuard<'_, HashMap<RunId, Instant>> {
        self.failed_claim_retries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn deferred_claims(&self) -> HashSet<RunId> {
        let now = Instant::now();
        let mut retries = self.lock_claim_retries();
        retries.retain(|_, deadline| *deadline > now);
        retries.keys().copied().collect()
    }

    fn claim_retry_is_pending(&self, run_id: RunId) -> bool {
        let mut retries = self.lock_claim_retries();
        if retries
            .get(&run_id)
            .is_some_and(|deadline| *deadline > Instant::now())
        {
            return true;
        }
        retries.remove(&run_id);
        false
    }

    pub fn discover_candidate_sync(
        &self,
        supported_profiles: &[String],
        start: usize,
    ) -> Option<LocalDiscoveredJob> {
        if supported_profiles.is_empty() {
            return None;
        }

        let deferred_claims = self.deferred_claims();
        let profile_count = supported_profiles.len();
        for offset in 0..profile_count {
            let Some(profile) = supported_profiles.get(start.wrapping_add(offset) % profile_count)
            else {
                continue;
            };
            let profile_dir = match super::profile_jobs_dir(&self.group_dir, profile) {
                Ok(dir) => dir,
                Err(e) => {
                    warn!(profile, error = %e, "local: invalid supported profile");
                    continue;
                }
            };
            let entries = match std::fs::read_dir(&profile_dir) {
                Ok(e) => e,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    warn!(path = %profile_dir.display(), error = %e, "local: cannot read profile job dir");
                    continue;
                }
            };

            let mut candidates = Vec::new();
            for entry in entries.filter_map(Result::ok) {
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if !file_type.is_file() {
                    continue;
                }
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("job") {
                    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                        continue;
                    };
                    let Ok(run_id) = stem.parse::<RunId>() else {
                        continue;
                    };
                    if deferred_claims.contains(&run_id) {
                        continue;
                    }
                    candidates.push(Reverse(DiscoveryCandidate { run_id, path }));
                }
            }

            let snapshot = if candidates.len() >= DISCOVERY_SNAPSHOT_CANDIDATE_THRESHOLD {
                self.discovery_state_snapshot(&candidates)
            } else {
                None
            };
            let mut candidates = BinaryHeap::from(candidates);
            while let Some(Reverse(candidate)) = candidates.pop() {
                if self.discovery_candidate_ineligible(&candidate, snapshot.as_ref()) {
                    continue;
                }
                let metadata = super::read_private_file_with_max(
                    &candidate.path,
                    "local job discovery metadata",
                    super::LOCAL_JOB_MAX_BYTES,
                )
                .ok()
                .and_then(|bytes| serde_json::from_slice::<LocalDiscoveryMetadata>(&bytes).ok());
                let reuse_key = metadata.and_then(|metadata| metadata.reuse_key);
                return Some(LocalDiscoveredJob {
                    run_id: candidate.run_id,
                    profile_name: profile.clone(),
                    job_path: candidate.path,
                    reuse_key,
                });
            }
        }
        None
    }

    fn discovery_candidate_ineligible(
        &self,
        candidate: &DiscoveryCandidate,
        snapshot: Option<&DiscoveryStateSnapshot>,
    ) -> bool {
        if let Some(snapshot) = snapshot {
            if snapshot.occupied_claims.contains(&candidate.run_id) {
                return true;
            }
            if snapshot.completed_results.contains(&candidate.run_id) {
                self.remove_completed_discovery_job(candidate);
                return true;
            }
            return false;
        }

        match self.claim_path_occupied(candidate.run_id) {
            Ok(true) => return true,
            Ok(false) => {}
            Err(e) => {
                warn!(run_id = %candidate.run_id, error = %e, "local: cannot stat claim path");
                return true;
            }
        }
        match self.result_file_state(candidate.run_id) {
            DiscoveryResultState::Terminal => {
                self.remove_completed_discovery_job(candidate);
                true
            }
            DiscoveryResultState::Retryable | DiscoveryResultState::Unknown => false,
        }
    }

    fn remove_completed_discovery_job(&self, candidate: &DiscoveryCandidate) {
        match std::fs::remove_file(&candidate.path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                warn!(
                    run_id = %candidate.run_id,
                    path = %candidate.path.display(),
                    error = %e,
                    "local: failed to remove completed discovery job"
                );
            }
        }
    }

    fn discovery_state_snapshot(
        &self,
        candidates: &[Reverse<DiscoveryCandidate>],
    ) -> Option<DiscoveryStateSnapshot> {
        let candidate_run_ids: HashSet<RunId> = candidates
            .iter()
            .map(|Reverse(candidate)| candidate.run_id)
            .collect();
        let occupied_claims = match self.snapshot_occupied_claims(&candidate_run_ids) {
            Ok(occupied) => occupied,
            Err(e) => {
                warn!(error = %e, "local: failed to snapshot discovery claims");
                return None;
            }
        };
        let completed_results = match self.snapshot_completed_results(&candidate_run_ids) {
            Ok(completed) => completed,
            Err(e) => {
                warn!(error = %e, "local: failed to snapshot discovery results");
                return None;
            }
        };
        Some(DiscoveryStateSnapshot {
            occupied_claims,
            completed_results,
        })
    }

    fn snapshot_occupied_claims(
        &self,
        candidate_run_ids: &HashSet<RunId>,
    ) -> std::io::Result<HashSet<RunId>> {
        let claims_dir = super::claims_dir(&self.group_dir);
        let Some(entries) = read_optional_validated_dir(
            &claims_dir,
            || super::validate_claims_dir(&self.group_dir),
            "local queue claims directory",
        )?
        else {
            return Ok(HashSet::new());
        };

        let mut occupied = HashSet::new();
        for entry in entries {
            let entry = entry.map_err(|e| {
                std::io::Error::new(
                    e.kind(),
                    format!(
                        "read local queue claims directory entry {}: {e}",
                        claims_dir.display()
                    ),
                )
            })?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("claim") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Ok(run_id) = stem.parse::<RunId>() else {
                continue;
            };
            if candidate_run_ids.contains(&run_id) {
                occupied.insert(run_id);
            }
        }
        Ok(occupied)
    }

    fn snapshot_completed_results(
        &self,
        candidate_run_ids: &HashSet<RunId>,
    ) -> std::io::Result<HashSet<RunId>> {
        let results_dir = super::results_dir(&self.group_dir);
        let Some(entries) = read_optional_validated_dir(
            &results_dir,
            || super::validate_results_dir(&self.group_dir),
            "local queue results directory",
        )?
        else {
            return Ok(HashSet::new());
        };

        let mut completed = HashSet::new();
        for entry in entries {
            let entry = entry.map_err(|e| {
                std::io::Error::new(
                    e.kind(),
                    format!(
                        "read local queue results directory entry {}: {e}",
                        results_dir.display()
                    ),
                )
            })?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("result") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Ok(run_id) = stem.parse::<RunId>() else {
                continue;
            };
            if !candidate_run_ids.contains(&run_id) {
                continue;
            }
            match self.result_file_state(run_id) {
                DiscoveryResultState::Terminal => {
                    completed.insert(run_id);
                }
                DiscoveryResultState::Retryable => {}
                DiscoveryResultState::Unknown => {
                    return Err(std::io::Error::other(format!(
                        "unknown local result file state for {run_id}"
                    )));
                }
            }
        }
        Ok(completed)
    }

    pub fn claim_job_sync(
        &self,
        run_id: RunId,
        partition_profile: &str,
        job_file: &Path,
    ) -> LocalClaimResult {
        if self.claim_retry_is_pending(run_id) {
            return LocalClaimResult::NotClaimed;
        }
        // Atomic claim via O_EXCL — only the first runner to create the file wins.
        if let Err(e) = super::ensure_claims_dir(&self.group_dir) {
            warn!(path = %super::claims_dir(&self.group_dir).display(), error = %e, "local: failed to create claim dir");
            return LocalClaimResult::NotClaimed;
        }
        let claim_file = super::claim_path(&self.group_dir, run_id);
        if super::create_private_marker(&claim_file, "local claim marker").is_err() {
            return LocalClaimResult::NotClaimed;
        }
        // Another queue clone may have recorded backoff and released its claim
        // after our first check but before this acquisition.
        if self.claim_retry_is_pending(run_id) {
            let _ = std::fs::remove_file(&claim_file);
            return LocalClaimResult::NotClaimed;
        }
        if self.result_file_has_content(run_id) {
            info!(run_id = %run_id, "local: job already has result, skipping claim");
            let _ = std::fs::remove_file(&claim_file);
            return LocalClaimResult::NotClaimed;
        }

        let buf = match super::read_private_file_with_max(
            job_file,
            "local job file",
            super::LOCAL_JOB_MAX_BYTES,
        ) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                warn!(run_id = %run_id, error = %e, "local: failed to read job file");
                let _ = std::fs::remove_file(&claim_file);
                return LocalClaimResult::NotClaimed;
            }
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: unreadable job file, marking job as failed");
                self.fail_claimed_job_sync_with_claim(
                    run_id,
                    &claim_file,
                    format!("failed to read job file: {e}"),
                );
                return LocalClaimResult::NotClaimed;
            }
        };
        let request: JobRequest = match serde_json::from_slice(&buf) {
            Ok(r) => r,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: invalid job JSON, marking job as failed");
                // Submit writes .job atomically (tmp + rename), so a malformed
                // .job is a permanent error — retrying the parse will just
                // spin. Keep the claim until after the result attempt so other
                // local runners do not repeatedly process the same poison job.
                // If the result write fails, record backoff before releasing
                // the claim so sequential admission cannot immediately retry.
                // On success, the result becomes the durable terminal marker
                // before the bad job is removed.
                self.fail_claimed_job_sync_with_claim(
                    run_id,
                    &claim_file,
                    format!("invalid job JSON: {e}"),
                );
                return LocalClaimResult::NotClaimed;
            }
        };

        if request.job_id != run_id {
            let error = format!(
                "job id mismatch: request={}, filename={run_id}",
                request.job_id
            );
            warn!(run_id = %run_id, error = %error, "local: invalid job id");
            self.fail_claimed_job_sync_with_claim(run_id, &claim_file, error);
            return LocalClaimResult::NotClaimed;
        }

        let request_profile = match request.profile.as_deref() {
            Some(profile) => profile,
            None if partition_profile == crate::profile::DEFAULT_PROFILE => {
                crate::profile::DEFAULT_PROFILE
            }
            None => {
                let error =
                    format!("missing job profile in non-default partition: {partition_profile}");
                warn!(run_id = %run_id, error = %error, "local: invalid job profile");
                self.fail_claimed_job_sync_with_claim(run_id, &claim_file, error);
                return LocalClaimResult::NotClaimed;
            }
        };
        if request_profile != partition_profile {
            let error = format!(
                "job profile mismatch: request={request_profile}, partition={partition_profile}"
            );
            warn!(run_id = %run_id, error = %error, "local: invalid job profile");
            self.fail_claimed_job_sync_with_claim(run_id, &claim_file, error);
            return LocalClaimResult::NotClaimed;
        }

        LocalClaimResult::Claimed {
            request: Box::new(request),
        }
    }

    pub fn fail_claimed_job_sync(&self, run_id: RunId, error: String) {
        let claim_file = super::claim_path(&self.group_dir, run_id);
        self.fail_claimed_job_sync_with_claim(run_id, &claim_file, error);
    }

    pub fn complete_job_sync(&self, run_id: RunId, exit_code: i32, error: Option<String>) {
        let result_written = self.write_result_sync(run_id, exit_code, error.as_deref());
        let jobs_removed = self.remove_job_files_if_present(run_id);
        // A published result is terminal even if job removal fails. Without
        // that result, retain state until every job is known to be removed.
        if !result_written && !jobs_removed {
            return;
        }
        // Best-effort cleanup of cancel file (may have been written after the
        // last discover() scan but before the job actually finished).
        let _ = std::fs::remove_file(super::cancel_path(&self.group_dir, run_id));
        let _ = std::fs::remove_file(super::claim_path(&self.group_dir, run_id));
        self.cleanup_active_inputs_sync(run_id);
    }

    /// Read the retained request for a run without assuming its profile partition.
    pub fn read_job_request_sync(&self, run_id: RunId) -> std::io::Result<JobRequest> {
        let paths = match self.collect_job_file_paths(run_id) {
            JobFileScan::Complete(paths) => paths,
            JobFileScan::ScanFailed(_) => {
                return Err(std::io::Error::other(format!(
                    "cannot scan local job requests for {run_id}"
                )));
            }
        };
        let path = match paths.as_slice() {
            [path] => path,
            [] => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("no local job request found for {run_id}"),
                ));
            }
            _ => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("multiple local job requests found for {run_id}"),
                ));
            }
        };
        let bytes =
            super::read_private_file_with_max(path, "local job file", super::LOCAL_JOB_MAX_BYTES)?;
        let request: JobRequest = serde_json::from_slice(&bytes).map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("invalid local job request for {run_id}: {e}"),
            )
        })?;
        if request.job_id != run_id {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "job id mismatch: request={}, filename={run_id}",
                    request.job_id
                ),
            ));
        }
        Ok(request)
    }

    pub fn write_active_input_sync(&self, entry: &ActiveInputEntry) -> std::io::Result<()> {
        if entry.sequence == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "local active input sequence must be greater than zero",
            ));
        }
        if entry.text.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "local active input text must not be empty",
            ));
        }
        let _guard = super::fs::lock_active_inputs(&self.group_dir)?;
        // Terminal owners publish a result or remove the retained job before
        // taking this same lock for cleanup. A preliminary CLI check cannot
        // replace this check: an independent publisher can outlive both owners.
        if super::private_file_has_content(
            &super::result_path(&self.group_dir, entry.run_id),
            "local result file",
        )? {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("local job {} has already completed", entry.run_id),
            ));
        }
        let paths = match self.collect_job_file_paths(entry.run_id) {
            JobFileScan::Complete(paths) => paths,
            JobFileScan::ScanFailed(_) => {
                return Err(std::io::Error::other(format!(
                    "cannot scan local job requests for {}",
                    entry.run_id
                )));
            }
        };
        let mut has_job = false;
        for path in paths {
            has_job |= super::marker_file_exists(&path, "local job file")?;
        }
        if !has_job {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("no local job request found for {}", entry.run_id),
            ));
        }
        let run_dir = super::ensure_run_inputs_dir(&self.group_dir, entry.run_id)?;
        let bytes = serde_json::to_vec(entry).map_err(std::io::Error::other)?;
        let tmp_path = run_dir.join(format!(
            "{:020}.{}.json.tmp",
            entry.sequence,
            RunId::new_v4()
        ));
        let final_path = super::active_input_path(&self.group_dir, entry.run_id, entry.sequence);
        let _temporary_cleanup = super::fs::TemporaryFileCleanup::new(&tmp_path);
        super::write_private_file(&tmp_path, &bytes, "local active-input temporary file")?;
        if let Err(e) = std::fs::hard_link(&tmp_path, &final_path) {
            return Err(std::io::Error::new(
                e.kind(),
                format!(
                    "publish local active-input file {}: {e}",
                    final_path.display()
                ),
            ));
        }
        Ok(())
    }

    /// Read only the expected canonical sequence; a gap never loads later inputs.
    pub fn read_active_input_entry_sync(
        &self,
        run_id: RunId,
        sequence: u64,
    ) -> Option<ActiveInputEntry> {
        if sequence == 0 {
            return None;
        }
        let run_dir = super::run_inputs_dir(&self.group_dir, run_id);
        match std::fs::symlink_metadata(&run_dir) {
            Ok(_) => {
                if let Err(e) = super::validate_run_inputs_dir(&self.group_dir, run_id) {
                    warn!(run_id = %run_id, path = %run_dir.display(), error = %e, "local: invalid active-input directory");
                    return None;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(e) => {
                warn!(run_id = %run_id, path = %run_dir.display(), error = %e, "local: cannot stat active-input directory");
                return None;
            }
        }

        let path = super::active_input_path(&self.group_dir, run_id, sequence);
        let bytes = super::read_private_file_with_max(
            &path,
            "local active-input file",
            super::LOCAL_ACTIVE_INPUT_MAX_BYTES,
        )
        .ok()?;
        let input = serde_json::from_slice::<ActiveInputEntry>(&bytes).ok()?;
        if input.run_id != run_id || input.sequence != sequence || input.text.is_empty() {
            return None;
        }
        Some(input)
    }

    pub fn cleanup_active_inputs_sync(&self, run_id: RunId) {
        let _guard = match super::fs::lock_active_inputs(&self.group_dir) {
            Ok(guard) => guard,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: failed to lock active-input cleanup");
                return;
            }
        };
        let run_dir = super::run_inputs_dir(&self.group_dir, run_id);
        match std::fs::symlink_metadata(&run_dir) {
            Ok(metadata) if metadata.file_type().is_dir() => {
                if let Err(e) = super::validate_run_inputs_dir(&self.group_dir, run_id) {
                    warn!(run_id = %run_id, path = %run_dir.display(), error = %e, "local: invalid active-input directory during cleanup");
                    return;
                }
                if let Err(e) = std::fs::remove_dir_all(&run_dir)
                    && e.kind() != std::io::ErrorKind::NotFound
                {
                    warn!(run_id = %run_id, path = %run_dir.display(), error = %e, "local: failed to clean active-input directory");
                }
            }
            Ok(metadata) if metadata.file_type().is_file() => {
                if let Err(e) = super::validate_inputs_dir(&self.group_dir) {
                    warn!(run_id = %run_id, path = %run_dir.display(), error = %e, "local: invalid active-input parent directory during cleanup");
                    return;
                }
                if let Err(e) = std::fs::remove_file(&run_dir)
                    && e.kind() != std::io::ErrorKind::NotFound
                {
                    warn!(run_id = %run_id, path = %run_dir.display(), error = %e, "local: failed to clean active-input file");
                }
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                warn!(run_id = %run_id, path = %run_dir.display(), error = %e, "local: cannot stat active-input directory for cleanup");
            }
        }
    }

    pub fn collect_cancel_markers_sync(&self) -> Vec<LocalCancelMarker> {
        let cancel_dir = super::cancels_dir(&self.group_dir);
        if let Err(e) = validate_optional_cancel_dir(&self.group_dir, &cancel_dir) {
            warn!(path = %cancel_dir.display(), error = %e, "local: invalid cancel dir");
            return Vec::new();
        }
        let entries = match std::fs::read_dir(&cancel_dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(e) => {
                warn!(path = %cancel_dir.display(), error = %e, "local: cannot read cancel dir");
                return Vec::new();
            }
        };
        let mut cancel_markers = Vec::new();
        let mut unresolved_run_ids = Vec::new();
        let mut seen = HashSet::new();
        for entry in entries.filter_map(Result::ok) {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("cancel") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Ok(run_id) = stem.parse::<RunId>() else {
                continue;
            };
            if seen.insert(run_id) {
                match self.cancel_target_state_before_job_lookup(run_id) {
                    CancelTargetLookup::Resolved(target_state) => {
                        cancel_markers.push(LocalCancelMarker {
                            run_id,
                            target_state,
                        });
                    }
                    CancelTargetLookup::NeedsJobFile => {
                        unresolved_run_ids.push(run_id);
                        cancel_markers.push(LocalCancelMarker {
                            run_id,
                            target_state: CancelTargetState::Unknown,
                        });
                    }
                }
            }
        }
        if !unresolved_run_ids.is_empty() {
            let job_presence = self.lookup_job_files_for_cancel_targets(&unresolved_run_ids);
            let unresolved: HashSet<RunId> = unresolved_run_ids.into_iter().collect();
            for marker in &mut cancel_markers {
                if unresolved.contains(&marker.run_id) {
                    marker.target_state = job_presence.target_state(marker.run_id);
                }
            }
        }
        cancel_markers
    }

    pub fn remove_cancel_files_sync(&self, run_ids: Vec<RunId>) {
        for run_id in run_ids {
            let _ = std::fs::remove_file(super::cancel_path(&self.group_dir, run_id));
        }
    }

    fn cancel_target_state_before_job_lookup(&self, run_id: RunId) -> CancelTargetLookup {
        if self.result_file_has_content(run_id) {
            return CancelTargetLookup::Resolved(CancelTargetState::NotPending);
        }
        match self.claim_marker_exists(run_id) {
            Ok(true) => return CancelTargetLookup::Resolved(CancelTargetState::Pending),
            Ok(false) => {}
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: cannot stat claim marker");
                return CancelTargetLookup::Resolved(CancelTargetState::Unknown);
            }
        }
        CancelTargetLookup::NeedsJobFile
    }

    fn claim_marker_exists(&self, run_id: RunId) -> std::io::Result<bool> {
        super::marker_file_exists(
            &super::claim_path(&self.group_dir, run_id),
            "local claim marker",
        )
    }

    fn claim_path_occupied(&self, run_id: RunId) -> std::io::Result<bool> {
        super::marker_path_occupied(
            &super::claim_path(&self.group_dir, run_id),
            "local claim marker",
        )
    }

    pub fn result_file_has_content(&self, run_id: RunId) -> bool {
        matches!(
            self.result_file_state(run_id),
            DiscoveryResultState::Terminal
        )
    }

    fn result_file_state(&self, run_id: RunId) -> DiscoveryResultState {
        let result_path = super::result_path(&self.group_dir, run_id);
        match std::fs::symlink_metadata(&result_path) {
            Ok(metadata) if metadata.file_type().is_file() => {
                match super::private_file_has_content(&result_path, "local result file") {
                    Ok(true) => DiscoveryResultState::Terminal,
                    Ok(false) => DiscoveryResultState::Retryable,
                    Err(_) => DiscoveryResultState::Unknown,
                }
            }
            Ok(_) => DiscoveryResultState::Retryable,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => DiscoveryResultState::Retryable,
            Err(_) => DiscoveryResultState::Unknown,
        }
    }

    pub fn remove_job_files_if_present(&self, run_id: RunId) -> bool {
        let (paths, mut removed_all) = match self.collect_job_file_paths(run_id) {
            JobFileScan::Complete(paths) => (paths, true),
            JobFileScan::ScanFailed(paths) => (paths, false),
        };

        for path in paths {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    warn!(run_id = %run_id, path = %path.display(), error = %e, "local: failed to remove job file after terminal result");
                    removed_all = false;
                }
            };
        }

        removed_all
    }

    pub fn write_result_sync(&self, run_id: RunId, exit_code: i32, error: Option<&str>) -> bool {
        let response = JobResponse {
            run_id,
            exit_code,
            error: error.map(String::from),
        };
        let json = match serde_json::to_vec(&response) {
            Ok(j) => j,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: failed to serialize result");
                return false;
            }
        };

        let result_dir = match super::ensure_results_dir(&self.group_dir) {
            Ok(dir) => dir,
            Err(e) => {
                warn!(path = %super::results_dir(&self.group_dir).display(), error = %e, "local: failed to create result dir");
                return false;
            }
        };

        // Atomic write: tmp then rename, so submit never reads a partial file.
        let tmp_file = result_dir.join(format!("{run_id}.{}.result.tmp", RunId::new_v4()));
        let result_file = super::result_path(&self.group_dir, run_id);
        let temporary_cleanup = super::fs::TemporaryFileCleanup::new(&tmp_file);
        if let Err(e) = super::write_private_file(&tmp_file, &json, "local result temporary file") {
            warn!(run_id = %run_id, error = %e, "local: failed to write result file");
            return false;
        }
        if let Err(e) = std::fs::rename(&tmp_file, &result_file) {
            warn!(run_id = %run_id, error = %e, "local: failed to rename result file");
            return false;
        }
        temporary_cleanup.disarm();
        true
    }

    fn fail_claimed_job_sync_with_claim(&self, run_id: RunId, claim_file: &Path, error: String) {
        if self.write_result_sync(run_id, 1, Some(&error)) {
            self.lock_claim_retries().remove(&run_id);
            let _ = self.remove_job_files_if_present(run_id);
            self.cleanup_active_inputs_sync(run_id);
        } else {
            // Publish retry state before releasing ownership. Discovery skips
            // this run, but can still return other jobs in the same partition.
            let now = Instant::now();
            let mut retries = self.lock_claim_retries();
            retries.retain(|_, deadline| *deadline > now);
            retries.insert(run_id, now + FAILED_CLAIM_RETRY_INTERVAL);
        }
        let _ = std::fs::remove_file(claim_file);
    }

    fn lookup_job_files_for_cancel_targets(&self, run_ids: &[RunId]) -> JobPresenceScan {
        let profile_dirs = self.collect_job_profile_dirs();
        lookup_job_files_in_profile_dirs(run_ids, &profile_dirs.paths, profile_dirs.complete)
    }

    fn collect_job_profile_dirs(&self) -> JobProfileDirScan {
        let jobs_dir = super::jobs_dir(&self.group_dir);
        let mut paths = Vec::new();
        let orgs = match std::fs::read_dir(&jobs_dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return JobProfileDirScan {
                    paths,
                    complete: true,
                };
            }
            Err(e) => {
                warn!(path = %jobs_dir.display(), error = %e, "local: cannot scan jobs dir for job profile dirs");
                return JobProfileDirScan {
                    paths,
                    complete: false,
                };
            }
        };

        for org in orgs {
            let org = match org {
                Ok(entry) => entry,
                Err(e) => {
                    warn!(path = %jobs_dir.display(), error = %e, "local: cannot scan jobs dir entry for job profile dirs");
                    return JobProfileDirScan {
                        paths,
                        complete: false,
                    };
                }
            };
            let org_file_type = match org.file_type() {
                Ok(file_type) => file_type,
                Err(e) => {
                    warn!(path = %org.path().display(), error = %e, "local: cannot stat profile org dir entry for job profile dirs");
                    return JobProfileDirScan {
                        paths,
                        complete: false,
                    };
                }
            };
            if !org_file_type.is_dir() {
                continue;
            }
            let org_path = org.path();
            let profiles = match std::fs::read_dir(&org_path) {
                Ok(entries) => entries,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    warn!(path = %org_path.display(), error = %e, "local: cannot scan profile org dir for job profile dirs");
                    return JobProfileDirScan {
                        paths,
                        complete: false,
                    };
                }
            };
            for profile in profiles {
                let profile = match profile {
                    Ok(entry) => entry,
                    Err(e) => {
                        warn!(path = %org_path.display(), error = %e, "local: cannot scan profile dir entry for job profile dirs");
                        return JobProfileDirScan {
                            paths,
                            complete: false,
                        };
                    }
                };
                let profile_file_type = match profile.file_type() {
                    Ok(file_type) => file_type,
                    Err(e) => {
                        warn!(path = %profile.path().display(), error = %e, "local: cannot stat profile dir entry for job profile dirs");
                        return JobProfileDirScan {
                            paths,
                            complete: false,
                        };
                    }
                };
                if profile_file_type.is_dir() {
                    paths.push(profile.path());
                }
            }
        }

        JobProfileDirScan {
            paths,
            complete: true,
        }
    }

    fn collect_job_file_paths(&self, run_id: RunId) -> JobFileScan {
        let profile_dirs = self.collect_job_profile_dirs();
        let mut paths = Vec::new();

        for profile_dir in profile_dirs.paths {
            let path = profile_dir.join(format!("{run_id}.job"));
            match std::fs::symlink_metadata(&path) {
                Ok(_) => {
                    paths.push(path);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    warn!(run_id = %run_id, path = %path.display(), error = %e, "local: cannot stat job file");
                    return JobFileScan::ScanFailed(paths);
                }
            }
        }

        if profile_dirs.complete {
            JobFileScan::Complete(paths)
        } else {
            JobFileScan::ScanFailed(paths)
        }
    }
}

fn lookup_job_files_in_profile_dirs(
    run_ids: &[RunId],
    profile_dirs: &[PathBuf],
    profile_dir_scan_complete: bool,
) -> JobPresenceScan {
    let mut found = HashSet::new();
    let mut remaining: HashSet<RunId> = run_ids.iter().copied().collect();
    let mut complete = profile_dir_scan_complete;

    for profile_dir in profile_dirs {
        if remaining.is_empty() {
            break;
        }
        let targets: Vec<RunId> = remaining.iter().copied().collect();
        for run_id in targets {
            let path = profile_dir.join(format!("{run_id}.job"));
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_file() => {
                    found.insert(run_id);
                    remaining.remove(&run_id);
                }
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    complete = false;
                    warn!(run_id = %run_id, path = %path.display(), error = %e, "local: cannot stat cancel target job file");
                }
            }
        }
    }

    JobPresenceScan { found, complete }
}

fn read_optional_validated_dir<F>(
    dir: &Path,
    validate: F,
    context: &str,
) -> std::io::Result<Option<std::fs::ReadDir>>
where
    F: FnOnce() -> std::io::Result<PathBuf>,
{
    match std::fs::symlink_metadata(dir) {
        Ok(_) => {
            validate()?;
            match std::fs::read_dir(dir) {
                Ok(entries) => Ok(Some(entries)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(std::io::Error::new(
                    e.kind(),
                    format!("read {context} {}: {e}", dir.display()),
                )),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(std::io::Error::new(
            e.kind(),
            format!("stat {context} {}: {e}", dir.display()),
        )),
    }
}

fn validate_optional_cancel_dir(group_dir: &Path, cancel_dir: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(cancel_dir) {
        Ok(_) => super::validate_cancels_dir(group_dir).map(|_| ()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(std::io::Error::new(
            e.kind(),
            format!(
                "stat local queue cancels directory {}: {e}",
                cancel_dir.display()
            ),
        )),
    }
}

#[cfg(test)]
mod tests;
