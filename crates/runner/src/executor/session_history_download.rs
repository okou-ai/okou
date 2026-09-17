//! Resume-session history materialization for runner execution.
//!
//! Resume sessions can arrive with no history, inline history, or a hash-backed
//! history reference. This module owns the hash-backed materializer lifecycle:
//! no resume session, no download needed, or an in-flight download task. Inline
//! history stays on the original `ResumeSession`; `agent_run` routes Codex
//! timestamp extraction through the shared CPU materializer after `finish`
//! reports that no download was needed.
//!
//! Hash-backed downloads can be started before the final restore point so the
//! network fetch overlaps sandbox preparation and reuse checks. `finish` is the
//! single point that consumes the task result, and cancellation takes priority
//! over a completed download so cancelled runs do not proceed into restore.
//!
//! `SessionHistoryProbe` is runner-process-local, in-memory telemetry
//! observation for hash-backed references. It does not cache session-history
//! bytes, suppress or deduplicate downloads, or coordinate observations across
//! runners. A reference identity is the tuple of hash, encoding, raw size, and
//! encoded size; URL and download source are not part of that identity. The
//! default probe treats observations as recent for one hour and bounds the
//! tracked set to 4,096 identities.
//!
//! Probe observations are sampled before the current materializer registers its
//! download. `session_history_ref_seen_recently` therefore reports whether a
//! matching identity had a prior observation within the probe window, while
//! `session_history_ref_download_inflight` reports whether a prior matching
//! registration was active at that sampling point. Expiry and bounded capacity
//! eviction make both fields best-effort signals; they do not establish byte
//! availability or authoritative global activity. Registrations are released
//! through the shared guard across task completion, cancellation, task abort,
//! and materializer or guard drop.
//!
//! Download diagnostics must not expose presigned URL query strings, and the
//! downloaded bytes must satisfy the declared size, byte cap, and hash contract
//! before they are restored into the sandbox.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES;
use reqwest::header::{CONTENT_ENCODING, TRANSFER_ENCODING};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::cli_framework::EffectiveCliFramework;
use super::session_history_cpu::{
    SessionHistoryCpuJob, SessionHistoryCpuMaterialization, SessionHistoryCpuPool,
    SessionHistoryCpuTimings, SessionHistoryPrefixOutcome,
};
use super::session_restore::MaterializedResumeSession;
use crate::error::{RunnerError, RunnerResult};
use crate::http::HttpClient;
use crate::object_download_policy::OBJECT_DOWNLOAD_TIMEOUT;
use crate::restored_session_identity::RestoredSessionHistoryPrefixAttribution;
use crate::telemetry::{
    SessionHistoryCacheProbeMetadata, SessionHistoryContentEncodingState,
    SessionHistoryContentLengthState, SessionHistoryResponseTelemetryMetadata,
    SessionHistoryTelemetryMetadata, SessionHistoryTransferEncodingState,
};
use crate::types::{
    ResumeSession, ResumeSessionHistoryEncoding, ResumeSessionHistoryRef,
    ResumeSessionHistoryRefKind,
};

const SESSION_HISTORY_PROBE_TTL: Duration = Duration::from_secs(60 * 60);
const SESSION_HISTORY_PROBE_CAPACITY: usize = 4096;

pub(crate) struct SessionHistoryMaterializer {
    state: SessionHistoryMaterializerState,
}

/// Runner-process-local, in-memory observation of session-history ref activity.
///
/// The probe exists only to annotate download telemetry. It does not store
/// history bytes, suppress downloads, deduplicate requests, or share state
/// across runners. Its default one-hour observation window and 4,096-entry
/// capacity bound the state, so observations can be lost through expiry or
/// eviction and must be interpreted as best-effort signals.
#[derive(Clone)]
pub(crate) struct SessionHistoryProbe {
    inner: Arc<Mutex<SessionHistoryProbeState>>,
    ttl: Duration,
    capacity: usize,
}

#[derive(Default)]
struct SessionHistoryProbeState {
    entries: HashMap<SessionHistoryProbeKey, SessionHistoryProbeEntry>,
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct SessionHistoryProbeKey {
    hash: String,
    encoding: ResumeSessionHistoryEncoding,
    raw_size: u64,
    encoded_size: u64,
}

#[derive(Clone, Copy)]
struct SessionHistoryProbeEntry {
    last_seen: Instant,
    in_flight: usize,
}

#[derive(Clone)]
struct SessionHistoryProbeRegistration {
    observation: SessionHistoryCacheProbeMetadata,
    guard: Option<SessionHistoryProbeGuard>,
}

#[derive(Clone)]
struct SessionHistoryProbeGuard {
    inner: Arc<SessionHistoryProbeGuardInner>,
}

struct SessionHistoryProbeGuardInner {
    probe: SessionHistoryProbe,
    key: Mutex<Option<SessionHistoryProbeKey>>,
}

enum SessionHistoryMaterializerState {
    Missing,
    NoDownloadNeeded,
    Downloading {
        started_at: Instant,
        metadata: SessionHistoryTelemetryMetadata,
        probe_registration: Option<SessionHistoryProbeRegistration>,
        cancel: CancellationToken,
        task: Option<JoinHandle<SessionHistoryDownloadTaskResult>>,
    },
}

pub(super) enum SessionHistoryMaterialization {
    Missing,
    NoDownloadNeeded,
    Downloaded {
        session: MaterializedResumeSession,
        prefix_outcome: Option<SessionHistoryPrefixOutcome>,
        elapsed: Duration,
        timings: SessionHistoryDownloadTimings,
    },
    Failed {
        elapsed: Duration,
        timings: SessionHistoryDownloadTimings,
        error: RunnerError,
    },
}

struct SessionHistoryDownloadTaskResult {
    elapsed: Duration,
    timings: SessionHistoryDownloadTimings,
    result: RunnerResult<SessionHistoryCpuMaterialization>,
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct SessionHistoryDownloadTimings {
    metadata: Option<SessionHistoryTelemetryMetadata>,
    request_status: Option<SessionHistoryDownloadPhaseTiming>,
    body_read: Option<SessionHistoryDownloadPhaseTiming>,
    validation: Option<SessionHistoryDownloadPhaseTiming>,
    decompression: Option<SessionHistoryDownloadPhaseTiming>,
    hash_verification: Option<SessionHistoryDownloadPhaseTiming>,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct SessionHistoryDownloadPhaseTiming {
    elapsed: Duration,
    success: bool,
}

impl SessionHistoryDownloadTimings {
    #[cfg(test)]
    pub(super) fn encoding(&self) -> Option<&'static str> {
        self.metadata.map(SessionHistoryTelemetryMetadata::encoding)
    }

    pub(super) fn metadata(&self) -> Option<SessionHistoryTelemetryMetadata> {
        self.metadata
    }

    pub(super) fn request_status(&self) -> Option<SessionHistoryDownloadPhaseTiming> {
        self.request_status
    }

    pub(super) fn body_read(&self) -> Option<SessionHistoryDownloadPhaseTiming> {
        self.body_read
    }

    pub(super) fn validation(&self) -> Option<SessionHistoryDownloadPhaseTiming> {
        self.validation
    }

    pub(super) fn decompression(&self) -> Option<SessionHistoryDownloadPhaseTiming> {
        self.decompression
    }

    pub(super) fn hash_verification(&self) -> Option<SessionHistoryDownloadPhaseTiming> {
        self.hash_verification
    }

    fn record_request_status(&mut self, elapsed: Duration, success: bool) {
        self.request_status = Some(SessionHistoryDownloadPhaseTiming { elapsed, success });
    }

    #[cfg(test)]
    pub(super) fn response_metadata(&self) -> Option<SessionHistoryResponseTelemetryMetadata> {
        self.metadata
            .and_then(SessionHistoryTelemetryMetadata::response)
    }

    fn for_metadata(metadata: SessionHistoryTelemetryMetadata) -> Self {
        Self {
            metadata: Some(metadata),
            ..Self::default()
        }
    }

    fn record_response_metadata(&mut self, response: SessionHistoryResponseTelemetryMetadata) {
        if let Some(metadata) = self.metadata {
            self.metadata = Some(metadata.with_response(response));
        }
    }

    fn record_body_read(&mut self, elapsed: Duration, success: bool) {
        self.body_read = Some(SessionHistoryDownloadPhaseTiming { elapsed, success });
    }

    fn record_hash_verification(&mut self, elapsed: Duration, success: bool) {
        self.hash_verification = Some(SessionHistoryDownloadPhaseTiming { elapsed, success });
    }

    fn record_decompression(&mut self, elapsed: Duration, success: bool) {
        self.decompression = Some(SessionHistoryDownloadPhaseTiming { elapsed, success });
    }

    fn add_validation(&mut self, elapsed: Duration, success: bool) {
        merge_phase_timing(&mut self.validation, elapsed, success);
    }

    fn merge_cpu(&mut self, timings: SessionHistoryCpuTimings) {
        if let Some(phase) = timings.validation() {
            self.add_validation(phase.elapsed(), phase.success());
        }
        if let Some(phase) = timings.decompression() {
            self.record_decompression(phase.elapsed(), phase.success());
        }
        if let Some(phase) = timings.hash_verification() {
            self.record_hash_verification(phase.elapsed(), phase.success());
        }
    }
}

impl SessionHistoryDownloadPhaseTiming {
    pub(super) fn elapsed(self) -> Duration {
        self.elapsed
    }

    pub(super) fn success(self) -> bool {
        self.success
    }
}

fn merge_phase_timing(
    phase: &mut Option<SessionHistoryDownloadPhaseTiming>,
    elapsed: Duration,
    success: bool,
) {
    match phase {
        Some(phase) => {
            phase.elapsed += elapsed;
            phase.success &= success;
        }
        None => {
            *phase = Some(SessionHistoryDownloadPhaseTiming { elapsed, success });
        }
    }
}

impl Default for SessionHistoryProbe {
    fn default() -> Self {
        Self::new(SESSION_HISTORY_PROBE_TTL, SESSION_HISTORY_PROBE_CAPACITY)
    }
}

impl SessionHistoryProbe {
    fn new(ttl: Duration, capacity: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(SessionHistoryProbeState::default())),
            ttl,
            capacity,
        }
    }

    #[cfg(test)]
    fn with_limits_for_test(ttl: Duration, capacity: usize) -> Self {
        Self::new(ttl, capacity)
    }

    fn observe(&self, history_ref: &ResumeSessionHistoryRef) -> SessionHistoryProbeRegistration {
        let now = Instant::now();
        let key = SessionHistoryProbeKey::from_ref(history_ref);
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.prune_expired(&mut state, now);

        let previous = state.entries.get(&key).copied();
        let seen_recently = previous
            .map(|entry| now.saturating_duration_since(entry.last_seen) <= self.ttl)
            .unwrap_or(false);
        let download_inflight = previous.map(|entry| entry.in_flight > 0).unwrap_or(false);
        let observation = SessionHistoryCacheProbeMetadata::new(seen_recently, download_inflight);

        if self.capacity == 0 {
            return SessionHistoryProbeRegistration {
                observation,
                guard: None,
            };
        }

        state
            .entries
            .entry(key.clone())
            .and_modify(|entry| {
                entry.last_seen = now;
                entry.in_flight = entry.in_flight.saturating_add(1);
            })
            .or_insert(SessionHistoryProbeEntry {
                last_seen: now,
                in_flight: 1,
            });
        self.enforce_capacity(&mut state, &key);

        let guard = state
            .entries
            .contains_key(&key)
            .then(|| SessionHistoryProbeGuard::new(self.clone(), key));
        SessionHistoryProbeRegistration { observation, guard }
    }

