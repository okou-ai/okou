//! `runner local submit` — submit a job to locally running runners via file queue.
//!
//! Writes a `{job_id}.job` file into a profile-specific partition and polls
//! for a group-wide `{job_id}.result` file written by the runner that claimed
//! the job.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use clap::Args;
use tokio::signal::unix::{Signal, SignalKind, signal};
use uuid::Uuid;

use crate::active_input::{
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES, identified_active_input_payload_len,
};
use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::local_queue::{self, JobRequest, JobResponse};
use crate::paths::HomePaths;

/// Poll interval for checking the result file.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Default wait budget for a submitted local job to complete.
const DEFAULT_LOCAL_SUBMIT_TIMEOUT_SECS: u64 = 300;

/// Local submit is an interactive wait, not a long-term scheduling primitive.
const MAX_LOCAL_SUBMIT_TIMEOUT_SECS: u64 = 24 * 60 * 60;

/// Grace period after Ctrl+C to wait for the runner to write a `.result` file.
const CANCEL_GRACE: Duration = Duration::from_secs(10);

#[derive(Args)]
pub struct SubmitArgs {
    /// Runner group name (writes job to the group's local queue)
    #[arg(long)]
    group: String,
    /// Job prompt
    #[arg(long)]
    prompt: String,
    /// Agent type
    #[arg(long, default_value = "claude-code")]
    cli_agent_type: String,
    /// Sandbox profile to use (e.g. "vm0/default")
    #[arg(long)]
    profile: Option<String>,
    /// Chat thread ID for sandbox and workspace reuse across turns
    #[arg(long)]
    chat_thread_id: Option<Uuid>,
    /// Provider-native session ID to resume
    #[arg(long)]
    session_id: Option<String>,
    /// Feature flags (repeatable, format: key=value, e.g. --feature-flag myFlag=true)
    #[arg(long = "feature-flag")]
    feature_flags: Vec<String>,
    /// Ordinary environment variables to pass to the local job (KEY=VALUE)
    #[arg(long = "env")]
    env: Vec<String>,
    /// Local-only secret environment variables to pass and register for masking (KEY=VALUE)
    #[arg(long = "secret-env")]
    secret_env: Vec<String>,
    /// Timeout in seconds waiting for a runner to complete the job (max: 24 hours)
    #[arg(long, default_value_t = DEFAULT_LOCAL_SUBMIT_TIMEOUT_SECS)]
    timeout: u64,
    /// Delayed active input for local smoke tests (repeatable, format: after=1s,text=hello)
    #[arg(long = "active-input")]
    active_inputs: Vec<String>,
}

