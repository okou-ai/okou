//! [`JobProvider`] backed by a file queue in a shared group directory.
//!
//! `submit` writes a `{job_id}.job` file under the requested profile
//! partition. Runners watch only the profile partitions they support and race
//! to claim discovered jobs via group-wide `{job_id}.claim` files (O_EXCL).
//! The winning runner executes the job and writes a group-wide
//! `{job_id}.result` file that `submit` polls for.

mod cancel;
mod watch;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use super::{ClaimedJob, CompletionAuth, CompletionReportTiming, JobCandidate, JobProvider};
use crate::local_queue::{LocalClaimResult, LocalDiscoveredJob, LocalQueue};
use crate::run_cancellation::RunCancellationRegistry;
use crate::types::{CompleteRequest, ExecutionContext, HeartbeatState};
use cancel::{LocalCancelScanner, LocalCancelWatcher};
use watch::{QueueFileKind, RECONCILE_INTERVAL, ensure_watcher, next_change_or_pending};

#[cfg(test)]
#[derive(Clone, Default)]
struct ScanObserver {
    inner: Arc<ScanObserverInner>,
}

#[cfg(test)]
#[derive(Default)]
struct ScanObserverInner {
    count: AtomicUsize,
    changed: tokio::sync::Notify,
}

#[cfg(test)]
impl ScanObserver {
    fn record(&self) {
        self.inner.count.fetch_add(1, Ordering::Relaxed);
        self.inner.changed.notify_one();
    }

    fn count(&self) -> usize {
        self.inner.count.load(Ordering::Relaxed)
    }

    async fn wait_for_count(&self, expected: usize) {
        loop {
            if self.count() >= expected {
                return;
            }
            self.inner.changed.notified().await;
        }
    }

    fn observe(&self) -> ScanObservation {
        ScanObservation(self.clone())
    }
}

#[cfg(test)]
struct ScanObservation(ScanObserver);

#[cfg(test)]
impl Drop for ScanObservation {
    fn drop(&mut self) {
        self.0.record();
    }
}

/// [`JobProvider`] backed by a file queue in a shared group directory.
///
/// - `discover()` watches and reconciles supported profile partitions under `jobs/`.
/// - `claim()` atomically creates `claims/{job_id}.claim` via `O_EXCL`.
/// - `complete()` writes `results/{job_id}.result`.
///
/// A provider-owned watcher reconciles `cancels/{run_id}.cancel` independently
/// from discovery so active-job cancellation remains live while discovery is
/// gated by capacity or drain mode. Claim performs one additional reconciliation
/// after ownership changes so a preexisting marker cannot be stranded.
pub struct LocalProvider {
    queue: LocalQueue,
    supported_profiles: Vec<String>,
    profile_cursor: AtomicUsize,
    cancel: CancellationToken,
    cancel_scanner: LocalCancelScanner,
    cancel_watcher: LocalCancelWatcher,
    #[cfg(test)]
    job_scan_observer: ScanObserver,
}

impl LocalProvider {
    /// Create a new file-queue provider for the given group directory.
    pub fn new(
        group_dir: PathBuf,
        supported_profiles: Vec<String>,
        cancel: CancellationToken,
        cancel_tokens: RunCancellationRegistry,
    ) -> Arc<Self> {
        Self::new_inner(group_dir, supported_profiles, cancel, cancel_tokens, true)
    }

    fn new_inner(
        group_dir: PathBuf,
        mut supported_profiles: Vec<String>,
        cancel: CancellationToken,
        cancel_tokens: RunCancellationRegistry,
        start_cancel_watcher: bool,
    ) -> Arc<Self> {
        supported_profiles.sort();
        supported_profiles.dedup();
        let queue = LocalQueue::new(group_dir);
        info!(
            path = %queue.group_dir().display(),
            profiles = ?supported_profiles,
            "local provider watching"
        );
        let owned_claims = Arc::new(tokio::sync::Mutex::new(HashSet::new()));
        let cancel_scanner = LocalCancelScanner::new(queue.clone(), cancel_tokens, owned_claims);
        let cancel_watcher = if start_cancel_watcher {
            LocalCancelWatcher::start(cancel_scanner.clone())
        } else {
            LocalCancelWatcher::disabled(cancel_scanner.clone())
        };
        Arc::new(Self {
            queue,
            supported_profiles,
            profile_cursor: AtomicUsize::new(0),
            cancel,
            cancel_scanner,
            cancel_watcher,
            #[cfg(test)]
            job_scan_observer: ScanObserver::default(),
        })
    }