    fn finish(&self, key: SessionHistoryProbeKey) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = state.entries.get_mut(&key) {
            entry.in_flight = entry.in_flight.saturating_sub(1);
        }
    }

    fn prune_expired(&self, state: &mut SessionHistoryProbeState, now: Instant) {
        let ttl = self.ttl;
        state.entries.retain(|_, entry| {
            entry.in_flight > 0 || now.saturating_duration_since(entry.last_seen) <= ttl
        });
    }

    fn enforce_capacity(
        &self,
        state: &mut SessionHistoryProbeState,
        current_key: &SessionHistoryProbeKey,
    ) {
        while state.entries.len() > self.capacity {
            let candidate = state
                .entries
                .iter()
                .filter(|(key, _)| *key != current_key)
                .filter(|(_, entry)| entry.in_flight == 0)
                .min_by_key(|(_, entry)| entry.last_seen)
                .map(|(key, _)| key.clone())
                .or_else(|| {
                    state
                        .entries
                        .iter()
                        .filter(|(key, _)| *key != current_key)
                        .min_by_key(|(_, entry)| entry.last_seen)
                        .map(|(key, _)| key.clone())
                })
                .or_else(|| state.entries.keys().next().cloned());
            let Some(candidate) = candidate else {
                break;
            };
            state.entries.remove(&candidate);
        }
    }
}

impl SessionHistoryProbeKey {
    fn from_ref(history_ref: &ResumeSessionHistoryRef) -> Self {
        Self {
            hash: history_ref.hash.clone(),
            encoding: history_ref.encoding,
            raw_size: history_ref.raw_size,
            encoded_size: history_ref.encoded_size,
        }
    }
}

impl SessionHistoryProbeRegistration {
    fn observation(&self) -> SessionHistoryCacheProbeMetadata {
        self.observation
    }

    fn finish(&self) {
        if let Some(guard) = &self.guard {
            guard.finish();
        }
    }
}

impl SessionHistoryProbeGuard {
    fn new(probe: SessionHistoryProbe, key: SessionHistoryProbeKey) -> Self {
        Self {
            inner: Arc::new(SessionHistoryProbeGuardInner {
                probe,
                key: Mutex::new(Some(key)),
            }),
        }
    }

    fn finish(&self) {
        let key = self
            .inner
            .key
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(key) = key {
            self.inner.probe.finish(key);
        }
    }
}

impl Drop for SessionHistoryProbeGuardInner {
    fn drop(&mut self) {
        let key = self
            .key
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(key) = key {
            self.probe.finish(key);
        }
    }
}

impl SessionHistoryMaterializer {
    pub(crate) fn start_cancellable(
        http: &HttpClient,
        cpu: &SessionHistoryCpuPool,
        session: Option<&ResumeSession>,
        framework: EffectiveCliFramework,
        cancel: CancellationToken,
        probe: Option<&SessionHistoryProbe>,
    ) -> Self {
        Self::start_cancellable_inner(http, cpu, session, framework, cancel, probe, None)
    }

    pub(crate) fn start_cancellable_with_prefix_attribution(
        http: &HttpClient,
        cpu: &SessionHistoryCpuPool,
        session: Option<&ResumeSession>,
        framework: EffectiveCliFramework,
        cancel: CancellationToken,
        probe: Option<&SessionHistoryProbe>,
        prefix_attribution: RestoredSessionHistoryPrefixAttribution,
    ) -> Self {
        Self::start_cancellable_inner(
            http,
            cpu,
            session,
            framework,
            cancel,
            probe,
            Some(prefix_attribution),
        )
    }

    fn start_cancellable_inner(
        http: &HttpClient,
        cpu: &SessionHistoryCpuPool,
        session: Option<&ResumeSession>,
        framework: EffectiveCliFramework,
        cancel: CancellationToken,
        probe: Option<&SessionHistoryProbe>,
        prefix_attribution: Option<RestoredSessionHistoryPrefixAttribution>,
    ) -> Self {
        let Some(session) = session else {
            return Self {
                state: SessionHistoryMaterializerState::Missing,
            };
        };
        let Some(history_ref) = session.history_ref() else {
            return Self {
                state: SessionHistoryMaterializerState::NoDownloadNeeded,
            };
        };
        let probe_registration = probe.map(|probe| probe.observe(history_ref));
        let mut metadata = SessionHistoryTelemetryMetadata::from_ref(history_ref);
        if let Some(registration) = &probe_registration {
            metadata = metadata.with_cache_probe(registration.observation());
        }

        let http = http.clone();
        let cpu = cpu.clone();
        let session = session.clone();
        let started_at = Instant::now();
        let task_cancel = cancel.child_token();
        let task_cancel_for_task = task_cancel.clone();
        let task_probe_registration = probe_registration.clone();
        // The spawned task observes cancellation even before `finish` runs, so
        // prestarted downloads do not need to wait for final materialization.
        Self {
            state: SessionHistoryMaterializerState::Downloading {
                started_at,
                metadata,
                probe_registration,
                cancel: task_cancel,
                task: Some(tokio::spawn(async move {
                    let result = download_resume_session_history_timed(
                        http,
                        cpu,
                        session,
                        framework,
                        metadata,
                        prefix_attribution,
                        task_cancel_for_task,
                    )
                    .await;
                    if let Some(registration) = &task_probe_registration {
                        registration.finish();
                    }
                    result
                })),
            },
        }
    }

    pub(super) fn is_downloading(&self) -> bool {
        matches!(
            self.state,
            SessionHistoryMaterializerState::Downloading { .. }
        )
    }

    pub(super) fn is_download_finished(&self) -> bool {
        matches!(
            &self.state,
            SessionHistoryMaterializerState::Downloading {
                task: Some(task),
                ..
            } if task.is_finished()
        )
    }

    pub(super) async fn finish(
        mut self,
        cancel: &CancellationToken,
    ) -> SessionHistoryMaterialization {
        // `finish` transfers ownership of the background task into final
        // materialization. Cancellation wins over any completed task result.
        match &mut self.state {
            SessionHistoryMaterializerState::Missing => SessionHistoryMaterialization::Missing,
            SessionHistoryMaterializerState::NoDownloadNeeded => {
                SessionHistoryMaterialization::NoDownloadNeeded
            }
            SessionHistoryMaterializerState::Downloading {
                started_at,
                metadata,
                probe_registration,
                cancel: task_cancel,
                task,
            } => {
                let started_at = *started_at;
                let metadata = *metadata;
                if cancel.is_cancelled() || task_cancel.is_cancelled() {
                    task_cancel.cancel();
                    if let Some(task) = task.take() {
                        let _ = task.await;
                    }
                    finish_session_history_probe(probe_registration);
                    return SessionHistoryDownloadTaskResult::cancelled(started_at, metadata)
                        .into_materialization();
                }
                let Some(mut task) = task.take() else {
                    finish_session_history_probe(probe_registration);
                    return SessionHistoryMaterialization::Failed {
                        elapsed: Duration::ZERO,
                        timings: SessionHistoryDownloadTimings::for_metadata(metadata),
                        error: RunnerError::Internal(
                            "session history materializer lost download task".into(),
                        ),
                    };
                };
                let result = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => {
                        task_cancel.cancel();
                        let _ = task.await;
                        SessionHistoryDownloadTaskResult::cancelled(started_at, metadata)
                    }
                    _ = task_cancel.cancelled() => {
                        let _ = task.await;
                        SessionHistoryDownloadTaskResult::cancelled(started_at, metadata)
                    }
                    joined = &mut task => {
                        joined.unwrap_or_else(|error| {
                            SessionHistoryDownloadTaskResult {
                                elapsed: started_at.elapsed(),
                                timings: SessionHistoryDownloadTimings::for_metadata(metadata),
                                result: Err(RunnerError::Internal(format!(
                                    "session history download task failed: {error}"
                                ))),
                            }
                        })
                    }
                };
                finish_session_history_probe(probe_registration);
                // Re-check after joining because the task itself can observe
                // cancellation while still producing a successful result.
                if cancel.is_cancelled() || task_cancel.is_cancelled() {
                    return SessionHistoryDownloadTaskResult::cancelled(started_at, metadata)
                        .into_materialization();
                }
                result.into_materialization()
            }
        }
    }
}

impl SessionHistoryDownloadTaskResult {
    fn into_materialization(self) -> SessionHistoryMaterialization {
        match self.result {
            Ok(materialization) => SessionHistoryMaterialization::Downloaded {
                session: materialization.session,
                prefix_outcome: materialization.prefix_outcome,
                elapsed: self.elapsed,
                timings: self.timings,
            },
            Err(error) => SessionHistoryMaterialization::Failed {
                elapsed: self.elapsed,
                timings: self.timings,
                error,
            },
        }
    }

    fn cancelled(started_at: Instant, metadata: SessionHistoryTelemetryMetadata) -> Self {
        Self {
            elapsed: started_at.elapsed(),
            timings: SessionHistoryDownloadTimings::for_metadata(metadata),
            result: Err(RunnerError::Cancelled),
        }
    }
}

impl Drop for SessionHistoryMaterializer {
    fn drop(&mut self) {
        if let SessionHistoryMaterializerState::Downloading {
            cancel,
            task: Some(task),
            ..
        } = &mut self.state
        {
            // Dropping means no owner will call `finish`. Abort the task so an
            // abandoned prestarted download does not continue in the background.
            // Probe cleanup is handled by explicit finish paths or by the
            // guard's drop fallback when the task future is gone.
            cancel.cancel();
            task.abort();
        }
    }
}

fn finish_session_history_probe(registration: &Option<SessionHistoryProbeRegistration>) {
    if let Some(registration) = registration {
        registration.finish();
    }
}

async fn download_resume_session_history_timed(
    http: HttpClient,
    cpu: SessionHistoryCpuPool,
    session: ResumeSession,
    framework: EffectiveCliFramework,
    metadata: SessionHistoryTelemetryMetadata,
    prefix_attribution: Option<RestoredSessionHistoryPrefixAttribution>,
    cancel: CancellationToken,
) -> SessionHistoryDownloadTaskResult {
    let started_at = Instant::now();
    let mut timings = SessionHistoryDownloadTimings::for_metadata(metadata);
    if cancel.is_cancelled() {
        return SessionHistoryDownloadTaskResult::cancelled(started_at, metadata);
    }
    let result = download_resume_session_history(
        http,
        &cpu,
        session,
        framework,
        prefix_attribution,
        &cancel,
        &mut timings,
    )
    .await;
    if cancel.is_cancelled() {
        return SessionHistoryDownloadTaskResult::cancelled(started_at, metadata);
    }
    SessionHistoryDownloadTaskResult {
        elapsed: started_at.elapsed(),
        timings,
        result,
    }
}