/// Detect the system timezone from the `TZ` env var or a timezone file.
fn detect_system_timezone(timezone_file: &Path) -> Option<String> {
    if let Ok(tz) = std::env::var("TZ")
        && !tz.is_empty()
    {
        return Some(tz);
    }
    std::fs::read_to_string(timezone_file)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Try to read a non-empty result file.  Returns `None` if the file does
/// not exist, is empty, or cannot be read.
fn try_read_result(result_path: &std::path::Path) -> Option<Vec<u8>> {
    match local_queue::read_private_file(result_path, "local result file") {
        Ok(b) if !b.is_empty() => Some(b),
        _ => None,
    }
}

fn remove_file_if_exists(path: &std::path::Path) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

struct PublishedMarker {
    bytes: Vec<u8>,
    dev: u64,
    ino: u64,
}

#[derive(Clone)]
struct SubmitQueueEntry {
    job_id: RunId,
    group_dir: PathBuf,
    job_dir: PathBuf,
    job: PathBuf,
    result: PathBuf,
    cancel: PathBuf,
    claim: PathBuf,
}

impl SubmitQueueEntry {
    fn for_job(group_dir: &Path, profile: &str, job_id: RunId) -> RunnerResult<Self> {
        Ok(Self {
            job_id,
            group_dir: group_dir.to_path_buf(),
            job_dir: local_queue::profile_jobs_dir(group_dir, profile)?,
            job: local_queue::job_path(group_dir, profile, job_id)?,
            result: local_queue::result_path(group_dir, job_id),
            cancel: local_queue::cancel_path(group_dir, job_id),
            claim: local_queue::claim_path(group_dir, job_id),
        })
    }

    /// Clean up queue files after a completed job has produced a result.
    fn cleanup_completed(&self) {
        let jobs_removed = local_queue::LocalQueue::new(self.group_dir.clone())
            .remove_job_files_if_present(self.job_id);
        self.cleanup_active_inputs();
        let _ = remove_file_if_exists(&self.cancel);
        let _ = remove_file_if_exists(&self.claim);
        if jobs_removed {
            let _ = remove_file_if_exists(&self.result);
        }
    }

    /// Clean up submit-owned queue files after abandoning the wait for a result.
    fn cleanup_abandoned(&self, marker: Option<&PublishedMarker>) {
        let jobs_removed = local_queue::LocalQueue::new(self.group_dir.clone())
            .remove_job_files_if_present(self.job_id);
        let has_claim =
            local_queue::marker_file_exists(&self.claim, "local claim marker").unwrap_or(true);
        if jobs_removed && !has_claim {
            self.cleanup_active_inputs();
            let _ = remove_file_if_exists(&self.claim);
            let _ = remove_file_if_exists(&self.cancel);
            if marker.is_some() {
                remove_marker_if_unchanged(&self.result, marker);
            } else if result_file_is_empty(&self.result) {
                let _ = remove_file_if_exists(&self.result);
            }
        }
    }

    fn abandon(&self, error: &str) {
        let marker = write_abandoned_result_marker(&self.result, self.job_id, error);
        self.cleanup_abandoned(marker.as_ref());
    }

    fn abandon_cancelled(&self) {
        self.cleanup_abandoned(None);
    }

    fn cleanup_active_inputs(&self) {
        local_queue::LocalQueue::new(self.group_dir.clone())
            .cleanup_active_inputs_sync(self.job_id);
    }

    fn can_write_active_input(&self) -> bool {
        if local_queue::private_file_has_content(&self.result, "local result file").unwrap_or(false)
        {
            return false;
        }
        if local_queue::marker_path_occupied(&self.claim, "local claim marker").unwrap_or(false) {
            return true;
        }
        local_queue::marker_file_exists(&self.job, "local job file").unwrap_or(false)
    }
}

fn write_abandoned_result_marker(
    result_path: &std::path::Path,
    run_id: RunId,
    error: &str,
) -> Option<PublishedMarker> {
    // The result file is the durable terminal marker observed by local
    // runners.  Use it to prevent an abandoned job from being rediscovered
    // without creating a fake claim that could strand the job if submit exits.
    if try_read_result(result_path).is_some() {
        return None;
    }

    let response = JobResponse {
        run_id,
        exit_code: 1,
        error: Some(error.to_owned()),
    };
    let Ok(json) = serde_json::to_vec(&response) else {
        return None;
    };
    let result_dir = result_path.parent()?;
    let group_dir = result_dir.parent()?;
    if local_queue::ensure_results_dir(group_dir).is_err() {
        return None;
    }

    let tmp_path = result_dir.join(format!("{run_id}.{}.result.tmp", RunId::new_v4()));
    let mut file = match local_queue::open_private_new_file(
        &tmp_path,
        "local abandoned result marker temporary file",
    ) {
        Ok(file) => file,
        Err(_) => return None,
    };
    if std::io::Write::write_all(&mut file, &json).is_err() {
        let _ = remove_file_if_exists(&tmp_path);
        return None;
    }
    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(_) => {
            let _ = remove_file_if_exists(&tmp_path);
            return None;
        }
    };
    drop(file);

    // Publish with a no-clobber hard link so a runner result that wins the
    // race is never overwritten, and crashes before publish cannot leave a
    // partial terminal marker at the final result path.
    if std::fs::hard_link(&tmp_path, result_path).is_err() {
        let _ = remove_file_if_exists(&tmp_path);
        return None;
    }
    let _ = remove_file_if_exists(&tmp_path);
    Some(PublishedMarker {
        bytes: json,
        dev: metadata.dev(),
        ino: metadata.ino(),
    })
}

fn result_file_is_empty(result_path: &std::path::Path) -> bool {
    let is_file =
        local_queue::marker_file_exists(result_path, "local result file").unwrap_or(false);
    is_file
        && !local_queue::private_file_has_content(result_path, "local result file").unwrap_or(true)
}