    async fn find_unclaimed_job_blocking(&self) -> Option<JobCandidate> {
        #[cfg(test)]
        let _scan_observation = self.job_scan_observer.observe();
        let start = self.profile_cursor.fetch_add(1, Ordering::Relaxed);
        let queue = self.queue.clone();
        let supported_profiles = self.supported_profiles.clone();
        match tokio::task::spawn_blocking(move || {
            queue.discover_candidate_sync(&supported_profiles, start)
        })
        .await
        {
            Ok(discovered) => discovered.map(job_candidate_from_discovered),
            Err(e) => {
                warn!(error = %e, "local: blocking job discovery failed");
                None
            }
        }
    }

    fn job_watch_paths(&self) -> Vec<PathBuf> {
        self.supported_profiles
            .iter()
            .filter_map(|profile| match crate::local_queue::profile_jobs_dir(
                self.queue.group_dir(),
                profile,
            ) {
                Ok(path) => Some(path),
                Err(error) => {
                    warn!(profile, error = %error, "local: invalid supported profile watch path");
                    None
                }
            })
            .collect()
    }

    #[cfg(test)]
    async fn wait_for_job_scan_count(&self, expected: usize) {
        self.job_scan_observer.wait_for_count(expected).await;
    }

    #[cfg(test)]
    fn job_scan_count(&self) -> usize {
        self.job_scan_observer.count()
    }

    #[cfg(test)]
    async fn wait_for_cancel_scan_count(&self, expected: usize) {
        self.cancel_scanner.wait_for_scan_count(expected).await;
    }

    #[cfg(test)]
    fn cancel_scan_count(&self) -> usize {
        self.cancel_scanner.scan_count()
    }
}

fn job_candidate_from_discovered(discovered: LocalDiscoveredJob) -> JobCandidate {
    JobCandidate::local(
        discovered.run_id,
        discovered.profile_name,
        discovered.job_path,
    )
    .with_reuse_key(discovered.reuse_key)
}

#[async_trait::async_trait]
impl JobProvider for LocalProvider {
    async fn discover(&self) -> Option<JobCandidate> {
        let watch_paths = self.job_watch_paths();
        let mut watcher = None;
        loop {
            if self.cancel.is_cancelled() {
                return None;
            }
            if let Err(error) = ensure_watcher(&mut watcher, &watch_paths, QueueFileKind::Job) {
                warn!(error = %error, "local: job watcher unavailable, using reconciliation");
            }
            if let Some(candidate) = self.find_unclaimed_job_blocking().await {
                info!(
                    run_id = %candidate.run_id(),
                    profile = %candidate.profile_name(),
                    "local: job discovered"
                );
                return Some(candidate);
            }
            tokio::select! {
                () = self.cancel.cancelled() => return None,
                () = tokio::time::sleep(RECONCILE_INTERVAL) => {}
                result = next_change_or_pending(&mut watcher) => {
                    if let Err(error) = result {
                        warn!(error = %error, "local: job watcher failed, using reconciliation");
                        watcher = None;
                    }
                }
            }
        }
    }