async fn download_resume_session_history(
    http: HttpClient,
    cpu: &SessionHistoryCpuPool,
    session: ResumeSession,
    framework: EffectiveCliFramework,
    prefix_attribution: Option<RestoredSessionHistoryPrefixAttribution>,
    cancel: &CancellationToken,
    timings: &mut SessionHistoryDownloadTimings,
) -> RunnerResult<SessionHistoryCpuMaterialization> {
    // The history ref is treated as untrusted input. The request timeout and
    // 128 MiB cap bound resource use; declared size, HTTP content-length, final
    // byte count, and SHA-256 must all agree before the bytes become sandbox
    // session history. URL diagnostics redact query strings because the ref URL
    // can be presigned.
    let history_ref = session
        .history_ref()
        .ok_or_else(|| RunnerError::Internal("resume session history ref is missing".into()))?
        .clone();
    match history_ref.kind {
        ResumeSessionHistoryRefKind::Blob => {}
    }

    let encoding = history_ref.encoding;

    let job = match encoding {
        ResumeSessionHistoryEncoding::Identity => {
            validate_identity_ref(&history_ref, timings)?;
            let bytes = download_body(
                &http,
                &history_ref.url,
                Some(history_ref.encoded_size),
                cancel,
                timings,
            )
            .await?;
            SessionHistoryCpuJob::raw(
                session.cli_agent_session_id,
                bytes,
                history_ref.raw_size,
                history_ref.hash,
                framework,
            )
        }
        ResumeSessionHistoryEncoding::Gzip => {
            let raw_size = validate_compressed_ref("gzip", &history_ref, timings)?;
            let encoded_bytes = download_body(
                &http,
                &history_ref.url,
                Some(history_ref.encoded_size),
                cancel,
                timings,
            )
            .await?;
            SessionHistoryCpuJob::gzip(
                session.cli_agent_session_id,
                encoded_bytes,
                raw_size,
                history_ref.hash,
                framework,
            )
        }
        ResumeSessionHistoryEncoding::Zstd => {
            let raw_size = validate_compressed_ref("zstd", &history_ref, timings)?;
            let encoded_bytes = download_body(
                &http,
                &history_ref.url,
                Some(history_ref.encoded_size),
                cancel,
                timings,
            )
            .await?;
            SessionHistoryCpuJob::zstd(
                session.cli_agent_session_id,
                encoded_bytes,
                raw_size,
                history_ref.hash,
                framework,
            )
        }
    };
    let job = match prefix_attribution {
        Some(prefix_attribution) => job.with_prefix_attribution(prefix_attribution),
        None => job,
    };
    let outcome = cpu.materialize(job, cancel).await?;
    timings.merge_cpu(outcome.timings);
    outcome.result
}

fn validate_identity_ref(
    history_ref: &ResumeSessionHistoryRef,
    timings: &mut SessionHistoryDownloadTimings,
) -> RunnerResult<()> {
    let validation_started = Instant::now();
    if history_ref.raw_size == 0 {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(
            "identity session history rawSize must be positive".into(),
        ));
    }
    if history_ref.encoded_size == 0 {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(
            "identity session history encodedSize must be positive".into(),
        ));
    }
    if history_ref.raw_size > RESUME_SESSION_HISTORY_MAX_BYTES {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(format!(
            "session history is too large: {} bytes exceeds {RESUME_SESSION_HISTORY_MAX_BYTES} bytes",
            history_ref.raw_size
        )));
    }
    if history_ref.encoded_size > RESUME_SESSION_HISTORY_MAX_BYTES {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(format!(
            "session history encoded object is too large: {} bytes exceeds {RESUME_SESSION_HISTORY_MAX_BYTES} bytes",
            history_ref.encoded_size
        )));
    }
    if history_ref.raw_size != history_ref.encoded_size {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(format!(
            "identity session history rawSize must match encodedSize: rawSize={}, encodedSize={}",
            history_ref.raw_size, history_ref.encoded_size
        )));
    }
    Ok(())
}

fn validate_compressed_ref(
    encoding: &str,
    history_ref: &ResumeSessionHistoryRef,
    timings: &mut SessionHistoryDownloadTimings,
) -> RunnerResult<u64> {
    let validation_started = Instant::now();
    let raw_size = history_ref.raw_size;
    if raw_size == 0 {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(format!(
            "{encoding} session history rawSize must be positive"
        )));
    }
    if raw_size > RESUME_SESSION_HISTORY_MAX_BYTES {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(format!(
            "session history rawSize is too large: {raw_size} bytes exceeds {RESUME_SESSION_HISTORY_MAX_BYTES} bytes"
        )));
    }
    if history_ref.encoded_size == 0 {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(format!(
            "{encoding} session history encodedSize must be positive"
        )));
    }
    if history_ref.encoded_size > RESUME_SESSION_HISTORY_MAX_BYTES {
        timings.add_validation(validation_started.elapsed(), false);
        return Err(RunnerError::Internal(format!(
            "session history encoded object is too large: {} bytes exceeds {RESUME_SESSION_HISTORY_MAX_BYTES} bytes",
            history_ref.encoded_size
        )));
    }
    Ok(raw_size)
}

async fn download_body(
    http: &HttpClient,
    url: &str,
    expected_size: Option<u64>,
    cancel: &CancellationToken,
    timings: &mut SessionHistoryDownloadTimings,
) -> RunnerResult<Vec<u8>> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(session_history_download_cancelled_error()),
        result = download_body_once(http, url, expected_size, timings) => result.map_err(SessionHistoryDownloadBodyError::into_runner_error),
    }
}

fn session_history_download_cancelled_error() -> RunnerError {
    RunnerError::Cancelled
}