fn remove_marker_if_unchanged(result_path: &std::path::Path, marker: Option<&PublishedMarker>) {
    let Some(marker) = marker else {
        return;
    };
    let Ok(metadata) = std::fs::symlink_metadata(result_path) else {
        return;
    };
    if !metadata.file_type().is_file() {
        return;
    }
    if metadata.dev() != marker.dev || metadata.ino() != marker.ino {
        return;
    }
    if local_queue::read_private_file(result_path, "local result file")
        .map(|current| current == marker.bytes)
        .unwrap_or(false)
    {
        let _ = remove_file_if_exists(result_path);
    }
}

struct SubmitPlan {
    group: String,
    profile: String,
    queue: SubmitQueueEntry,
    timeout: Duration,
    request_json: Vec<u8>,
    active_inputs: Vec<DelayedActiveInput>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DelayedActiveInput {
    sequence: u64,
    after: Duration,
    text: String,
}

struct ActiveInputProducer {
    stop: tokio_util::sync::CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl ActiveInputProducer {
    fn start(queue: SubmitQueueEntry, inputs: Vec<DelayedActiveInput>) -> Option<Self> {
        if inputs.is_empty() {
            return None;
        }
        let stop = tokio_util::sync::CancellationToken::new();
        let stop_for_task = stop.clone();
        let task = tokio::spawn(async move {
            let started_at = tokio::time::Instant::now();
            let queue_state = local_queue::LocalQueue::new(queue.group_dir.clone());
            for input in inputs {
                let sleep_for = input.after.saturating_sub(started_at.elapsed());
                tokio::select! {
                    () = stop_for_task.cancelled() => return,
                    () = tokio::time::sleep(sleep_for) => {
                        if !queue.can_write_active_input() {
                            return;
                        }
                        let entry = local_queue::ActiveInputEntry {
                            run_id: queue.job_id,
                            sequence: input.sequence,
                            text: input.text,
                        };
                        let queue_state = queue_state.clone();
                        let write_result = tokio::task::spawn_blocking(move || {
                            queue_state.write_active_input_sync(&entry)
                        })
                        .await
                        .unwrap_or_else(|error| Err(std::io::Error::other(error.to_string())));
                        if let Err(error) = write_result {
                            if error.kind() != std::io::ErrorKind::NotFound {
                                eprintln!("warn: failed to write local active input: {error}");
                            }
                            return;
                        }
                    }
                }
            }
        });
        Some(Self { stop, task })
    }

    async fn stop(self) {
        self.stop.cancel();
        if let Err(error) = self.task.await {
            eprintln!("warn: local active input producer task failed: {error}");
        }
    }
}

enum SubmitOutcome {
    Completed(Vec<u8>),
    Cancelled,
}

impl SubmitPlan {
    fn from_args(args: SubmitArgs, home: HomePaths) -> RunnerResult<Self> {
        let SubmitArgs {
            group,
            prompt,
            cli_agent_type,
            profile,
            chat_thread_id,
            session_id,
            feature_flags,
            env,
            secret_env,
            timeout,
            active_inputs,
        } = args;

        crate::group::validate_or_err(&group)?;

        let profile = match profile {
            Some(profile) => {
                crate::profile::validate_or_err(&profile)?;
                profile
            }
            None => crate::profile::DEFAULT_PROFILE.to_owned(),
        };

        let feature_flags = Self::parse_feature_flags(&feature_flags)?;
        let environment = Self::parse_env_entries("--env", &env)?;
        let secret_environment = Self::parse_env_entries("--secret-env", &secret_env)?;
        Self::validate_disjoint_env_keys(&environment, &secret_environment)?;
        let timeout = Self::validate_timeout(timeout)?;
        let group_dir = home.groups_dir().join(&group);
        local_queue::ensure_profile_jobs_dir(&group_dir, &profile).map_err(|e| {
            RunnerError::Config(format!("create job dir for profile {profile}: {e}"))
        })?;

        local_queue::ensure_results_dir(&group_dir)
            .map_err(|e| RunnerError::Config(format!("create results dir: {e}")))?;
        local_queue::ensure_cancels_dir(&group_dir)
            .map_err(|e| RunnerError::Config(format!("create cancels dir: {e}")))?;

        let job_id = RunId::new_v4();
        let active_inputs = Self::parse_active_inputs(&active_inputs, timeout)?;
        let request = JobRequest {
            job_id,
            prompt,
            cli_agent_type,
            vars: None,
            environment,
            secret_environment,
            user_timezone: detect_system_timezone(Path::new("/etc/timezone")),
            profile: Some(profile.clone()),
            reuse_key: chat_thread_id.map(|thread_id| format!("thread:{thread_id}")),
            session_id,
            feature_flags,
            active_input: (!active_inputs.is_empty()).then_some(true),
        };

        let request_json = serde_json::to_vec(&request)
            .map_err(|e| RunnerError::Internal(format!("serialize request: {e}")))?;
        if request_json.len() > local_queue::LOCAL_JOB_MAX_BYTES {
            return Err(RunnerError::Config(format!(
                "serialized local job request exceeds {} bytes (got {} bytes)",
                local_queue::LOCAL_JOB_MAX_BYTES,
                request_json.len()
            )));
        }
        let queue = SubmitQueueEntry::for_job(&group_dir, &profile, job_id)?;

        Ok(Self {
            group,
            profile,
            queue,
            timeout,
            request_json,
            active_inputs,
        })
    }