    async fn claim(&self, candidate: JobCandidate) -> Option<ClaimedJob> {
        let run_id = candidate.run_id();
        let partition_profile = candidate.profile_name().to_owned();
        let Some(job_file) = candidate.local_job_path().map(std::path::Path::to_path_buf) else {
            warn!(run_id = %run_id, "local: claim candidate missing job path");
            return None;
        };

        let queue = self.queue.clone();
        let job_file_for_claim = job_file.clone();
        let claim_result = tokio::task::spawn_blocking(move || {
            queue.claim_job_sync(run_id, &partition_profile, &job_file_for_claim)
        })
        .await;
        let req = match claim_result {
            Ok(LocalClaimResult::Claimed { request }) => *request,
            Ok(LocalClaimResult::NotClaimed) => return None,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, "local: blocking claim failed");
                return None;
            }
        };

        let environment_merge = merge_local_environments(req.environment, req.secret_environment);
        let context = ExecutionContext {
            run_id,
            reuse_key: req.reuse_key,
            prompt: req.prompt,
            append_system_prompt: None,
            vars: req.vars,
            sandbox_token: String::new(),
            storage_manifest: None,
            environment: environment_merge.environment,
            platform_environment: HashMap::new(),
            resume_session: req
                .session_id
                .as_ref()
                .map(|id| crate::types::ResumeSession::inline(id.clone(), String::new())),
            secret_values: environment_merge.secret_values,
            local_secret_env_keys: environment_merge.local_secret_env_keys,
            encrypted_secrets: None,
            secret_connector_map: None,
            secret_connector_metadata_map: None,
            cli_agent_type: req.cli_agent_type,
            real_agent_in_preview: None,
            api_start_time: None,
            user_timezone: req.user_timezone,
            capture_network_bodies: None,
            firewalls: None,
            network_policies: None,
            network_policy_refreshes: None,
            connector_runtime_targets: Vec::new(),
            disallowed_tools: None,
            tools: None,
            settings: None,
            feature_flags: req.feature_flags,
            billable_firewalls: vec![],
            model_usage_provider: None,
            codex_runtime_config: None,
            pi_launch_config: None,
            pi_model_config: None,
            pi_session_id: None,
        };
        let active_input_source = req.active_input.unwrap_or(false).then(|| {
            crate::active_input::ActiveInputSource::local_queue(self.queue.clone(), run_id)
        });
        match ClaimedJob::local_with_active_input_source(run_id, context, active_input_source) {
            Ok(claimed) => {
                self.cancel_scanner.mark_owned_claim(run_id).await;
                self.cancel_scanner.scan_cancel_files().await;
                info!(run_id = %run_id, "local: job claimed");
                Some(claimed)
            }
            Err(err) => {
                let error = format!(
                    "claimed job run_id mismatch: expected={}, context={}",
                    err.expected_run_id, err.context_run_id
                );
                warn!(run_id = %run_id, error = %error, "local: claimed job invariant violation");
                let queue = self.queue.clone();
                if let Err(e) = tokio::task::spawn_blocking(move || {
                    queue.fail_claimed_job_sync(run_id, error);
                })
                .await
                {
                    warn!(run_id = %run_id, error = %e, "local: blocking claimed-job failure cleanup failed");
                }
                None
            }
        }
    }

    fn completion_report_timing(&self) -> CompletionReportTiming {
        // Writing the result unblocks `runner local submit`, whose next turn
        // may immediately depend on the finalized sandbox being reusable.
        CompletionReportTiming::AfterFinalization
    }

    async fn complete(&self, request: CompleteRequest, _completion_auth: CompletionAuth) {
        let CompleteRequest {
            run_id,
            exit_code,
            error,
            ..
        } = request;
        self.cancel_scanner.remove_owned_claim(run_id).await;
        let queue = self.queue.clone();
        if let Err(e) =
            tokio::task::spawn_blocking(move || queue.complete_job_sync(run_id, exit_code, error))
                .await
        {
            warn!(run_id = %run_id, error = %e, "local: blocking completion failed");
        }
    }

    async fn heartbeat(&self, _state: &HeartbeatState) {}

    async fn shutdown(&self) {
        self.cancel_watcher.shutdown().await;
    }
}

struct LocalEnvironmentMerge {
    environment: Option<HashMap<String, String>>,
    secret_values: Option<Vec<String>>,
    local_secret_env_keys: Option<HashSet<String>>,
}

fn merge_local_environments(
    environment: Option<HashMap<String, String>>,
    secret_environment: Option<HashMap<String, String>>,
) -> LocalEnvironmentMerge {
    let Some(secret_environment) = secret_environment else {
        return LocalEnvironmentMerge {
            environment,
            secret_values: None,
            local_secret_env_keys: None,
        };
    };
    if secret_environment.is_empty() {
        return LocalEnvironmentMerge {
            environment,
            secret_values: None,
            local_secret_env_keys: None,
        };
    }

    let mut merged = environment.unwrap_or_default();
    let mut secret_values = Vec::with_capacity(secret_environment.len());
    let mut local_secret_env_keys = HashSet::with_capacity(secret_environment.len());
    for (key, value) in secret_environment {
        local_secret_env_keys.insert(key.clone());
        secret_values.push(value.clone());
        merged.insert(key, value);
    }

    LocalEnvironmentMerge {
        environment: Some(merged),
        secret_values: Some(secret_values),
        local_secret_env_keys: Some(local_secret_env_keys),
    }
}

#[cfg(test)]
mod tests;