async fn download_body_once(
    http: &HttpClient,
    url: &str,
    expected_size: Option<u64>,
    timings: &mut SessionHistoryDownloadTimings,
) -> Result<Vec<u8>, SessionHistoryDownloadBodyError> {
    let request_started = Instant::now();
    let response = http
        .get(url)
        .timeout(OBJECT_DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|error| SessionHistoryDownloadBodyError::from_reqwest("GET", url, error))?;
    if let Err(error) = response.error_for_status_ref() {
        timings.record_request_status(request_started.elapsed(), false);
        return Err(SessionHistoryDownloadBodyError::from_reqwest(
            "GET status",
            url,
            error,
        ));
    }
    timings.record_request_status(request_started.elapsed(), true);
    let mut response = response;

    let response_metadata = session_history_response_metadata(&response, expected_size);
    timings.record_response_metadata(response_metadata);

    let validation_started = Instant::now();
    if let Some(content_length) = response.content_length() {
        if content_length > RESUME_SESSION_HISTORY_MAX_BYTES {
            timings.add_validation(validation_started.elapsed(), false);
            return Err(SessionHistoryDownloadBodyError::downloaded_too_large(
                format!(
                    "session history is too large: {content_length} bytes exceeds {RESUME_SESSION_HISTORY_MAX_BYTES} bytes",
                ),
            ));
        }
        if let Some(expected_size) = expected_size
            && content_length != expected_size
        {
            timings.add_validation(validation_started.elapsed(), false);
            return Err(SessionHistoryDownloadBodyError::content_length_mismatch(
                format!(
                    "session history content-length mismatch: expected {expected_size} bytes, got {content_length} bytes",
                ),
            ));
        }
    }
    timings.add_validation(validation_started.elapsed(), true);

    let capacity = expected_size
        .unwrap_or(64 * 1024)
        .min(RESUME_SESSION_HISTORY_MAX_BYTES)
        .min(usize::MAX as u64) as usize;
    let mut body = Vec::with_capacity(capacity);
    let mut downloaded = 0u64;
    let body_started = Instant::now();
    while let Some(chunk) = match response.chunk().await {
        Ok(chunk) => chunk,
        Err(error) => {
            timings.record_body_read(body_started.elapsed(), false);
            return Err(SessionHistoryDownloadBodyError::from_reqwest(
                "read", url, error,
            ));
        }
    } {
        downloaded += chunk.len() as u64;
        if let Some(expected_size) = expected_size
            && downloaded > expected_size
        {
            timings.record_body_read(body_started.elapsed(), false);
            return Err(SessionHistoryDownloadBodyError::downloaded_size_mismatch(
                format!(
                    "session history downloaded size mismatch: expected {expected_size} bytes, got more than {expected_size} bytes",
                ),
            ));
        }
        if downloaded > RESUME_SESSION_HISTORY_MAX_BYTES {
            timings.record_body_read(body_started.elapsed(), false);
            return Err(SessionHistoryDownloadBodyError::downloaded_too_large(
                format!(
                    "session history is too large: {downloaded} bytes exceeds {RESUME_SESSION_HISTORY_MAX_BYTES} bytes",
                ),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    if let Some(expected_size) = expected_size
        && downloaded != expected_size
    {
        timings.record_body_read(body_started.elapsed(), false);
        return Err(SessionHistoryDownloadBodyError::downloaded_size_mismatch(
            format!(
                "session history downloaded size mismatch: expected {expected_size} bytes, got {downloaded} bytes",
            ),
        ));
    }
    timings.record_body_read(body_started.elapsed(), true);

    Ok(body)
}

#[derive(Debug)]
struct SessionHistoryDownloadBodyError {
    message: String,
}

impl SessionHistoryDownloadBodyError {
    fn content_length_mismatch(message: String) -> Self {
        Self { message }
    }

    fn downloaded_size_mismatch(message: String) -> Self {
        Self { message }
    }

    fn downloaded_too_large(message: String) -> Self {
        Self { message }
    }

    fn from_reqwest(phase: &str, url: &str, error: reqwest::Error) -> Self {
        Self {
            message: format!("{phase} {}: {}", redact_url_query(url), error.without_url()),
        }
    }

    fn into_runner_error(self) -> RunnerError {
        RunnerError::Internal(self.message)
    }
}

impl fmt::Display for SessionHistoryDownloadBodyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

fn session_history_response_metadata(
    response: &reqwest::Response,
    expected_size: Option<u64>,
) -> SessionHistoryResponseTelemetryMetadata {
    SessionHistoryResponseTelemetryMetadata::new(
        content_length_state(response.content_length(), expected_size),
        content_encoding_state(response.headers()),
        transfer_encoding_state(response.headers()),
    )
}

fn content_length_state(
    content_length: Option<u64>,
    expected_size: Option<u64>,
) -> SessionHistoryContentLengthState {
    let Some(content_length) = content_length else {
        return SessionHistoryContentLengthState::Absent;
    };
    if content_length > RESUME_SESSION_HISTORY_MAX_BYTES {
        return SessionHistoryContentLengthState::Oversized;
    }
    let Some(expected_size) = expected_size else {
        return SessionHistoryContentLengthState::PresentWithoutExpected;
    };
    if content_length == expected_size {
        SessionHistoryContentLengthState::MatchesExpected
    } else {
        SessionHistoryContentLengthState::MismatchesExpected
    }
}

fn content_encoding_state(
    headers: &reqwest::header::HeaderMap,
) -> SessionHistoryContentEncodingState {
    let values = headers.get_all(CONTENT_ENCODING);
    let mut saw_header = false;
    for value in values {
        saw_header = true;
        let Ok(value) = value.to_str() else {
            return SessionHistoryContentEncodingState::Other;
        };
        for item in value.split(',').map(str::trim) {
            if item.eq_ignore_ascii_case("gzip") {
                return SessionHistoryContentEncodingState::Gzip;
            }
            if item.eq_ignore_ascii_case("zstd") {
                return SessionHistoryContentEncodingState::Zstd;
            }
        }
    }
    if !saw_header {
        return SessionHistoryContentEncodingState::Absent;
    }
    SessionHistoryContentEncodingState::Other
}

fn transfer_encoding_state(
    headers: &reqwest::header::HeaderMap,
) -> SessionHistoryTransferEncodingState {
    let values = headers.get_all(TRANSFER_ENCODING);
    let mut saw_header = false;
    for value in values {
        saw_header = true;
        let Ok(value) = value.to_str() else {
            return SessionHistoryTransferEncodingState::Other;
        };
        if value
            .split(',')
            .map(str::trim)
            .any(|item| item.eq_ignore_ascii_case("chunked"))
        {
            return SessionHistoryTransferEncodingState::Chunked;
        }
    }
    if !saw_header {
        return SessionHistoryTransferEncodingState::Absent;
    }
    SessionHistoryTransferEncodingState::Other
}

fn redact_url_query(url: &str) -> String {
    let Some(query_start) = url.find('?') else {
        return url.to_string();
    };
    let fragment = url[query_start + 1..].find('#').map(|index| {
        let fragment_start = query_start + 1 + index;
        &url[fragment_start..]
    });
    match fragment {
        Some(fragment) => format!("{}?<redacted>{fragment}", &url[..query_start]),
        None => format!("{}?<redacted>", &url[..query_start]),
    }
}

#[cfg(test)]
mod tests {
    use std::io::{self, Write};

    use flate2::{Compression, write::GzEncoder};
    use sha2::{Digest, Sha256};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;
    use tokio::task::JoinHandle;

    use super::*;
    use crate::http::{HttpClient, HttpClientConfig};
    use crate::restored_session_identity::RestoredSessionHistoryPrefixAttribution;
    use crate::test_fixtures::session_history::OneShotSessionHistoryServer;
    use crate::types::{
        ResumeSessionHistory, ResumeSessionHistoryEncoding, ResumeSessionHistoryRef,
        ResumeSessionHistoryRefKind,
    };

    fn http_client() -> HttpClient {
        HttpClient::new(HttpClientConfig {
            api_url: "http://localhost".to_string(),
            vercel_bypass: None,
            client_session_id: "runner-session-test".to_string(),
        })
        .unwrap()
    }

    fn ref_session(url: String, hash: String, raw_size: u64, encoded_size: u64) -> ResumeSession {
        ResumeSession {
            cli_agent_session_id: "sess-123".to_string(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: ResumeSessionHistoryRefKind::Blob,
                    hash,
                    url,
                    encoding: ResumeSessionHistoryEncoding::Identity,
                    raw_size,
                    encoded_size,
                    download_source: None,
                },
            },
        }
    }

    fn gzip_ref_session(
        url: String,
        hash: String,
        raw_size: u64,
        encoded_size: u64,
    ) -> ResumeSession {
        compressed_ref_session(
            url,
            hash,
            raw_size,
            encoded_size,
            ResumeSessionHistoryEncoding::Gzip,
        )
    }

    fn zstd_ref_session(
        url: String,
        hash: String,
        raw_size: u64,
        encoded_size: u64,
    ) -> ResumeSession {
        compressed_ref_session(
            url,
            hash,
            raw_size,
            encoded_size,
            ResumeSessionHistoryEncoding::Zstd,
        )
    }

    fn compressed_ref_session(
        url: String,
        hash: String,
        raw_size: u64,
        encoded_size: u64,
        encoding: ResumeSessionHistoryEncoding,
    ) -> ResumeSession {
        ResumeSession {
            cli_agent_session_id: "sess-123".to_string(),
            history: ResumeSessionHistory::Ref {
                history_ref: ResumeSessionHistoryRef {
                    kind: ResumeSessionHistoryRefKind::Blob,
                    hash,
                    url,
                    encoding,
                    raw_size,
                    encoded_size,
                    download_source: None,
                },
            },
        }
    }

    fn gzip_bytes(raw: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(raw).unwrap();
        encoder.finish().unwrap()
    }

    fn zstd_bytes(raw: &[u8]) -> Vec<u8> {
        zstd::encode_all(raw, 0).unwrap()
    }

    fn start_materializer_with_framework(
        session: &ResumeSession,
        framework: EffectiveCliFramework,
    ) -> SessionHistoryMaterializer {
        let cpu = SessionHistoryCpuPool::with_capacity(1);
        start_materializer_with_cpu(session, framework, &cpu)
    }

    fn start_materializer_with_cpu(
        session: &ResumeSession,
        framework: EffectiveCliFramework,
        cpu: &SessionHistoryCpuPool,
    ) -> SessionHistoryMaterializer {
        SessionHistoryMaterializer::start_cancellable(
            &http_client(),
            cpu,
            Some(session),
            framework,
            CancellationToken::new(),
            None,
        )
    }

    fn start_materializer(session: &ResumeSession) -> SessionHistoryMaterializer {
        start_materializer_with_framework(session, EffectiveCliFramework::ClaudeCode)
    }

    fn prefix_attribution(local_history: &[u8]) -> RestoredSessionHistoryPrefixAttribution {
        RestoredSessionHistoryPrefixAttribution::for_test(
            hex::encode(Sha256::digest(local_history)),
            local_history.len() as u64,
        )
    }

    fn start_materializer_with_prefix_attribution(
        session: &ResumeSession,
        framework: EffectiveCliFramework,
        prefix_attribution: RestoredSessionHistoryPrefixAttribution,
    ) -> SessionHistoryMaterializer {
        SessionHistoryMaterializer::start_cancellable_with_prefix_attribution(
            &http_client(),
            &SessionHistoryCpuPool::with_capacity(1),
            Some(session),
            framework,
            CancellationToken::new(),
            None,
            prefix_attribution,
        )
    }

    fn identity_metadata() -> SessionHistoryTelemetryMetadata {
        let session = ref_session(
            "http://127.0.0.1/history.blob".to_string(),
            hex::encode(Sha256::digest(b"")),
            1,
            1,
        );
        SessionHistoryTelemetryMetadata::from_ref(session.history_ref().unwrap())
    }

    fn assert_phase_success(phase: Option<SessionHistoryDownloadPhaseTiming>) {
        let phase = phase.expect("phase should be recorded");
        assert!(phase.success(), "phase should succeed: {phase:?}");
    }

    fn assert_phase_failure(phase: Option<SessionHistoryDownloadPhaseTiming>) {
        let phase = phase.expect("phase should be recorded");
        assert!(!phase.success(), "phase should fail: {phase:?}");
    }

    fn assert_no_phase(phase: Option<SessionHistoryDownloadPhaseTiming>) {
        assert!(phase.is_none(), "phase should not be recorded: {phase:?}");
    }

    fn assert_response_metadata(
        timings: &SessionHistoryDownloadTimings,
        content_length_state: SessionHistoryContentLengthState,
        content_encoding_state: SessionHistoryContentEncodingState,
        transfer_encoding_state: SessionHistoryTransferEncodingState,
    ) {
        let metadata = timings
            .response_metadata()
            .expect("response metadata should be recorded");
        assert_eq!(metadata.content_length_state(), content_length_state);
        assert_eq!(metadata.content_encoding_state(), content_encoding_state);
        assert_eq!(metadata.transfer_encoding_state(), transfer_encoding_state);
    }

    #[test]
    fn probe_reports_recent_and_inflight_refs() {
        let probe = SessionHistoryProbe::with_limits_for_test(Duration::from_secs(60), 8);
        let session = ref_session(
            "http://127.0.0.1/history.blob".to_string(),
            hex::encode(Sha256::digest(b"history")),
            7,
            7,
        );
        let history_ref = session.history_ref().unwrap();

        let first = probe.observe(history_ref);
        assert_eq!(
            first.observation(),
            SessionHistoryCacheProbeMetadata::new(false, false)
        );

        let second = probe.observe(history_ref);
        assert_eq!(
            second.observation(),
            SessionHistoryCacheProbeMetadata::new(true, true)
        );

        first.finish();
        second.finish();
        let third = probe.observe(history_ref);
        assert_eq!(
            third.observation(),
            SessionHistoryCacheProbeMetadata::new(true, false)
        );
        third.finish();
    }

    #[test]
    fn probe_registration_drop_clears_inflight_ref() {
        let probe = SessionHistoryProbe::with_limits_for_test(Duration::from_secs(60), 8);
        let session = ref_session(
            "http://127.0.0.1/drop.blob".to_string(),
            hex::encode(Sha256::digest(b"drop")),
            4,
            4,
        );
        let history_ref = session.history_ref().unwrap();

        let registration = probe.observe(history_ref);
        let overlapping = probe.observe(history_ref);
        assert_eq!(
            overlapping.observation(),
            SessionHistoryCacheProbeMetadata::new(true, true)
        );
        overlapping.finish();
        drop(registration);
        let repeated = probe.observe(history_ref);

        assert_eq!(
            repeated.observation(),
            SessionHistoryCacheProbeMetadata::new(true, false)
        );
        repeated.finish();
    }

    #[test]
    fn probe_eviction_removes_old_ref_identity() {
        let probe = SessionHistoryProbe::with_limits_for_test(Duration::from_secs(60), 1);
        let first_session = ref_session(
            "http://127.0.0.1/first.blob".to_string(),
            hex::encode(Sha256::digest(b"first")),
            5,
            5,
        );
        let second_session = ref_session(
            "http://127.0.0.1/second.blob".to_string(),
            hex::encode(Sha256::digest(b"second")),
            6,
            6,
        );
        let first_ref = first_session.history_ref().unwrap();
        let second_ref = second_session.history_ref().unwrap();

        let first = probe.observe(first_ref);
        first.finish();
        let second = probe.observe(second_ref);
        second.finish();
        let repeated_first = probe.observe(first_ref);

        assert_eq!(
            repeated_first.observation(),
            SessionHistoryCacheProbeMetadata::new(false, false)
        );
        repeated_first.finish();
    }

    #[test]
    fn probe_capacity_eviction_preserves_inflight_ref_when_possible() {
        let probe = SessionHistoryProbe::with_limits_for_test(Duration::from_secs(60), 2);
        let active_session = ref_session(
            "http://127.0.0.1/active.blob".to_string(),
            hex::encode(Sha256::digest(b"active")),
            6,
            6,
        );
        let idle_session = ref_session(
            "http://127.0.0.1/idle.blob".to_string(),
            hex::encode(Sha256::digest(b"idle")),
            4,
            4,
        );
        let new_session = ref_session(
            "http://127.0.0.1/new.blob".to_string(),
            hex::encode(Sha256::digest(b"new")),
            3,
            3,
        );
        let active_ref = active_session.history_ref().unwrap();
        let idle_ref = idle_session.history_ref().unwrap();
        let new_ref = new_session.history_ref().unwrap();

        let active = probe.observe(active_ref);
        let idle = probe.observe(idle_ref);
        idle.finish();
        let new = probe.observe(new_ref);
        new.finish();

        let repeated_active = probe.observe(active_ref);
        assert_eq!(
            repeated_active.observation(),
            SessionHistoryCacheProbeMetadata::new(true, true)
        );
        repeated_active.finish();
        active.finish();
    }

    async fn serve_once(
        status: &'static str,
        body: impl Into<Vec<u8>> + Send + 'static,
        content_length: Option<u64>,
    ) -> OneShotSessionHistoryServer {
        OneShotSessionHistoryServer::respond_once(status, body, content_length).await
    }

    struct MultiShotSessionHistoryServer {
        url: String,
        task: Option<JoinHandle<io::Result<usize>>>,
    }

    #[derive(Clone)]
    struct MultiShotSessionHistoryResponse {
        status: &'static str,
        body: Vec<u8>,
        content_length: Option<u64>,
    }

    impl MultiShotSessionHistoryResponse {
        fn new(
            status: &'static str,
            body: impl Into<Vec<u8>>,
            content_length: Option<u64>,
        ) -> Self {
            Self {
                status,
                body: body.into(),
                content_length,
            }
        }

        fn ok(body: impl Into<Vec<u8>>, content_length: Option<u64>) -> Self {
            Self::new("200 OK", body, content_length)
        }

        fn status(status: &'static str) -> Self {
            Self::new(status, Vec::new(), Some(0))
        }
    }

    impl MultiShotSessionHistoryServer {
        async fn respond_many(responses: Vec<MultiShotSessionHistoryResponse>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let task = tokio::spawn(serve_session_history_many(listener, responses));

            Self {
                url: format!("http://{address}/history.blob?token=secret"),
                task: Some(task),
            }
        }

        fn url(&self) -> String {
            self.url.clone()
        }

        async fn assert_served(mut self, expected_requests: usize) {
            let mut task = self
                .task
                .take()
                .expect("session history fixture task should be present");
            match tokio::time::timeout(Duration::from_secs(5), &mut task).await {
                Ok(result) => {
                    let served = result
                        .expect("session history fixture server task should not panic")
                        .expect("session history fixture server should not fail");
                    assert_eq!(served, expected_requests);
                }
                Err(_) => {
                    task.abort();
                    let _ = task.await;
                    panic!("session history fixture server should finish");
                }
            }
        }
    }

    impl Drop for MultiShotSessionHistoryServer {
        fn drop(&mut self) {
            if let Some(task) = self.task.take() {
                task.abort();
            }
        }
    }

    async fn serve_session_history_many(
        listener: TcpListener,
        responses: Vec<MultiShotSessionHistoryResponse>,
    ) -> io::Result<usize> {
        let mut served = 0usize;
        for response in responses {
            let (mut stream, _) = listener.accept().await?;
            let mut request = [0u8; 1024];
            let request_bytes = stream.read(&mut request).await?;
            if request_bytes == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "session history fixture received an empty request",
                ));
            }

            let content_length_header = response
                .content_length
                .map(|content_length| format!("Content-Length: {content_length}\r\n"))
                .unwrap_or_default();
            let response_head = format!(
                "HTTP/1.1 {}\r\n{content_length_header}Connection: close\r\n\r\n",
                response.status
            );
            stream.write_all(response_head.as_bytes()).await?;
            stream.write_all(&response.body).await?;
            stream.shutdown().await?;
            served += 1;
        }
        Ok(served)
    }

    #[tokio::test]
    async fn materializer_downloads_and_verifies_hash() {
        let body = b"{\"type\":\"init\"}\n\xff\n";
        let hash = hex::encode(Sha256::digest(body));
        let server = serve_once("200 OK", body, Some(body.len() as u64)).await;
        let session = ref_session(server.url(), hash, body.len() as u64, body.len() as u64);

        let materializer = start_materializer(&session);
        let result = materializer.finish(&CancellationToken::new()).await;

        match result {
            SessionHistoryMaterialization::Downloaded {
                session, timings, ..
            } => {
                assert_eq!(session.cli_agent_session_id(), "sess-123");
                assert_eq!(session.history_bytes(), body);
                assert_phase_success(timings.request_status());
                assert_phase_success(timings.body_read());
                assert_phase_success(timings.validation());
                assert_no_phase(timings.decompression());
                assert_phase_success(timings.hash_verification());
                assert_response_metadata(
                    &timings,
                    SessionHistoryContentLengthState::MatchesExpected,
                    SessionHistoryContentEncodingState::Absent,
                    SessionHistoryTransferEncodingState::Absent,
                );
            }
            _ => panic!("expected downloaded session"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn materializer_attributes_verified_and_divergent_raw_prefixes() {
        let requested_history = b"prefix\nextension\n";
        let cases: [(&[u8], bool); 2] = [(b"prefix\n", true), (b"differ\n", false)];

        for (local_history, expected_verified) in cases {
            let hash = hex::encode(Sha256::digest(requested_history));
            let server = serve_once(
                "200 OK",
                requested_history,
                Some(requested_history.len() as u64),
            )
            .await;
            let session = ref_session(
                server.url(),
                hash,
                requested_history.len() as u64,
                requested_history.len() as u64,
            );

            let result = start_materializer_with_prefix_attribution(
                &session,
                EffectiveCliFramework::ClaudeCode,
                prefix_attribution(local_history),
            )
            .finish(&CancellationToken::new())
            .await;

            match result {
                SessionHistoryMaterialization::Downloaded {
                    session,
                    prefix_outcome,
                    ..
                } => {
                    assert_eq!(session.history_bytes(), requested_history);
                    match prefix_outcome {
                        Some(SessionHistoryPrefixOutcome::Verified { raw_extension_size })
                            if expected_verified =>
                        {
                            assert_eq!(
                                raw_extension_size,
                                (requested_history.len() - local_history.len()) as u64
                            );
                        }
                        Some(SessionHistoryPrefixOutcome::Divergent) if !expected_verified => {}
                        _ => panic!("unexpected prefix attribution outcome"),
                    }
                }
                _ => panic!("expected downloaded session"),
            }
            server.assert_served().await;
        }
    }

    #[tokio::test]
    async fn codex_identity_materializer_extracts_raw_timestamp() {
        let body =
            b"{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-07-13T01:02:03Z\"}}\n";
        let hash = hex::encode(Sha256::digest(body));
        let server = serve_once("200 OK", body, Some(body.len() as u64)).await;
        let session = ref_session(server.url(), hash, body.len() as u64, body.len() as u64);

        let result = start_materializer_with_framework(&session, EffectiveCliFramework::Codex)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Downloaded { session, .. } => {
                assert_eq!(session.history_bytes(), body);
                assert_eq!(
                    session
                        .codex_timestamp()
                        .map(|timestamp| timestamp.to_rfc3339())
                        .as_deref(),
                    Some("2026-07-13T01:02:03+00:00")
                );
            }
            _ => panic!("expected downloaded session"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn materializer_records_response_content_encoding_state() {
        let body = b"{\"type\":\"init\"}\n";
        let hash = hex::encode(Sha256::digest(body));
        let server = OneShotSessionHistoryServer::respond_once_with_headers(
            "200 OK",
            body,
            Some(body.len() as u64),
            vec![("Content-Encoding", "gzip")],
        )
        .await;
        let session = ref_session(server.url(), hash, body.len() as u64, body.len() as u64);

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Downloaded { timings, .. } => {
                assert_response_metadata(
                    &timings,
                    SessionHistoryContentLengthState::MatchesExpected,
                    SessionHistoryContentEncodingState::Gzip,
                    SessionHistoryTransferEncodingState::Absent,
                );
            }
            _ => panic!("expected downloaded session"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn materializer_records_chunked_transfer_response_metadata() {
        let body = b"{\"type\":\"init\"}\n";
        let hash = hex::encode(Sha256::digest(body));
        let server =
            OneShotSessionHistoryServer::respond_once_chunked("200 OK", body.to_vec()).await;
        let session = ref_session(server.url(), hash, body.len() as u64, body.len() as u64);

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Downloaded { timings, .. } => {
                assert_response_metadata(
                    &timings,
                    SessionHistoryContentLengthState::Absent,
                    SessionHistoryContentEncodingState::Absent,
                    SessionHistoryTransferEncodingState::Chunked,
                );
            }
            _ => panic!("expected downloaded session"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn materializer_rejects_identity_ref_with_zero_size() {
        let hash = hex::encode(Sha256::digest([]));
        let session = ref_session(
            "http://127.0.0.1:9/history.blob?token=secret".to_string(),
            hash,
            0,
            0,
        );

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(
                    error.to_string().contains("rawSize must be positive"),
                    "unexpected error: {error}"
                );
                assert_no_phase(timings.request_status());
                assert_no_phase(timings.body_read());
                assert_phase_failure(timings.validation());
                assert_no_phase(timings.decompression());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected failed materialization"),
        }
    }

    #[tokio::test]
    async fn materializer_rejects_compressed_ref_with_invalid_metadata() {
        struct InvalidMetadataCase {
            name: &'static str,
            raw_size: u64,
            encoded_size: u64,
            expected_error_substrings: &'static [&'static str],
        }

        let valid_raw_size = 16;
        let valid_encoded_size = 32;
        let scenarios = [
            (
                ResumeSessionHistoryEncoding::Gzip,
                EffectiveCliFramework::ClaudeCode,
                "gzip",
                "gzip ClaudeCode",
            ),
            (
                ResumeSessionHistoryEncoding::Zstd,
                EffectiveCliFramework::ClaudeCode,
                "zstd",
                "zstd ClaudeCode",
            ),
            (
                ResumeSessionHistoryEncoding::Zstd,
                EffectiveCliFramework::Codex,
                "zstd",
                "zstd Codex",
            ),
        ];
        let metadata_cases = [
            InvalidMetadataCase {
                name: "zero rawSize",
                raw_size: 0,
                encoded_size: valid_encoded_size,
                expected_error_substrings: &["rawSize must be positive"],
            },
            InvalidMetadataCase {
                name: "oversized rawSize",
                raw_size: RESUME_SESSION_HISTORY_MAX_BYTES + 1,
                encoded_size: valid_encoded_size,
                expected_error_substrings: &["rawSize", "too large"],
            },
            InvalidMetadataCase {
                name: "zero encodedSize",
                raw_size: valid_raw_size,
                encoded_size: 0,
                expected_error_substrings: &["encodedSize must be positive"],
            },
            InvalidMetadataCase {
                name: "oversized encodedSize",
                raw_size: valid_raw_size,
                encoded_size: RESUME_SESSION_HISTORY_MAX_BYTES + 1,
                expected_error_substrings: &["encoded", "too large"],
            },
        ];

        for (encoding, framework, expected_encoding, scenario_name) in scenarios {
            for case in &metadata_cases {
                let session = compressed_ref_session(
                    "http://127.0.0.1:9/history.blob?token=secret".to_string(),
                    hex::encode(Sha256::digest([])),
                    case.raw_size,
                    case.encoded_size,
                    encoding,
                );

                let result = start_materializer_with_framework(&session, framework)
                    .finish(&CancellationToken::new())
                    .await;

                match result {
                    SessionHistoryMaterialization::Failed { error, timings, .. } => {
                        let message = error.to_string();
                        for expected in case.expected_error_substrings {
                            assert!(
                                message.contains(expected),
                                "{} {}: expected error to contain {expected:?}, got {message:?}",
                                scenario_name,
                                case.name
                            );
                        }
                        assert_eq!(timings.encoding(), Some(expected_encoding));
                        assert_no_phase(timings.request_status());
                        assert_no_phase(timings.body_read());
                        assert_phase_failure(timings.validation());
                        assert_no_phase(timings.hash_verification());
                    }
                    _ => panic!(
                        "{scenario_name} {}: expected failed materialization",
                        case.name
                    ),
                }
            }
        }
    }

    #[tokio::test]
    async fn materializer_downloads_decompresses_and_verifies_gzip_hash() {
        let body = b"{\"type\":\"init\"}\n{\"type\":\"user\",\"message\":\"hello\"}\n";
        let compressed = gzip_bytes(body);
        let encoded_size = compressed.len() as u64;
        let hash = hex::encode(Sha256::digest(body));
        let server = serve_once("200 OK", compressed, None).await;
        let session = gzip_ref_session(server.url(), hash, body.len() as u64, encoded_size);

        let materializer = start_materializer(&session);
        let result = materializer.finish(&CancellationToken::new()).await;

        match result {
            SessionHistoryMaterialization::Downloaded {
                session, timings, ..
            } => {
                assert_eq!(session.cli_agent_session_id(), "sess-123");
                assert_eq!(session.history_bytes(), body);
                assert_phase_success(timings.request_status());
                assert_phase_success(timings.body_read());
                assert_phase_success(timings.validation());
                assert_phase_success(timings.decompression());
                assert_phase_success(timings.hash_verification());
                assert_response_metadata(
                    &timings,
                    SessionHistoryContentLengthState::Absent,
                    SessionHistoryContentEncodingState::Absent,
                    SessionHistoryTransferEncodingState::Absent,
                );
            }
            _ => panic!("expected downloaded session"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn codex_gzip_materializer_extracts_raw_timestamp() {
        let body =
            b"{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-07-13T02:03:04Z\"}}\n";
        let compressed = gzip_bytes(body);
        let encoded_size = compressed.len() as u64;
        let hash = hex::encode(Sha256::digest(body));
        let server = serve_once("200 OK", compressed, None).await;
        let session = gzip_ref_session(server.url(), hash, body.len() as u64, encoded_size);

        let result = start_materializer_with_framework(&session, EffectiveCliFramework::Codex)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Downloaded { session, .. } => {
                assert_eq!(session.history_bytes(), body);
                assert_eq!(
                    session
                        .codex_timestamp()
                        .map(|timestamp| timestamp.to_rfc3339())
                        .as_deref(),
                    Some("2026-07-13T02:03:04+00:00")
                );
            }
            _ => panic!("expected downloaded session"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn materializer_downloads_decompresses_and_verifies_zstd_hash() {
        let body = b"{\"type\":\"init\"}\n{\"type\":\"user\",\"message\":\"hello\"}\n";
        let compressed = zstd_bytes(body);
        let encoded_size = compressed.len() as u64;
        let hash = hex::encode(Sha256::digest(body));
        let server = serve_once("200 OK", compressed, None).await;
        let session = zstd_ref_session(server.url(), hash, body.len() as u64, encoded_size);

        let materializer = start_materializer(&session);
        let result = materializer.finish(&CancellationToken::new()).await;

        match result {
            SessionHistoryMaterialization::Downloaded {
                session, timings, ..
            } => {
                assert_eq!(session.cli_agent_session_id(), "sess-123");
                assert_eq!(session.history_bytes(), body);
                assert_phase_success(timings.request_status());
                assert_phase_success(timings.body_read());
                assert_phase_success(timings.validation());
                assert_phase_success(timings.decompression());
                assert_phase_success(timings.hash_verification());
            }
            _ => panic!("expected downloaded session"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn compressed_materializers_preserve_complete_validation_with_prefix_attribution() {
        let body = b"prefix\nextension\n";
        let local_history = b"prefix\n";
        let representations = [
            (ResumeSessionHistoryEncoding::Gzip, gzip_bytes(body)),
            (ResumeSessionHistoryEncoding::Zstd, zstd_bytes(body)),
        ];

        for (encoding, compressed) in representations {
            let encoded_size = compressed.len() as u64;
            let server = serve_once("200 OK", compressed, None).await;
            let session = compressed_ref_session(
                server.url(),
                hex::encode(Sha256::digest(body)),
                body.len() as u64,
                encoded_size,
                encoding,
            );

            let result = start_materializer_with_prefix_attribution(
                &session,
                EffectiveCliFramework::ClaudeCode,
                prefix_attribution(local_history),
            )
            .finish(&CancellationToken::new())
            .await;

            match result {
                SessionHistoryMaterialization::Downloaded {
                    session,
                    prefix_outcome:
                        Some(SessionHistoryPrefixOutcome::Verified { raw_extension_size }),
                    ..
                } => {
                    assert_eq!(session.history_bytes(), body);
                    assert_eq!(
                        raw_extension_size,
                        (body.len() - local_history.len()) as u64
                    );
                }
                _ => panic!("expected verified attributed compressed session"),
            }
            server.assert_served().await;
        }
    }

    #[tokio::test]
    async fn codex_materializer_preserves_verified_zstd_history() {
        let body =
            b"{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-07-02T10:00:00Z\"}}\n";
        let compressed = zstd_bytes(body);
        let encoded_size = compressed.len() as u64;
        let hash = hex::encode(Sha256::digest(body));
        let server = serve_once("200 OK", compressed.clone(), None).await;
        let session = zstd_ref_session(server.url(), hash, body.len() as u64, encoded_size);

        let materializer =
            start_materializer_with_framework(&session, EffectiveCliFramework::Codex);
        let result = materializer.finish(&CancellationToken::new()).await;

        match result {
            SessionHistoryMaterialization::Downloaded {
                session, timings, ..
            } => {
                assert_eq!(session.cli_agent_session_id(), "sess-123");
                assert_eq!(session.history_bytes(), compressed);
                session
                    .codex_zstd_history()
                    .expect("codex zstd history should be preserved");
                assert_eq!(
                    session
                        .codex_timestamp()
                        .map(|timestamp| timestamp.to_rfc3339())
                        .as_deref(),
                    Some("2026-07-02T10:00:00+00:00")
                );
                assert_phase_success(timings.request_status());
                assert_phase_success(timings.body_read());
                assert_phase_success(timings.validation());
                assert_phase_success(timings.decompression());
                assert_phase_success(timings.hash_verification());
            }
            _ => panic!("expected downloaded session"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn codex_zstd_timestamp_scan_recovers_after_an_oversized_record() {
        const TIMESTAMP_RECORD_LIMIT: usize = 128;

        let oversized_record = format!(
            "{{\"type\":\"not_meta\",\"padding\":\"{}\"}}",
            "x".repeat(TIMESTAMP_RECORD_LIMIT)
        );
        assert!(oversized_record.len() > TIMESTAMP_RECORD_LIMIT);
        let metadata = r#"{"type":"session_meta","payload":{"timestamp":"2026-07-02T10:00:00Z"}}"#;
        assert!(metadata.len() <= TIMESTAMP_RECORD_LIMIT);
        let body = format!("{oversized_record}\r\n{metadata}\r\n");
        let compressed = zstd_bytes(body.as_bytes());
        let encoded_size = compressed.len() as u64;
        let server = serve_once("200 OK", compressed.clone(), None).await;
        let session = zstd_ref_session(
            server.url(),
            hex::encode(Sha256::digest(body.as_bytes())),
            body.len() as u64,
            encoded_size,
        );
        let cpu = SessionHistoryCpuPool::with_test_codex_timestamp_record_max_bytes(
            1,
            TIMESTAMP_RECORD_LIMIT,
        );

        let result = start_materializer_with_cpu(&session, EffectiveCliFramework::Codex, &cpu)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Downloaded {
                session, timings, ..
            } => {
                assert_eq!(session.history_bytes(), compressed);
                assert_eq!(
                    session
                        .codex_timestamp()
                        .map(|timestamp| timestamp.to_rfc3339())
                        .as_deref(),
                    Some("2026-07-02T10:00:00+00:00")
                );
                assert_phase_success(timings.decompression());
                assert_phase_success(timings.hash_verification());
            }
            _ => panic!("expected downloaded session"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn codex_zstd_unterminated_record_preserves_the_declared_raw_size_boundary() {
        const TIMESTAMP_RECORD_LIMIT: usize = 16;

        let body = vec![b'x'; 65];
        let compressed = zstd_bytes(&body);
        for expected_raw_size in [body.len() as u64, body.len() as u64 - 1] {
            let server = serve_once("200 OK", compressed.clone(), None).await;
            let session = zstd_ref_session(
                server.url(),
                hex::encode(Sha256::digest(&body)),
                expected_raw_size,
                compressed.len() as u64,
            );
            let cpu = SessionHistoryCpuPool::with_test_codex_timestamp_record_max_bytes(
                1,
                TIMESTAMP_RECORD_LIMIT,
            );

            let result = start_materializer_with_cpu(&session, EffectiveCliFramework::Codex, &cpu)
                .finish(&CancellationToken::new())
                .await;

            if expected_raw_size == body.len() as u64 {
                match result {
                    SessionHistoryMaterialization::Downloaded {
                        session, timings, ..
                    } => {
                        assert_eq!(session.history_bytes(), compressed);
                        assert!(session.codex_timestamp().is_none());
                        assert_phase_success(timings.decompression());
                        assert_phase_success(timings.hash_verification());
                    }
                    _ => panic!("expected downloaded session"),
                }
            } else {
                match result {
                    SessionHistoryMaterialization::Failed { error, timings, .. } => {
                        assert!(
                            error
                                .to_string()
                                .contains("session history is too large after decompression: 65 bytes exceeds 64 bytes"),
                            "unexpected error: {error}"
                        );
                        assert_phase_failure(timings.decompression());
                        assert_no_phase(timings.hash_verification());
                    }
                    _ => panic!("expected failed materialization"),
                }
            }
            server.assert_served().await;
        }
    }

    #[tokio::test]
    async fn codex_zstd_attributes_prefix_inside_fixed_decoded_chunks() {
        const PREFIX_BOUNDARY: usize = 8 * 1024 + 37;

        let padding = "x".repeat(PREFIX_BOUNDARY + 256);
        let body = format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"timestamp\":\"2026-07-02T10:00:00Z\",\"padding\":\"{padding}\"}}}}\n{{\"type\":\"response\"}}\n"
        );
        let body = body.as_bytes();
        let local_size = PREFIX_BOUNDARY;
        let local_history = &body[..local_size];
        let compressed = zstd_bytes(body);
        let encoded_size = compressed.len() as u64;
        let server = serve_once("200 OK", compressed.clone(), None).await;
        let session = zstd_ref_session(
            server.url(),
            hex::encode(Sha256::digest(body)),
            body.len() as u64,
            encoded_size,
        );

        let result = start_materializer_with_prefix_attribution(
            &session,
            EffectiveCliFramework::Codex,
            prefix_attribution(local_history),
        )
        .finish(&CancellationToken::new())
        .await;

        match result {
            SessionHistoryMaterialization::Downloaded {
                session,
                prefix_outcome: Some(SessionHistoryPrefixOutcome::Verified { raw_extension_size }),
                ..
            } => {
                assert_eq!(session.history_bytes(), compressed);
                session
                    .codex_zstd_history()
                    .expect("Codex zstd history should retain its compressed representation");
                assert_eq!(
                    session
                        .codex_timestamp()
                        .map(|timestamp| timestamp.to_rfc3339())
                        .as_deref(),
                    Some("2026-07-02T10:00:00+00:00")
                );
                assert_eq!(raw_extension_size, (body.len() - local_size) as u64);
            }
            _ => panic!("expected verified attributed Codex zstd session"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn codex_materializer_rejects_zstd_hash_mismatch() {
        let body =
            b"{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-07-02T10:00:00Z\"}}\n";
        let compressed = zstd_bytes(body);
        let encoded_size = compressed.len() as u64;
        let server = serve_once("200 OK", compressed, None).await;
        let session = zstd_ref_session(
            server.url(),
            "0".repeat(64),
            body.len() as u64,
            encoded_size,
        );

        let materializer = start_materializer_with_prefix_attribution(
            &session,
            EffectiveCliFramework::Codex,
            prefix_attribution(&body[..16]),
        );
        let result = materializer.finish(&CancellationToken::new()).await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(
                    error.to_string().contains("session history hash mismatch"),
                    "unexpected error: {error}"
                );
                assert_phase_success(timings.request_status());
                assert_phase_success(timings.body_read());
                assert_phase_success(timings.validation());
                assert_phase_success(timings.decompression());
                assert_phase_failure(timings.hash_verification());
            }
            _ => panic!("expected failed materialization"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn codex_materializer_rejects_zstd_body_over_declared_raw_size() {
        let body =
            b"{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-07-02T10:00:00Z\"}}\n";
        let compressed = zstd_bytes(body);
        let encoded_size = compressed.len() as u64;
        let hash = hex::encode(Sha256::digest(body));
        let server = serve_once("200 OK", compressed, None).await;
        let session = zstd_ref_session(server.url(), hash, 1, encoded_size);

        let materializer =
            start_materializer_with_framework(&session, EffectiveCliFramework::Codex);
        let result = materializer.finish(&CancellationToken::new()).await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(
                    error
                        .to_string()
                        .contains("session history is too large after decompression"),
                    "unexpected error: {error}"
                );
                assert_phase_success(timings.request_status());
                assert_phase_success(timings.body_read());
                assert_phase_failure(timings.decompression());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected failed materialization"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn materializer_rejects_zstd_body_under_declared_encoded_size_without_content_length() {
        let body = b"{\"type\":\"init\"}\n{\"type\":\"user\",\"message\":\"hello\"}\n";
        let compressed = zstd_bytes(body);
        let encoded_size = compressed.len() as u64;
        let hash = hex::encode(Sha256::digest(body));
        let server = MultiShotSessionHistoryServer::respond_many(vec![
            MultiShotSessionHistoryResponse::ok(compressed.clone(), None);
            1
        ])
        .await;
        let session = zstd_ref_session(server.url(), hash, body.len() as u64, encoded_size + 1);

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(
                    error.to_string().contains("downloaded size mismatch"),
                    "unexpected error: {error}"
                );
                assert_phase_success(timings.request_status());
                assert_phase_failure(timings.body_read());
                assert_phase_success(timings.validation());
                assert_no_phase(timings.decompression());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected failed materialization"),
        }
        server.assert_served(1).await;
    }

    #[tokio::test]
    async fn materializer_rejects_gzip_body_under_declared_encoded_size_without_content_length() {
        let body = b"{\"type\":\"init\"}\n{\"type\":\"user\",\"message\":\"hello\"}\n";
        let compressed = gzip_bytes(body);
        let encoded_size = compressed.len() as u64;
        let hash = hex::encode(Sha256::digest(body));
        let server = MultiShotSessionHistoryServer::respond_many(vec![
            MultiShotSessionHistoryResponse::ok(compressed.clone(), None);
            1
        ])
        .await;
        let session = gzip_ref_session(server.url(), hash, body.len() as u64, encoded_size + 1);

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(
                    error.to_string().contains("downloaded size mismatch"),
                    "unexpected error: {error}"
                );
                assert_phase_success(timings.request_status());
                assert_phase_failure(timings.body_read());
                assert_phase_success(timings.validation());
                assert_no_phase(timings.decompression());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected failed materialization"),
        }
        server.assert_served(1).await;
    }

    #[tokio::test]
    async fn materializer_rejects_body_over_declared_size_without_content_length() {
        let body = b"{\"type\":\"init\"}\n";
        let hash = hex::encode(Sha256::digest(body));
        let server = serve_once("200 OK", body, None).await;
        let session = ref_session(server.url(), hash, 1, 1);

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(
                    error.to_string().contains("downloaded size mismatch"),
                    "unexpected error: {error}"
                );
                assert_phase_success(timings.request_status());
                assert_phase_failure(timings.body_read());
                assert_phase_success(timings.validation());
                assert_no_phase(timings.decompression());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected failed materialization"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn materializer_decompresses_multi_member_gzip_history() {
        let first = b"{\"type\":\"init\"}\n";
        let second = b"{\"type\":\"user\",\"message\":\"hello\"}\n";
        let body = [first.as_slice(), second.as_slice()].concat();
        let compressed = [gzip_bytes(first), gzip_bytes(second)].concat();
        let encoded_size = compressed.len() as u64;
        let hash = hex::encode(Sha256::digest(&body));
        let server = serve_once("200 OK", compressed, None).await;
        let session = gzip_ref_session(server.url(), hash, body.len() as u64, encoded_size);

        let materializer = start_materializer(&session);
        let result = materializer.finish(&CancellationToken::new()).await;

        match result {
            SessionHistoryMaterialization::Downloaded { session, .. } => {
                assert_eq!(session.history_bytes(), body);
            }
            _ => panic!("expected downloaded session"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn materializer_rejects_gzip_body_over_declared_raw_size() {
        let body = b"{\"type\":\"init\"}\n{\"type\":\"user\",\"message\":\"hello\"}\n";
        let compressed = gzip_bytes(body);
        let encoded_size = compressed.len() as u64;
        let hash = hex::encode(Sha256::digest(body));
        let server = serve_once("200 OK", compressed, None).await;
        let session = gzip_ref_session(server.url(), hash, 1, encoded_size);

        let materializer = start_materializer(&session);
        let result = materializer.finish(&CancellationToken::new()).await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(
                    error
                        .to_string()
                        .contains("session history is too large after decompression"),
                    "unexpected error: {error}"
                );
                assert_phase_success(timings.request_status());
                assert_phase_success(timings.body_read());
                assert_phase_failure(timings.decompression());
            }
            _ => panic!("expected failed materialization"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn materializer_rejects_zstd_body_over_declared_raw_size() {
        let body = b"{\"type\":\"init\"}\n{\"type\":\"user\",\"message\":\"hello\"}\n";
        let compressed = zstd_bytes(body);
        let encoded_size = compressed.len() as u64;
        let hash = hex::encode(Sha256::digest(body));
        let server = serve_once("200 OK", compressed, None).await;
        let session = zstd_ref_session(server.url(), hash, 1, encoded_size);

        let materializer = start_materializer(&session);
        let result = materializer.finish(&CancellationToken::new()).await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(
                    error
                        .to_string()
                        .contains("session history is too large after decompression"),
                    "unexpected error: {error}"
                );
                assert_phase_success(timings.request_status());
                assert_phase_success(timings.body_read());
                assert_phase_failure(timings.decompression());
            }
            _ => panic!("expected failed materialization"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn materializer_rejects_truncated_zstd_body() {
        let body = b"{\"type\":\"init\"}\n{\"type\":\"user\",\"message\":\"hello\"}\n";
        let mut compressed = zstd_bytes(body);
        compressed.truncate(compressed.len().saturating_sub(1));
        let hash = hex::encode(Sha256::digest(body));
        let server = serve_once("200 OK", compressed.clone(), None).await;
        let session = zstd_ref_session(
            server.url(),
            hash,
            body.len() as u64,
            compressed.len() as u64,
        );

        let materializer = start_materializer(&session);
        let result = materializer.finish(&CancellationToken::new()).await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(
                    error
                        .to_string()
                        .contains("decompress zstd session history"),
                    "unexpected error: {error}"
                );
                assert_phase_success(timings.request_status());
                assert_phase_success(timings.body_read());
                assert_phase_success(timings.validation());
                assert_phase_failure(timings.decompression());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected failed materialization"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn materializer_rejects_hash_mismatch_and_redacts_url_query() {
        let expected_hash = hex::encode(Sha256::digest(b"expected"));
        let actual_hash = hex::encode(Sha256::digest(b"actual"));
        let server = serve_once("200 OK", b"actual", Some(6)).await;
        let session = ref_session(server.url(), expected_hash.clone(), 6, 6);

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                let message = error.to_string();
                assert!(message.contains("hash mismatch"));
                assert!(!message.contains("token=secret"));
                assert!(!message.contains(&expected_hash));
                assert!(!message.contains(&actual_hash));
                assert_phase_success(timings.request_status());
                assert_phase_success(timings.body_read());
                assert_phase_success(timings.validation());
                assert_no_phase(timings.decompression());
                assert_phase_failure(timings.hash_verification());
            }
            _ => panic!("expected failed download"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn materializer_redacts_url_query_from_http_status_error() {
        let server = MultiShotSessionHistoryServer::respond_many(vec![
            MultiShotSessionHistoryResponse::status("403 Forbidden"),
        ])
        .await;
        let session = ref_session(server.url(), hex::encode(Sha256::digest(b"no")), 2, 2);

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                let message = error.to_string();
                assert!(message.contains("history.blob?<redacted>"));
                assert!(!message.contains("token=secret"));
                assert_phase_failure(timings.request_status());
                assert_no_phase(timings.body_read());
                assert_no_phase(timings.validation());
                assert_no_phase(timings.decompression());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected failed download"),
        }
        server.assert_served(1).await;
    }

    #[tokio::test]
    async fn materializer_records_mismatched_content_length_metadata() {
        let body = b"actual";
        let server =
            MultiShotSessionHistoryServer::respond_many(vec![MultiShotSessionHistoryResponse::ok(
                body,
                Some(999),
            )])
            .await;
        let session = ref_session(
            server.url(),
            hex::encode(Sha256::digest(body)),
            body.len() as u64,
            body.len() as u64,
        );

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(
                    error.to_string().contains("content-length mismatch"),
                    "unexpected error: {error}"
                );
                assert_phase_success(timings.request_status());
                assert_no_phase(timings.body_read());
                assert_phase_failure(timings.validation());
                assert_no_phase(timings.decompression());
                assert_no_phase(timings.hash_verification());
                assert_response_metadata(
                    &timings,
                    SessionHistoryContentLengthState::MismatchesExpected,
                    SessionHistoryContentEncodingState::Absent,
                    SessionHistoryTransferEncodingState::Absent,
                );
            }
            _ => panic!("expected failed download"),
        }
        server.assert_served(1).await;
    }

    #[tokio::test]
    async fn materializer_rejects_oversized_content_length() {
        let server = serve_once("200 OK", b"", Some(RESUME_SESSION_HISTORY_MAX_BYTES + 1)).await;
        let session = ref_session(server.url(), hex::encode(Sha256::digest(b"")), 1, 1);

        let result = start_materializer(&session)
            .finish(&CancellationToken::new())
            .await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(error.to_string().contains("too large"));
                assert_phase_success(timings.request_status());
                assert_no_phase(timings.body_read());
                assert_phase_failure(timings.validation());
                assert_no_phase(timings.decompression());
                assert_no_phase(timings.hash_verification());
                assert_response_metadata(
                    &timings,
                    SessionHistoryContentLengthState::Oversized,
                    SessionHistoryContentEncodingState::Absent,
                    SessionHistoryTransferEncodingState::Absent,
                );
            }
            _ => panic!("expected failed download"),
        }
        server.assert_served().await;
    }

    #[tokio::test]
    async fn attributed_materializer_preserves_body_read_failure() {
        let server = MultiShotSessionHistoryServer::respond_many(vec![
            MultiShotSessionHistoryResponse::ok(b"short", Some(999));
            1
        ])
        .await;
        let session = ref_session(
            server.url(),
            hex::encode(Sha256::digest(b"short")),
            999,
            999,
        );

        let result = start_materializer_with_prefix_attribution(
            &session,
            EffectiveCliFramework::ClaudeCode,
            prefix_attribution(b"x"),
        )
        .finish(&CancellationToken::new())
        .await;

        match result {
            SessionHistoryMaterialization::Failed { timings, .. } => {
                assert_phase_success(timings.request_status());
                assert_phase_failure(timings.body_read());
                assert_phase_success(timings.validation());
                assert_no_phase(timings.decompression());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected failed download"),
        }
        server.assert_served(1).await;
    }

    #[test]
    fn redact_url_query_preserves_fragment() {
        assert_eq!(
            redact_url_query("https://r2.example.com/blob?sig=secret#frag"),
            "https://r2.example.com/blob?<redacted>#frag"
        );
    }

    #[tokio::test]
    async fn attributed_materializer_reports_cancelled_download_without_an_outcome() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let shutdown = CancellationToken::new();
        let shutdown_for_server = shutdown.clone();
        let server = tokio::spawn(async move {
            tokio::select! {
                accepted = listener.accept() => {
                    let (_stream, _) = accepted.unwrap();
                    shutdown_for_server.cancelled().await;
                }
                _ = shutdown_for_server.cancelled() => {}
            }
        });
        let requested_history = b"xy";
        let session = ref_session(
            format!("http://{address}/history.blob?token=secret"),
            hex::encode(Sha256::digest(requested_history)),
            requested_history.len() as u64,
            requested_history.len() as u64,
        );
        let cancel = CancellationToken::new();
        cancel.cancel();

        let result = start_materializer_with_prefix_attribution(
            &session,
            EffectiveCliFramework::ClaudeCode,
            prefix_attribution(&requested_history[..1]),
        )
        .finish(&cancel)
        .await;

        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(matches!(error, RunnerError::Cancelled));
                assert_no_phase(timings.request_status());
                assert_no_phase(timings.body_read());
                assert_no_phase(timings.validation());
                assert_no_phase(timings.decompression());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected cancelled download"),
        }
        shutdown.cancel();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn dropping_materializer_aborts_pending_download() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (request_received_tx, request_received_rx) = oneshot::channel();
        let (connection_closed_tx, connection_closed_rx) = oneshot::channel();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request).await;
            let _ = request_received_tx.send(());
            let mut buf = [0u8; 1];
            let closed = stream.read(&mut buf).await;
            let _ = connection_closed_tx.send(closed);
        });
        let session = ref_session(
            format!("http://{address}/history.blob?token=secret"),
            hex::encode(Sha256::digest(b"")),
            1,
            1,
        );
        let probe = SessionHistoryProbe::with_limits_for_test(Duration::from_secs(60), 8);

        let materializer = SessionHistoryMaterializer::start_cancellable(
            &http_client(),
            &SessionHistoryCpuPool::with_capacity(1),
            Some(&session),
            EffectiveCliFramework::ClaudeCode,
            CancellationToken::new(),
            Some(&probe),
        );
        tokio::time::timeout(Duration::from_secs(5), request_received_rx)
            .await
            .unwrap()
            .unwrap();
        drop(materializer);

        let closed = tokio::time::timeout(Duration::from_secs(5), connection_closed_rx)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(closed, 0);

        let repeated = probe.observe(session.history_ref().unwrap());
        assert_eq!(
            repeated.observation(),
            SessionHistoryCacheProbeMetadata::new(true, false)
        );
        repeated.finish();
    }

    #[tokio::test]
    async fn cancellable_materializer_aborts_pending_download_before_finish() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (request_received_tx, request_received_rx) = oneshot::channel();
        let (connection_closed_tx, connection_closed_rx) = oneshot::channel();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request).await;
            let _ = request_received_tx.send(());
            let mut buf = [0u8; 1];
            let closed = stream.read(&mut buf).await;
            let _ = connection_closed_tx.send(closed);
        });
        let session = ref_session(
            format!("http://{address}/history.blob?token=secret"),
            hex::encode(Sha256::digest(b"")),
            1,
            1,
        );
        let cancel = CancellationToken::new();
        let probe = SessionHistoryProbe::with_limits_for_test(Duration::from_secs(60), 8);

        let materializer = SessionHistoryMaterializer::start_cancellable(
            &http_client(),
            &SessionHistoryCpuPool::with_capacity(1),
            Some(&session),
            EffectiveCliFramework::ClaudeCode,
            cancel.clone(),
            Some(&probe),
        );
        tokio::time::timeout(Duration::from_secs(5), request_received_rx)
            .await
            .unwrap()
            .unwrap();
        cancel.cancel();

        let closed = tokio::time::timeout(Duration::from_secs(5), connection_closed_rx)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(closed, 0);
        let result = materializer.finish(&CancellationToken::new()).await;
        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(matches!(error, RunnerError::Cancelled));
                assert_no_phase(timings.request_status());
                assert_no_phase(timings.body_read());
                assert_no_phase(timings.validation());
                assert_no_phase(timings.decompression());
                assert_no_phase(timings.hash_verification());
            }
            _ => panic!("expected cancelled download"),
        }
        let repeated = probe.observe(session.history_ref().unwrap());
        assert_eq!(
            repeated.observation(),
            SessionHistoryCacheProbeMetadata::new(true, false)
        );
        repeated.finish();
    }

    #[tokio::test]
    async fn cancellable_materializer_does_not_request_when_already_cancelled() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let session = gzip_ref_session(
            format!("http://{address}/history.blob?token=secret"),
            hex::encode(Sha256::digest(b"")),
            0,
            0,
        );
        let cancel = CancellationToken::new();
        cancel.cancel();

        let materializer = SessionHistoryMaterializer::start_cancellable(
            &http_client(),
            &SessionHistoryCpuPool::with_capacity(1),
            Some(&session),
            EffectiveCliFramework::ClaudeCode,
            cancel.clone(),
            None,
        );
        let result = materializer.finish(&cancel).await;
        match result {
            SessionHistoryMaterialization::Failed { error, timings, .. } => {
                assert!(matches!(error, RunnerError::Cancelled));
                assert_no_phase(timings.request_status());
                assert_no_phase(timings.body_read());
                assert_no_phase(timings.validation());
                assert_no_phase(timings.decompression());
                assert_no_phase(timings.hash_verification());
                assert_eq!(timings.encoding(), Some("gzip"));
            }
            _ => panic!("expected cancelled download"),
        }
        let accept_error = listener.accept().unwrap_err();
        assert_eq!(accept_error.kind(), io::ErrorKind::WouldBlock);
    }

    #[tokio::test]
    async fn finish_prefers_cancel_over_completed_download_task() {
        let task = tokio::spawn(async {
            SessionHistoryDownloadTaskResult {
                elapsed: Duration::from_millis(1),
                timings: SessionHistoryDownloadTimings::default(),
                result: Ok(SessionHistoryCpuMaterialization {
                    session: MaterializedResumeSession::new(
                        "sess-123".to_string(),
                        br#"{"type":"init"}"#.to_vec(),
                        None,
                    ),
                    prefix_outcome: None,
                }),
            }
        });
        while !task.is_finished() {
            tokio::task::yield_now().await;
        }
        let cancel = CancellationToken::new();
        cancel.cancel();
        let materializer = SessionHistoryMaterializer {
            state: SessionHistoryMaterializerState::Downloading {
                started_at: Instant::now(),
                metadata: identity_metadata(),
                probe_registration: None,
                cancel: CancellationToken::new(),
                task: Some(task),
            },
        };

        let result = materializer.finish(&cancel).await;
        match result {
            SessionHistoryMaterialization::Failed { error, .. } => {
                assert!(matches!(error, RunnerError::Cancelled));
            }
            _ => panic!("expected cancelled download"),
        }
    }

    #[tokio::test]
    async fn finish_prefers_cancel_when_task_cancels_during_join() {
        let cancel = CancellationToken::new();
        let cancel_for_task = cancel.clone();
        let task = tokio::spawn(async move {
            cancel_for_task.cancel();
            SessionHistoryDownloadTaskResult {
                elapsed: Duration::from_millis(1),
                timings: SessionHistoryDownloadTimings::default(),
                result: Ok(SessionHistoryCpuMaterialization {
                    session: MaterializedResumeSession::new(
                        "sess-123".to_string(),
                        br#"{"type":"init"}"#.to_vec(),
                        None,
                    ),
                    prefix_outcome: None,
                }),
            }
        });
        let materializer = SessionHistoryMaterializer {
            state: SessionHistoryMaterializerState::Downloading {
                started_at: Instant::now(),
                metadata: identity_metadata(),
                probe_registration: None,
                cancel: cancel.clone(),
                task: Some(task),
            },
        };

        let result = materializer.finish(&cancel).await;
        match result {
            SessionHistoryMaterialization::Failed { error, .. } => {
                assert!(matches!(error, RunnerError::Cancelled));
            }
            _ => panic!("expected cancelled download"),
        }
    }
}