    fn parse_active_inputs(
        values: &[String],
        timeout: Duration,
    ) -> RunnerResult<Vec<DelayedActiveInput>> {
        let mut inputs: Vec<DelayedActiveInput> = Vec::with_capacity(values.len());
        for (index, value) in values.iter().enumerate() {
            let input = Self::parse_active_input(value, index as u64 + 1, timeout)?;
            if let Some(previous) = inputs.last()
                && input.after < previous.after
            {
                return Err(RunnerError::Config(
                    "invalid --active-input value: delays must be non-decreasing".to_string(),
                ));
            }
            inputs.push(input);
        }
        Ok(inputs)
    }

    fn parse_active_input(
        value: &str,
        sequence: u64,
        timeout: Duration,
    ) -> RunnerResult<DelayedActiveInput> {
        let rest = value.strip_prefix("after=").ok_or_else(|| {
            RunnerError::Config(
                "invalid --active-input value: expected after=<duration>,text=<text>".to_string(),
            )
        })?;
        let (after, text) = rest.split_once(",text=").ok_or_else(|| {
            RunnerError::Config(
                "invalid --active-input value: expected after=<duration>,text=<text>".to_string(),
            )
        })?;
        let after = Self::parse_active_input_delay(after)?;
        if after >= timeout {
            return Err(RunnerError::Config(format!(
                "invalid --active-input value: delay must be less than submit timeout ({timeout:?})"
            )));
        }
        if text.is_empty() {
            return Err(RunnerError::Config(
                "invalid --active-input value: text must not be empty".to_string(),
            ));
        }
        if text.contains('\0') {
            return Err(RunnerError::Config(
                "invalid --active-input value: text must not contain NUL characters".to_string(),
            ));
        }
        let payload_len = identified_active_input_payload_len(text).map_err(|e| {
            RunnerError::Internal(format!(
                "serialize active-input payload for validation: {e}"
            ))
        })?;
        if payload_len > ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES {
            return Err(RunnerError::Config(format!(
                "invalid --active-input value: serialized payload must be <= {ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES} bytes"
            )));
        }
        Ok(DelayedActiveInput {
            sequence,
            after,
            text: text.to_owned(),
        })
    }

    fn parse_active_input_delay(value: &str) -> RunnerResult<Duration> {
        let (digits, unit) = if let Some(digits) = value.strip_suffix("ms") {
            (digits, "ms")
        } else if let Some(digits) = value.strip_suffix('s') {
            (digits, "s")
        } else {
            return Err(RunnerError::Config(format!(
                "invalid --active-input duration '{value}': expected positive integer ms or s"
            )));
        };
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(RunnerError::Config(format!(
                "invalid --active-input duration '{value}': expected positive integer"
            )));
        }
        let amount = digits.parse::<u64>().map_err(|_| {
            RunnerError::Config(format!(
                "invalid --active-input duration '{value}': out of range"
            ))
        })?;
        if amount == 0 {
            return Err(RunnerError::Config(format!(
                "invalid --active-input duration '{value}': must be greater than zero"
            )));
        }
        Ok(if unit == "ms" {
            Duration::from_millis(amount)
        } else {
            Duration::from_secs(amount)
        })
    }

    fn validate_timeout(timeout: u64) -> RunnerResult<Duration> {
        if timeout > MAX_LOCAL_SUBMIT_TIMEOUT_SECS {
            return Err(RunnerError::Config(format!(
                "invalid --timeout: must be <= {MAX_LOCAL_SUBMIT_TIMEOUT_SECS} seconds (got {timeout})"
            )));
        }
        Ok(Duration::from_secs(timeout))
    }

    fn parse_feature_flags(flags: &[String]) -> RunnerResult<Option<HashMap<String, bool>>> {
        if flags.is_empty() {
            return Ok(None);
        }

        let mut map = HashMap::new();
        for flag in flags {
            let (key, value) = flag.split_once('=').ok_or_else(|| {
                RunnerError::Config(format!("invalid feature flag (expected key=value): {flag}"))
            })?;
            let bool_val = value.parse::<bool>().map_err(|_| {
                RunnerError::Config(format!(
                    "invalid feature flag value (expected true/false): {flag}"
                ))
            })?;
            map.insert(key.to_string(), bool_val);
        }
        Ok(Some(map))
    }

    fn parse_env_entries(
        flag: &str,
        entries: &[String],
    ) -> RunnerResult<Option<HashMap<String, String>>> {
        if entries.is_empty() {
            return Ok(None);
        }

        let mut map = HashMap::new();
        for entry in entries {
            if entry.contains('\0') {
                return Err(RunnerError::Config(format!(
                    "invalid {flag} value: NUL characters are not allowed"
                )));
            }
            let Some(eq_pos) = entry.find('=') else {
                return Err(RunnerError::Config(format!(
                    "invalid {flag} value: expected KEY=VALUE format"
                )));
            };
            if eq_pos == 0 {
                return Err(RunnerError::Config(format!(
                    "invalid {flag} value: expected KEY=VALUE format"
                )));
            }

            let key = &entry[..eq_pos];
            let value = &entry[eq_pos + 1..];
            if !guest_contracts::env::is_shell_identifier_env_key(key) {
                return Err(RunnerError::Config(format!(
                    "invalid {flag} key: expected [_A-Za-z][_A-Za-z0-9]*"
                )));
            }
            if key.starts_with("OKOU_") {
                return Err(RunnerError::Config(format!(
                    "invalid {flag} key '{key}': the OKOU_ environment variable namespace is platform-reserved"
                )));
            }
            if guest_contracts::env::is_runner_owned_env_key(key) {
                return Err(RunnerError::Config(format!(
                    "invalid {flag} key '{key}': runner-owned environment variables are not allowed"
                )));
            }
            if map.insert(key.to_owned(), value.to_owned()).is_some() {
                return Err(RunnerError::Config(format!("duplicate {flag} key '{key}'")));
            }
        }

        Ok(Some(map))
    }

    fn validate_disjoint_env_keys(
        environment: &Option<HashMap<String, String>>,
        secret_environment: &Option<HashMap<String, String>>,
    ) -> RunnerResult<()> {
        let (Some(environment), Some(secret_environment)) = (environment, secret_environment)
        else {
            return Ok(());
        };

        let secret_keys: HashSet<&str> = secret_environment.keys().map(String::as_str).collect();
        for key in environment.keys() {
            if secret_keys.contains(key.as_str()) {
                return Err(RunnerError::Config(format!(
                    "duplicate env key '{key}' across --env and --secret-env"
                )));
            }
        }
        Ok(())
    }

    fn write_job_file(&self) -> RunnerResult<()> {
        let tmp_path = self
            .queue
            .job_dir
            .join(format!("{}.job.tmp", self.queue.job_id));
        if let Err(e) = local_queue::write_private_file(
            &tmp_path,
            &self.request_json,
            "local job temporary file",
        ) {
            let _ = remove_file_if_exists(&tmp_path);
            return Err(RunnerError::Internal(format!("write job file: {e}")));
        }
        if let Err(e) = std::fs::rename(&tmp_path, &self.queue.job) {
            let _ = remove_file_if_exists(&tmp_path);
            return Err(RunnerError::Internal(format!("rename job file: {e}")));
        }
        Ok(())
    }

    fn start_active_input_producer(&mut self) -> Option<ActiveInputProducer> {
        ActiveInputProducer::start(self.queue.clone(), std::mem::take(&mut self.active_inputs))
    }

    async fn wait_for_result(&self, sigint: &mut Signal) -> RunnerResult<SubmitOutcome> {
        let started_at = tokio::time::Instant::now();

        loop {
            if let Some(buf) = try_read_result(&self.queue.result) {
                return Ok(SubmitOutcome::Completed(buf));
            }
            let elapsed = started_at.elapsed();
            if elapsed >= self.timeout {
                if let Some(buf) = try_read_result(&self.queue.result) {
                    return Ok(SubmitOutcome::Completed(buf));
                }
                let error = format!(
                    "timeout waiting for local result after {:?} (group: {}, profile: {}). no local runner may be running for this group, or no runner in the group may support this profile",
                    self.timeout, self.group, self.profile
                );
                self.abandon(&error);
                return Err(RunnerError::Internal(error));
            }
            let remaining = self.timeout.saturating_sub(elapsed);
            tokio::select! {
                () = tokio::time::sleep(std::cmp::min(POLL_INTERVAL, remaining)) => {}
                _ = sigint.recv() => {
                    eprintln!("interrupted — requesting cancel for {}", self.queue.job_id);
                    let _ = local_queue::write_private_marker(&self.queue.cancel, "local cancel marker");
                    return Ok(self.wait_for_cancel_grace(sigint).await);
                }
            }
        }
    }

    async fn wait_for_cancel_grace(&self, sigint: &mut Signal) -> SubmitOutcome {
        let grace = tokio::time::Instant::now() + CANCEL_GRACE;
        loop {
            if let Some(buf) = try_read_result(&self.queue.result) {
                return SubmitOutcome::Completed(buf);
            }
            if tokio::time::Instant::now() >= grace {
                eprintln!("grace period expired, exiting");
                // Leave .cancel for the runner to process — don't delete it here
                // or the cancel request may be lost.
                self.abandon_cancelled();
                return SubmitOutcome::Cancelled;
            }
            tokio::select! {
                () = tokio::time::sleep(POLL_INTERVAL) => {}
                _ = sigint.recv() => {
                    eprintln!("second interrupt, exiting immediately");
                    self.abandon_cancelled();
                    return SubmitOutcome::Cancelled;
                }
            }
        }
    }

    fn abandon(&self, error: &str) {
        self.queue.abandon(error);
    }

    fn abandon_cancelled(&self) {
        self.queue.abandon_cancelled();
    }

    fn finish_completed(&self, buf: &[u8]) -> RunnerResult<ExitCode> {
        let response: JobResponse = serde_json::from_slice(buf)
            .map_err(|e| RunnerError::Internal(format!("parse result: {e}")))?;
        if response.run_id != self.queue.job_id {
            return Err(RunnerError::Internal(format!(
                "local result run_id mismatch: expected {}, actual {}",
                self.queue.job_id, response.run_id
            )));
        }

        self.queue.cleanup_completed();

        std::io::stdout().write_all(buf).ok();
        std::io::stdout().write_all(b"\n").ok();

        if response.exit_code == 0 {
            Ok(ExitCode::SUCCESS)
        } else {
            Ok(ExitCode::FAILURE)
        }
    }
}

#[cfg(test)]
pub(super) fn cleanup_completed_for_test(group_dir: &Path, profile: &str, job_id: RunId) {
    SubmitQueueEntry::for_job(group_dir, profile, job_id)
        .unwrap()
        .cleanup_completed();
}

#[cfg(test)]
pub(crate) fn abandon_cancelled_submit_for_test(group_dir: &Path, job_id: RunId) {
    SubmitQueueEntry::for_job(group_dir, crate::profile::DEFAULT_PROFILE, job_id)
        .unwrap()
        .abandon_cancelled();
}

pub async fn run_submit(args: SubmitArgs) -> RunnerResult<ExitCode> {
    run_submit_with_home(args, HomePaths::new()?).await
}

async fn run_submit_with_home(args: SubmitArgs, home: HomePaths) -> RunnerResult<ExitCode> {
    let mut plan = SubmitPlan::from_args(args, home)?;
    let mut sigint = signal(SignalKind::interrupt())
        .map_err(|e| RunnerError::Internal(format!("register local submit SIGINT handler: {e}")))?;
    plan.write_job_file()?;
    #[cfg(test)]
    tests::post_publish_test_checkpoint();
    let producer = plan.start_active_input_producer();
    let outcome = plan.wait_for_result(&mut sigint).await;
    if let Some(producer) = producer {
        producer.stop().await;
    }
    if matches!(outcome, Err(_) | Ok(SubmitOutcome::Cancelled)) {
        plan.queue.cleanup_abandoned(None);
    }
    match outcome? {
        SubmitOutcome::Completed(buf) => plan.finish_completed(&buf),
        SubmitOutcome::Cancelled => Ok(ExitCode::FAILURE),
    }
}

#[cfg(test)]
mod tests;
