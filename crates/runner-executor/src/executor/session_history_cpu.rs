//! Bounded CPU execution for resume-session history materialization.
//!
//! A production Runner creates one shared `SessionHistoryCpuPool` per Runner
//! process from the logical CPU count reported by `host::cpu_count()`. Its
//! production capacity is half that count (integer division), clamped to a
//! minimum of one and a maximum of four permits. The pool is stored in the
//! shared `ExecutorConfig`, so downloaded history, workspace-sidecar history,
//! and inline Codex timestamp extraction contend for the same CPU budget.
//!
//! `SessionHistoryCpuPool::materialize` acquires an owned semaphore permit
//! before spawning the blocking task and moves that permit into
//! `spawn_blocking`. The permit therefore covers the complete materialization,
//! including validation, decompression, hashing, UTF-8 processing, and Codex
//! timestamp scanning; it is not only an admission or decompression limit.
//!
//! Cancellation is cooperative once the blocking task has started. Caller
//! cancellation signals a child token and the task's abort handle, and the
//! cancellation path joins the blocking task before returning. Dropping an
//! in-flight materialization future signals the same child token and abort
//! handle through its task guard. `spawn_blocking` work must therefore retain
//! bounded cancellation checkpoints: CPU loops call `check_cancelled`, and
//! blocking read loops use `CancellationReader`, which checks cancellation
//! around each read. New long-running CPU or read phases must preserve this
//! contract rather than relying on task abortion to stop active work.
//!
//! Jobs enter this boundary as raw bytes, gzip or zstd encoded bytes, or
//! inline Codex text. The raw and compressed paths validate declared sizes,
//! decompress when needed, verify SHA-256, and extract a Codex timestamp when
//! applicable. The inline Codex path performs the UTF-8 and timestamp work
//! through the same pool. The downloaded-history materializer in
//! `session_history_download.rs` and the workspace-sidecar materializer in
//! `workspace_session_history_materializer.rs` use the pool for their raw,
//! gzip, and zstd jobs; `agent_run.rs` uses it for inline Codex history.

use std::fmt;
use std::io::{self, BufReader, Read};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(test)]
use std::sync::{Condvar, Mutex};

use api_contracts::generated::constants::runners::RESUME_SESSION_HISTORY_MAX_BYTES;
use flate2::read::MultiGzDecoder;
use guest_contracts::session_history::CODEX_COMPACT_GENERATION_MAX_BYTES;
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use super::cli_framework::EffectiveCliFramework;
use super::session_restore::MaterializedResumeSession;
use super::{RunnerError, RunnerResult};
use crate::restored_session_identity::RestoredSessionHistoryPrefixAttribution;

const CPU_CHUNK_BYTES: usize = 64 * 1024;
const DECODER_BUFFER_BYTES: usize = 8 * 1024;
const CODEX_TIMESTAMP_RECORD_MAX_BYTES: usize = 1024 * 1024;
const CPU_CANCELLED: &str = "session history materialization cancelled";

#[derive(Clone)]
pub struct SessionHistoryCpuPool {
    permits: Arc<Semaphore>,
    hooks: SessionHistoryCpuHooks,
}

#[derive(Clone, Default)]
struct SessionHistoryCpuHooks {
    #[cfg(test)]
    cpu_gate: Option<SessionHistoryCpuTestGate>,
    #[cfg(test)]
    reader_gate: Option<SessionHistoryCpuTestGate>,
    #[cfg(test)]
    codex_timestamp_record_max_bytes: Option<usize>,
    #[cfg(test)]
    codex_raw_restore_threshold: Option<u64>,
}

struct CodexTimestampRecordScanner {
    record: Vec<u8>,
    max_record_bytes: usize,
    record_too_large: bool,
}

struct SessionHistoryCpuTaskGuard {
    cancel: CancellationToken,
    abort: tokio::task::AbortHandle,
    armed: bool,
}

pub(super) struct SessionHistoryCpuJob {
    kind: SessionHistoryCpuJobKind,
    prefix_attribution: Option<RestoredSessionHistoryPrefixAttribution>,
}

enum SessionHistoryCpuJobKind {
    Raw {
        cli_agent_session_id: String,
        bytes: Vec<u8>,
        expected_raw_size: u64,
        expected_hash: String,
        framework: EffectiveCliFramework,
    },
    Gzip {
        cli_agent_session_id: String,
        encoded_bytes: Vec<u8>,
        expected_raw_size: u64,
        expected_hash: String,
        framework: EffectiveCliFramework,
    },
    Zstd {
        cli_agent_session_id: String,
        encoded_bytes: Vec<u8>,
        expected_raw_size: u64,
        expected_hash: String,
        framework: EffectiveCliFramework,
    },
    InlineCodex {
        cli_agent_session_id: String,
        history: Arc<String>,
    },
}

struct CompressedSessionHistoryJob {
    cli_agent_session_id: String,
    encoded_bytes: Vec<u8>,
    expected_raw_size: u64,
    expected_hash: String,
    framework: EffectiveCliFramework,
    encoding: CompressedEncoding,
    prefix_attribution: Option<RestoredSessionHistoryPrefixAttribution>,
}

struct RawSessionHistoryJob {
    cli_agent_session_id: String,
    bytes: Vec<u8>,
    expected_raw_size: u64,
    expected_hash: String,
    framework: EffectiveCliFramework,
    prefix_attribution: Option<RestoredSessionHistoryPrefixAttribution>,
}

pub(super) struct SessionHistoryCpuOutcome {
    pub(super) timings: SessionHistoryCpuTimings,
    pub(super) result: RunnerResult<SessionHistoryCpuMaterialization>,
}

pub(super) struct SessionHistoryCpuMaterialization {
    pub(super) session: MaterializedResumeSession,
    pub(super) prefix_outcome: Option<SessionHistoryPrefixOutcome>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum SessionHistoryPrefixOutcome {
    Verified { raw_extension_size: u64 },
    Divergent,
}

impl fmt::Debug for SessionHistoryCpuOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionHistoryCpuOutcome")
            .field("timings", &self.timings)
            .field(
                "result",
                &self.result.as_ref().map(|_| "[redacted-materialization]"),
            )
            .finish()
    }
}

impl fmt::Debug for SessionHistoryCpuMaterialization {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionHistoryCpuMaterialization")
            .field("session", &"[redacted]")
            .field("prefix_outcome", &self.prefix_outcome.map(|_| "[redacted]"))
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct SessionHistoryCpuTimings {
    admission_wait: Duration,
    validation: Option<SessionHistoryCpuPhaseTiming>,
    decompression: Option<SessionHistoryCpuPhaseTiming>,
    hash_verification: Option<SessionHistoryCpuPhaseTiming>,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct SessionHistoryCpuPhaseTiming {
    elapsed: Duration,
    success: bool,
}

impl SessionHistoryCpuPool {
    pub fn for_host_cpus(host_cpus: usize) -> Self {
        let capacity = (host_cpus / 2).clamp(1, 4);
        Self::with_capacity(capacity)
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(capacity.max(1))),
            hooks: SessionHistoryCpuHooks::default(),
        }
    }

    #[cfg(test)]
    pub(in crate::executor) fn with_test_gates(
        capacity: usize,
        cpu_gate: Option<SessionHistoryCpuTestGate>,
        reader_gate: Option<SessionHistoryCpuTestGate>,
    ) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(capacity.max(1))),
            hooks: SessionHistoryCpuHooks {
                cpu_gate,
                reader_gate,
                codex_timestamp_record_max_bytes: None,
                codex_raw_restore_threshold: None,
            },
        }
    }

    #[cfg(test)]
    pub(in crate::executor) fn with_test_codex_timestamp_record_max_bytes(
        capacity: usize,
        max_record_bytes: usize,
    ) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(capacity.max(1))),
            hooks: SessionHistoryCpuHooks {
                cpu_gate: None,
                reader_gate: None,
                codex_timestamp_record_max_bytes: Some(max_record_bytes),
                codex_raw_restore_threshold: None,
            },
        }
    }

    #[cfg(test)]
    pub(in crate::executor) fn with_test_codex_raw_restore_threshold(
        capacity: usize,
        threshold: u64,
    ) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(capacity.max(1))),
            hooks: SessionHistoryCpuHooks {
                cpu_gate: None,
                reader_gate: None,
                codex_timestamp_record_max_bytes: None,
                codex_raw_restore_threshold: Some(threshold),
            },
        }
    }

    pub(super) async fn materialize(
        &self,
        job: SessionHistoryCpuJob,
        cancel: &CancellationToken,
    ) -> RunnerResult<SessionHistoryCpuOutcome> {
        self.hooks.record_submission();
        let operation_cancel = cancel.child_token();
        let admission_started = Instant::now();
        let permit = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(cpu_cancelled_error()),
            permit = Arc::clone(&self.permits).acquire_owned() => permit.map_err(|error| {
                RunnerError::Internal(format!("acquire session history CPU permit: {error}"))
            })?,
        };
        let admission_wait = admission_started.elapsed();

        let blocking_cancel = operation_cancel.clone();
        let hooks = self.hooks.clone();
        let mut task = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            materialize_blocking(job, &blocking_cancel, &hooks)
        });
        let mut task_guard =
            SessionHistoryCpuTaskGuard::new(operation_cancel.clone(), task.abort_handle());
        let (joined, cancellation_observed) = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                task_guard.cancel();
                ((&mut task).await, true)
            }
            joined = &mut task => (joined, false),
        };
        task_guard.disarm();
        if cancellation_observed || cancel.is_cancelled() {
            return Err(cpu_cancelled_error());
        }
        let mut outcome = joined.map_err(|error| {
            RunnerError::Internal(format!("session history CPU task failed: {error}"))
        })?;
        outcome.timings.admission_wait = admission_wait;
        Ok(outcome)
    }
}

impl SessionHistoryCpuTaskGuard {
    fn new(cancel: CancellationToken, abort: tokio::task::AbortHandle) -> Self {
        Self {
            cancel,
            abort,
            armed: true,
        }
    }

    fn cancel(&self) {
        self.cancel.cancel();
        self.abort.abort();
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for SessionHistoryCpuTaskGuard {
    fn drop(&mut self) {
        if self.armed {
            self.cancel();
        }
    }
}

impl SessionHistoryCpuHooks {
    fn record_submission(&self) {
        #[cfg(test)]
        if let Some(gate) = &self.cpu_gate {
            gate.record_submission();
        }
    }

    fn enter_cpu(&self, cancel: &CancellationToken) -> RunnerResult<()> {
        #[cfg(test)]
        if let Some(gate) = &self.cpu_gate {
            return gate
                .enter(cancel)
                .then_some(())
                .ok_or_else(cpu_cancelled_error);
        }
        let _ = cancel;
        Ok(())
    }

    fn reader_checkpoint(&self, cancel: &CancellationToken) -> io::Result<()> {
        #[cfg(test)]
        if let Some(gate) = &self.reader_gate
            && !gate.enter(cancel)
        {
            return Err(io::Error::other(CPU_CANCELLED));
        }
        let _ = cancel;
        Ok(())
    }

    fn codex_timestamp_record_max_bytes(&self) -> usize {
        #[cfg(test)]
        if let Some(max_record_bytes) = self.codex_timestamp_record_max_bytes {
            return max_record_bytes;
        }
        CODEX_TIMESTAMP_RECORD_MAX_BYTES
    }

    fn codex_raw_restore_threshold(&self) -> u64 {
        #[cfg(test)]
        if let Some(threshold) = self.codex_raw_restore_threshold {
            return threshold;
        }
        CODEX_COMPACT_GENERATION_MAX_BYTES
    }
}

impl SessionHistoryCpuJob {
    pub(super) fn raw(
        cli_agent_session_id: String,
        bytes: Vec<u8>,
        expected_raw_size: u64,
        expected_hash: String,
        framework: EffectiveCliFramework,
    ) -> Self {
        Self {
            kind: SessionHistoryCpuJobKind::Raw {
                cli_agent_session_id,
                bytes,
                expected_raw_size,
                expected_hash,
                framework,
            },
            prefix_attribution: None,
        }
    }

    pub(super) fn gzip(
        cli_agent_session_id: String,
        encoded_bytes: Vec<u8>,
        expected_raw_size: u64,
        expected_hash: String,
        framework: EffectiveCliFramework,
    ) -> Self {
        Self {
            kind: SessionHistoryCpuJobKind::Gzip {
                cli_agent_session_id,
                encoded_bytes,
                expected_raw_size,
                expected_hash,
                framework,
            },
            prefix_attribution: None,
        }
    }

    pub(super) fn zstd(
        cli_agent_session_id: String,
        encoded_bytes: Vec<u8>,
        expected_raw_size: u64,
        expected_hash: String,
        framework: EffectiveCliFramework,
    ) -> Self {
        Self {
            kind: SessionHistoryCpuJobKind::Zstd {
                cli_agent_session_id,
                encoded_bytes,
                expected_raw_size,
                expected_hash,
                framework,
            },
            prefix_attribution: None,
        }
    }

    pub(super) fn inline_codex(cli_agent_session_id: String, history: Arc<String>) -> Self {
        Self {
            kind: SessionHistoryCpuJobKind::InlineCodex {
                cli_agent_session_id,
                history,
            },
            prefix_attribution: None,
        }
    }

    pub(super) fn with_prefix_attribution(
        mut self,
        prefix_attribution: RestoredSessionHistoryPrefixAttribution,
    ) -> Self {
        self.prefix_attribution = Some(prefix_attribution);
        self
    }
}

impl SessionHistoryCpuTimings {
    pub(super) fn admission_wait(self) -> Duration {
        self.admission_wait
    }

    pub(super) fn validation(self) -> Option<SessionHistoryCpuPhaseTiming> {
        self.validation
    }

    pub(super) fn decompression(self) -> Option<SessionHistoryCpuPhaseTiming> {
        self.decompression
    }

    pub(super) fn hash_verification(self) -> Option<SessionHistoryCpuPhaseTiming> {
        self.hash_verification
    }

    fn record_validation(&mut self, elapsed: Duration, success: bool) {
        self.validation = Some(SessionHistoryCpuPhaseTiming { elapsed, success });
    }

    fn record_decompression(&mut self, elapsed: Duration, success: bool) {
        self.decompression = Some(SessionHistoryCpuPhaseTiming { elapsed, success });
    }

    fn record_hash_verification(&mut self, elapsed: Duration, success: bool) {
        self.hash_verification = Some(SessionHistoryCpuPhaseTiming { elapsed, success });
    }
}

impl SessionHistoryCpuPhaseTiming {
    pub(super) fn elapsed(self) -> Duration {
        self.elapsed
    }

    pub(super) fn success(self) -> bool {
        self.success
    }
}

fn materialize_blocking(
    job: SessionHistoryCpuJob,
    cancel: &CancellationToken,
    hooks: &SessionHistoryCpuHooks,
) -> SessionHistoryCpuOutcome {
    if let Err(error) = check_cancelled(cancel).and_then(|()| hooks.enter_cpu(cancel)) {
        return SessionHistoryCpuOutcome {
            timings: SessionHistoryCpuTimings::default(),
            result: Err(error),
        };
    }
    let SessionHistoryCpuJob {
        kind,
        prefix_attribution,
    } = job;
    match kind {
        SessionHistoryCpuJobKind::Raw {
            cli_agent_session_id,
            bytes,
            expected_raw_size,
            expected_hash,
            framework,
        } => materialize_raw(
            RawSessionHistoryJob {
                cli_agent_session_id,
                bytes,
                expected_raw_size,
                expected_hash,
                framework,
                prefix_attribution,
            },
            cancel,
            hooks,
        ),
        SessionHistoryCpuJobKind::Gzip {
            cli_agent_session_id,
            encoded_bytes,
            expected_raw_size,
            expected_hash,
            framework,
        } => materialize_compressed(
            CompressedSessionHistoryJob {
                cli_agent_session_id,
                encoded_bytes,
                expected_raw_size,
                expected_hash,
                framework,
                encoding: CompressedEncoding::Gzip,
                prefix_attribution,
            },
            cancel,
            hooks,
        ),
        SessionHistoryCpuJobKind::Zstd {
            cli_agent_session_id,
            encoded_bytes,
            expected_raw_size,
            expected_hash,
            framework: EffectiveCliFramework::Codex,
        } => materialize_codex_zstd(
            cli_agent_session_id,
            encoded_bytes,
            expected_raw_size,
            &expected_hash,
            prefix_attribution,
            cancel,
            hooks,
        ),
        SessionHistoryCpuJobKind::Zstd {
            cli_agent_session_id,
            encoded_bytes,
            expected_raw_size,
            expected_hash,
            framework,
        } => materialize_compressed(
            CompressedSessionHistoryJob {
                cli_agent_session_id,
                encoded_bytes,
                expected_raw_size,
                expected_hash,
                framework,
                encoding: CompressedEncoding::Zstd,
                prefix_attribution,
            },
            cancel,
            hooks,
        ),
        SessionHistoryCpuJobKind::InlineCodex {
            cli_agent_session_id,
            history,
        } => {
            let result = scan_valid_utf8_history(&history, cancel, hooks).map(|timestamp| {
                SessionHistoryCpuMaterialization {
                    session: MaterializedResumeSession::new_shared(
                        cli_agent_session_id,
                        history,
                        timestamp,
                    ),
                    prefix_outcome: None,
                }
            });
            SessionHistoryCpuOutcome {
                timings: SessionHistoryCpuTimings::default(),
                result,
            }
        }
    }
}

fn materialize_raw(
    job: RawSessionHistoryJob,
    cancel: &CancellationToken,
    hooks: &SessionHistoryCpuHooks,
) -> SessionHistoryCpuOutcome {
    let RawSessionHistoryJob {
        cli_agent_session_id,
        bytes,
        expected_raw_size,
        expected_hash,
        framework,
        prefix_attribution,
    } = job;
    let mut timings = SessionHistoryCpuTimings::default();
    let result = (|| {
        validate_raw_size(&bytes, expected_raw_size, &mut timings)?;
        let prefix_outcome = verify_hash(
            &bytes,
            &expected_hash,
            prefix_attribution,
            &mut timings,
            cancel,
        )?;
        let timestamp = if framework == EffectiveCliFramework::Codex {
            scan_raw_codex_history(&bytes, cancel, hooks)?
        } else {
            None
        };
        Ok(SessionHistoryCpuMaterialization {
            session: MaterializedResumeSession::new(cli_agent_session_id, bytes, timestamp),
            prefix_outcome,
        })
    })();
    SessionHistoryCpuOutcome { timings, result }
}

#[derive(Clone, Copy)]
enum CompressedEncoding {
    Gzip,
    Zstd,
}

impl CompressedEncoding {
    fn label(self) -> &'static str {
        match self {
            Self::Gzip => "gzip",
            Self::Zstd => "zstd",
        }
    }
}

fn materialize_compressed(
    job: CompressedSessionHistoryJob,
    cancel: &CancellationToken,
    hooks: &SessionHistoryCpuHooks,
) -> SessionHistoryCpuOutcome {
    let CompressedSessionHistoryJob {
        cli_agent_session_id,
        encoded_bytes,
        expected_raw_size,
        expected_hash,
        framework,
        encoding,
        prefix_attribution,
    } = job;
    let mut timings = SessionHistoryCpuTimings::default();
    let result = (|| {
        validate_compressed_raw_size(expected_raw_size, encoding.label(), &mut timings)?;
        let decompression_started = Instant::now();
        let result = decompress_history(&encoded_bytes, expected_raw_size, encoding, cancel, hooks);
        timings.record_decompression(decompression_started.elapsed(), result.is_ok());
        let bytes = result?;
        validate_decompressed_size(&bytes, expected_raw_size, &mut timings)?;
        let prefix_outcome = verify_hash(
            &bytes,
            &expected_hash,
            prefix_attribution,
            &mut timings,
            cancel,
        )?;
        let timestamp = if framework == EffectiveCliFramework::Codex {
            scan_raw_codex_history(&bytes, cancel, hooks)?
        } else {
            None
        };
        Ok(SessionHistoryCpuMaterialization {
            session: MaterializedResumeSession::new(cli_agent_session_id, bytes, timestamp),
            prefix_outcome,
        })
    })();
    SessionHistoryCpuOutcome { timings, result }
}

fn materialize_codex_zstd(
    cli_agent_session_id: String,
    encoded_bytes: Vec<u8>,
    expected_raw_size: u64,
    expected_hash: &str,
    prefix_attribution: Option<RestoredSessionHistoryPrefixAttribution>,
    cancel: &CancellationToken,
    hooks: &SessionHistoryCpuHooks,
) -> SessionHistoryCpuOutcome {
    let mut timings = SessionHistoryCpuTimings::default();
    let result = (|| {
        validate_compressed_raw_size(expected_raw_size, "zstd", &mut timings)?;
        let verified = verify_codex_zstd(
            &encoded_bytes,
            expected_raw_size,
            expected_hash,
            prefix_attribution,
            &mut timings,
            cancel,
            hooks,
        )?;
        let session = match verified.raw_bytes {
            Some(raw_bytes) => {
                MaterializedResumeSession::new(cli_agent_session_id, raw_bytes, verified.timestamp)
            }
            None => MaterializedResumeSession::new_codex_zstd(
                cli_agent_session_id,
                encoded_bytes,
                verified.timestamp,
            ),
        };
        Ok(SessionHistoryCpuMaterialization {
            session,
            prefix_outcome: verified.prefix_outcome,
        })
    })();
    SessionHistoryCpuOutcome { timings, result }
}

fn validate_raw_size(
    bytes: &[u8],
    expected_raw_size: u64,
    timings: &mut SessionHistoryCpuTimings,
) -> RunnerResult<()> {
    let started = Instant::now();
    let error = if expected_raw_size == 0 {
        Some(RunnerError::Internal(
            "identity session history rawSize must be positive".into(),
        ))
    } else if expected_raw_size > RESUME_SESSION_HISTORY_MAX_BYTES {
        Some(RunnerError::Internal(format!(
            "session history is too large: {expected_raw_size} bytes exceeds {RESUME_SESSION_HISTORY_MAX_BYTES} bytes"
        )))
    } else if bytes.len() as u64 != expected_raw_size {
        Some(RunnerError::Internal(format!(
            "session history size mismatch: expected {expected_raw_size} bytes, got {} bytes",
            bytes.len()
        )))
    } else {
        None
    };
    timings.record_validation(started.elapsed(), error.is_none());
    match error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn validate_decompressed_size(
    bytes: &[u8],
    expected_raw_size: u64,
    timings: &mut SessionHistoryCpuTimings,
) -> RunnerResult<()> {
    let started = Instant::now();
    let result = if bytes.len() as u64 == expected_raw_size {
        Ok(())
    } else {
        Err(RunnerError::Internal(format!(
            "session history size mismatch: expected {expected_raw_size} bytes after decompression, got {} bytes",
            bytes.len()
        )))
    };
    timings.record_validation(started.elapsed(), result.is_ok());
    result
}

fn validate_compressed_raw_size(
    expected_raw_size: u64,
    encoding: &str,
    timings: &mut SessionHistoryCpuTimings,
) -> RunnerResult<()> {
    let started = Instant::now();
    let result = if expected_raw_size == 0 {
        Err(RunnerError::Internal(format!(
            "{encoding} session history rawSize must be positive"
        )))
    } else if expected_raw_size > RESUME_SESSION_HISTORY_MAX_BYTES {
        Err(RunnerError::Internal(format!(
            "session history rawSize is too large: {expected_raw_size} bytes exceeds {RESUME_SESSION_HISTORY_MAX_BYTES} bytes"
        )))
    } else {
        Ok(())
    };
    timings.record_validation(started.elapsed(), result.is_ok());
    result
}

fn verify_hash(
    bytes: &[u8],
    expected_hash: &str,
    prefix_attribution: Option<RestoredSessionHistoryPrefixAttribution>,
    timings: &mut SessionHistoryCpuTimings,
    cancel: &CancellationToken,
) -> RunnerResult<Option<SessionHistoryPrefixOutcome>> {
    let started = Instant::now();
    let result = (|| {
        let mut observer = SessionHistoryHashObserver::new(prefix_attribution);
        observer.update(bytes, cancel)?;
        observer.finish(expected_hash)
    })();
    timings.record_hash_verification(started.elapsed(), result.is_ok());
    result
}

struct SessionHistoryHashObserver {
    full_hasher: Sha256,
    observed_bytes: u64,
    prefix_hasher: Option<SessionHistoryPrefixHasher>,
}

struct SessionHistoryPrefixHasher {
    hasher: Sha256,
    remaining_bytes: u64,
    expected_hash: String,
    history_size_bytes: u64,
}

impl SessionHistoryHashObserver {
    fn new(prefix_attribution: Option<RestoredSessionHistoryPrefixAttribution>) -> Self {
        Self {
            full_hasher: Sha256::new(),
            observed_bytes: 0,
            prefix_hasher: prefix_attribution.map(SessionHistoryPrefixHasher::new),
        }
    }

    fn update(&mut self, bytes: &[u8], cancel: &CancellationToken) -> RunnerResult<()> {
        for chunk in bytes.chunks(CPU_CHUNK_BYTES) {
            check_cancelled(cancel)?;
            self.full_hasher.update(chunk);
            self.observed_bytes += chunk.len() as u64;
            if let Some(prefix_hasher) = &mut self.prefix_hasher {
                prefix_hasher.update(chunk);
            }
        }
        check_cancelled(cancel)
    }

    fn finish(self, expected_hash: &str) -> RunnerResult<Option<SessionHistoryPrefixOutcome>> {
        let actual_hash = hex::encode(self.full_hasher.finalize());
        if actual_hash != expected_hash {
            return Err(RunnerError::Internal(
                "session history hash mismatch".into(),
            ));
        }
        Ok(self
            .prefix_hasher
            .map(|prefix_hasher| prefix_hasher.finish(self.observed_bytes)))
    }
}

impl SessionHistoryPrefixHasher {
    fn new(attribution: RestoredSessionHistoryPrefixAttribution) -> Self {
        let (expected_hash, history_size_bytes) = attribution.into_parts();
        Self {
            hasher: Sha256::new(),
            remaining_bytes: history_size_bytes,
            expected_hash,
            history_size_bytes,
        }
    }

    fn update(&mut self, bytes: &[u8]) {
        if self.remaining_bytes == 0 {
            return;
        }
        let prefix_bytes = self.remaining_bytes.min(bytes.len() as u64) as usize;
        let prefix = bytes.get(..prefix_bytes).unwrap_or(bytes);
        self.hasher.update(prefix);
        self.remaining_bytes -= prefix_bytes as u64;
    }

    fn finish(self, observed_bytes: u64) -> SessionHistoryPrefixOutcome {
        debug_assert_eq!(self.remaining_bytes, 0);
        if hex::encode(self.hasher.finalize()) == self.expected_hash {
            debug_assert!(observed_bytes > self.history_size_bytes);
            SessionHistoryPrefixOutcome::Verified {
                raw_extension_size: observed_bytes - self.history_size_bytes,
            }
        } else {
            SessionHistoryPrefixOutcome::Divergent
        }
    }
}

fn decompress_history(
    encoded_bytes: &[u8],
    max_raw_bytes: u64,
    encoding: CompressedEncoding,
    cancel: &CancellationToken,
    hooks: &SessionHistoryCpuHooks,
) -> RunnerResult<Vec<u8>> {
    let input = CancellationReader::new(encoded_bytes, cancel.clone(), hooks.clone());
    match encoding {
        CompressedEncoding::Gzip => {
            let mut decoder = MultiGzDecoder::new(input);
            read_compressed_history(&mut decoder, max_raw_bytes, encoding.label(), cancel)
        }
        CompressedEncoding::Zstd => {
            let mut decoder = zstd::stream::read::Decoder::new(input).map_err(|error| {
                RunnerError::Internal(format!("decompress zstd session history: {error}"))
            })?;
            read_compressed_history(&mut decoder, max_raw_bytes, encoding.label(), cancel)
        }
    }
}

fn read_compressed_history(
    decoder: &mut impl Read,
    max_raw_bytes: u64,
    encoding: &str,
    cancel: &CancellationToken,
) -> RunnerResult<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; DECODER_BUFFER_BYTES];
    let mut decoded = 0u64;
    loop {
        check_cancelled(cancel)?;
        let read = decoder.read(&mut buffer).map_err(|error| {
            if cancel.is_cancelled() {
                cpu_cancelled_error()
            } else {
                RunnerError::Internal(format!("decompress {encoding} session history: {error}"))
            }
        })?;
        check_cancelled(cancel)?;
        if read == 0 {
            break;
        }
        decoded += read as u64;
        if decoded > max_raw_bytes {
            return Err(RunnerError::Internal(format!(
                "session history is too large after decompression: {decoded} bytes exceeds {max_raw_bytes} bytes"
            )));
        }
        let chunk = buffer.get(..read).ok_or_else(|| {
            RunnerError::Internal(format!("invalid {encoding} read chunk length"))
        })?;
        bytes.extend_from_slice(chunk);
    }
    Ok(bytes)
}

struct VerifiedCodexZstd {
    timestamp: Option<chrono::DateTime<chrono::Utc>>,
    prefix_outcome: Option<SessionHistoryPrefixOutcome>,
    raw_bytes: Option<Vec<u8>>,
}

fn verify_codex_zstd(
    encoded_bytes: &[u8],
    expected_raw_size: u64,
    expected_hash: &str,
    prefix_attribution: Option<RestoredSessionHistoryPrefixAttribution>,
    timings: &mut SessionHistoryCpuTimings,
    cancel: &CancellationToken,
    hooks: &SessionHistoryCpuHooks,
) -> RunnerResult<VerifiedCodexZstd> {
    let decompression_started = Instant::now();
    let input = CancellationReader::new(encoded_bytes, cancel.clone(), hooks.clone());
    let decoder = match zstd::stream::read::Decoder::new(input) {
        Ok(decoder) => decoder,
        Err(error) => {
            timings.record_decompression(decompression_started.elapsed(), false);
            return Err(RunnerError::Internal(format!(
                "decompress zstd session history: {error}"
            )));
        }
    };
    let decoded = decoder.take(expected_raw_size.saturating_add(1));
    let mut output = CancellationReader::new(decoded, cancel.clone(), hooks.clone());
    let mut observer = SessionHistoryHashObserver::new(prefix_attribution);
    let mut raw_bytes = if expected_raw_size > hooks.codex_raw_restore_threshold() {
        let capacity = usize::try_from(expected_raw_size).map_err(|_| {
            RunnerError::Internal("session history raw size does not fit in memory".into())
        })?;
        Some(Vec::with_capacity(capacity))
    } else {
        None
    };
    let mut decoded_bytes = 0u64;
    let mut timestamp = None;
    let mut timestamp_scanner = Some(CodexTimestampRecordScanner::new(
        hooks.codex_timestamp_record_max_bytes(),
    ));
    let mut buffer = [0u8; DECODER_BUFFER_BYTES];

    loop {
        check_cancelled(cancel)?;
        let read = match output.read(&mut buffer) {
            Ok(read) => read,
            Err(error) => {
                timings.record_decompression(decompression_started.elapsed(), false);
                if cancel.is_cancelled() {
                    return Err(cpu_cancelled_error());
                }
                return Err(RunnerError::Internal(format!(
                    "decompress zstd session history: {error}"
                )));
            }
        };
        check_cancelled(cancel)?;
        if read == 0 {
            break;
        }
        decoded_bytes += read as u64;
        if decoded_bytes > expected_raw_size {
            timings.record_decompression(decompression_started.elapsed(), false);
            return Err(RunnerError::Internal(format!(
                "session history is too large after decompression: {decoded_bytes} bytes exceeds {expected_raw_size} bytes"
            )));
        }
        let chunk = buffer.get(..read).ok_or_else(|| {
            RunnerError::Internal("invalid zstd session history read chunk length".into())
        })?;
        observer.update(chunk, cancel)?;
        if let Some(raw_bytes) = &mut raw_bytes {
            raw_bytes.extend_from_slice(chunk);
        }
        if let Some(scanner) = &mut timestamp_scanner
            && let Some(discovered) = scanner.scan(chunk, cancel, hooks)?
        {
            timestamp = Some(discovered);
            timestamp_scanner = None;
        }
    }
    if let Some(scanner) = &mut timestamp_scanner {
        timestamp = scanner.finish(cancel, hooks)?;
    }
    timings.record_decompression(decompression_started.elapsed(), true);

    let validation_started = Instant::now();
    let size_result = if decoded_bytes == expected_raw_size {
        Ok(())
    } else {
        Err(RunnerError::Internal(format!(
            "session history size mismatch: expected {expected_raw_size} bytes after decompression, got {decoded_bytes} bytes"
        )))
    };
    timings.record_validation(validation_started.elapsed(), size_result.is_ok());
    size_result?;

    let hash_started = Instant::now();
    check_cancelled(cancel)?;
    let hash_result = observer.finish(expected_hash);
    timings.record_hash_verification(hash_started.elapsed(), hash_result.is_ok());
    let prefix_outcome = hash_result?;
    Ok(VerifiedCodexZstd {
        timestamp,
        prefix_outcome,
        raw_bytes,
    })
}

impl CodexTimestampRecordScanner {
    fn new(max_record_bytes: usize) -> Self {
        Self {
            record: Vec::with_capacity(DECODER_BUFFER_BYTES.min(max_record_bytes)),
            max_record_bytes,
            record_too_large: false,
        }
    }

    fn scan(
        &mut self,
        mut bytes: &[u8],
        cancel: &CancellationToken,
        hooks: &SessionHistoryCpuHooks,
    ) -> RunnerResult<Option<chrono::DateTime<chrono::Utc>>> {
        while let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
            let (record_bytes, remaining) = bytes.split_at(newline);
            self.extend_record(record_bytes);
            if let Some(timestamp) = self.finish_record(cancel, hooks)? {
                return Ok(Some(timestamp));
            }
            bytes = remaining.get(1..).unwrap_or_default();
        }
        self.extend_record(bytes);
        Ok(None)
    }

    fn finish(
        &mut self,
        cancel: &CancellationToken,
        hooks: &SessionHistoryCpuHooks,
    ) -> RunnerResult<Option<chrono::DateTime<chrono::Utc>>> {
        if self.record.is_empty() && !self.record_too_large {
            return Ok(None);
        }
        self.finish_record(cancel, hooks)
    }

    fn extend_record(&mut self, bytes: &[u8]) {
        if self.record_too_large {
            return;
        }
        let record_len = self.record.len() + bytes.len();
        if record_len > self.max_record_bytes {
            self.mark_record_too_large();
            return;
        }
        if record_len > self.record.capacity() {
            let target_capacity = self
                .record
                .capacity()
                .saturating_mul(2)
                .max(record_len)
                .min(self.max_record_bytes);
            self.record
                .reserve_exact(target_capacity - self.record.len());
        }
        self.record.extend_from_slice(bytes);
    }

    fn finish_record(
        &mut self,
        cancel: &CancellationToken,
        hooks: &SessionHistoryCpuHooks,
    ) -> RunnerResult<Option<chrono::DateTime<chrono::Utc>>> {
        let timestamp = if self.record_too_large {
            None
        } else {
            let record = self.record.strip_suffix(b"\r").unwrap_or(&self.record);
            parse_codex_timestamp_line(record, cancel, hooks)?
        };
        self.record.clear();
        self.record_too_large = false;
        Ok(timestamp)
    }

    fn mark_record_too_large(&mut self) {
        self.record.clear();
        self.record_too_large = true;
    }
}

fn scan_raw_codex_history(
    history: &[u8],
    cancel: &CancellationToken,
    hooks: &SessionHistoryCpuHooks,
) -> RunnerResult<Option<chrono::DateTime<chrono::Utc>>> {
    if !validate_utf8(history, cancel)? {
        return Ok(None);
    }
    // SAFETY: the complete byte slice was validated immediately above.
    let history = unsafe { std::str::from_utf8_unchecked(history) };
    scan_valid_utf8_history(history, cancel, hooks)
}

#[cfg(test)]
pub(super) fn codex_timestamp_for_test(history: &[u8]) -> Option<chrono::DateTime<chrono::Utc>> {
    scan_raw_codex_history(
        history,
        &CancellationToken::new(),
        &SessionHistoryCpuHooks::default(),
    )
    .unwrap()
}

fn scan_valid_utf8_history(
    history: &str,
    cancel: &CancellationToken,
    hooks: &SessionHistoryCpuHooks,
) -> RunnerResult<Option<chrono::DateTime<chrono::Utc>>> {
    for line in history.split('\n') {
        check_cancelled(cancel)?;
        // Match the streaming scanner: count CR and whitespace before trimming.
        if line.len() > hooks.codex_timestamp_record_max_bytes() {
            continue;
        }
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(timestamp) = parse_valid_utf8_codex_timestamp_line(line, cancel, hooks)? {
            return Ok(Some(timestamp));
        }
    }
    Ok(None)
}

fn parse_codex_timestamp_line(
    line: &[u8],
    cancel: &CancellationToken,
    hooks: &SessionHistoryCpuHooks,
) -> RunnerResult<Option<chrono::DateTime<chrono::Utc>>> {
    if !validate_utf8(line, cancel)? {
        return Ok(None);
    }
    // SAFETY: the complete byte slice was validated immediately above.
    let line = unsafe { std::str::from_utf8_unchecked(line) };
    parse_valid_utf8_codex_timestamp_line(line, cancel, hooks)
}

fn parse_valid_utf8_codex_timestamp_line(
    line: &str,
    cancel: &CancellationToken,
    hooks: &SessionHistoryCpuHooks,
) -> RunnerResult<Option<chrono::DateTime<chrono::Utc>>> {
    let line = trim_unicode_whitespace(line, cancel)?;
    if line.is_empty() {
        return Ok(None);
    }

    let reader = CancellationReader::new(line.as_bytes(), cancel.clone(), hooks.clone());
    let reader = BufReader::with_capacity(DECODER_BUFFER_BYTES, reader);
    let value = match serde_json::from_reader::<_, serde_json::Value>(reader) {
        Ok(value) => value,
        Err(_) if cancel.is_cancelled() => return Err(cpu_cancelled_error()),
        Err(_) => return Ok(None),
    };
    check_cancelled(cancel)?;
    if value.get("type").and_then(|value| value.as_str()) != Some("session_meta") {
        return Ok(None);
    }

    Ok(value
        .get("payload")
        .and_then(|payload| payload.get("timestamp"))
        .and_then(|timestamp| timestamp.as_str())
        .and_then(parse_codex_rollout_timestamp)
        .or_else(|| {
            value
                .get("timestamp")
                .and_then(|timestamp| timestamp.as_str())
                .and_then(parse_codex_rollout_timestamp)
        }))
}

fn trim_unicode_whitespace<'a>(line: &'a str, cancel: &CancellationToken) -> RunnerResult<&'a str> {
    let mut start = line.len();
    let mut last_check = 0usize;
    for (index, character) in line.char_indices() {
        if index.saturating_sub(last_check) >= DECODER_BUFFER_BYTES {
            check_cancelled(cancel)?;
            last_check = index;
        }
        if !character.is_whitespace() {
            start = index;
            break;
        }
    }
    if start == line.len() {
        check_cancelled(cancel)?;
        return Ok("");
    }

    let mut end = line.len();
    last_check = end;
    for (relative_index, character) in line[start..].char_indices().rev() {
        let index = start + relative_index;
        if last_check.saturating_sub(index) >= DECODER_BUFFER_BYTES {
            check_cancelled(cancel)?;
            last_check = index;
        }
        if !character.is_whitespace() {
            end = index + character.len_utf8();
            break;
        }
    }
    check_cancelled(cancel)?;
    Ok(&line[start..end])
}

fn validate_utf8(bytes: &[u8], cancel: &CancellationToken) -> RunnerResult<bool> {
    let mut start = 0usize;
    while start < bytes.len() {
        check_cancelled(cancel)?;
        let mut end = start.saturating_add(CPU_CHUNK_BYTES).min(bytes.len());
        if bytes.get(end).copied().is_some_and(is_utf8_continuation) {
            let mut boundary = end;
            let mut continuation_bytes = 0usize;
            while boundary > start
                && bytes
                    .get(boundary)
                    .copied()
                    .is_some_and(is_utf8_continuation)
                && continuation_bytes <= 3
            {
                boundary -= 1;
                continuation_bytes += 1;
            }
            if continuation_bytes > 3 {
                return Ok(false);
            }
            end = boundary;
        }
        let Some(chunk) = bytes.get(start..end) else {
            return Ok(false);
        };
        if end == start || std::str::from_utf8(chunk).is_err() {
            return Ok(false);
        }
        start = end;
    }
    check_cancelled(cancel)?;
    Ok(true)
}

fn is_utf8_continuation(byte: u8) -> bool {
    byte & 0b1100_0000 == 0b1000_0000
}

fn parse_codex_rollout_timestamp(raw: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|timestamp| timestamp.with_timezone(&chrono::Utc))
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H-%M-%S")
                .ok()
                .map(|timestamp| {
                    chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
                        timestamp,
                        chrono::Utc,
                    )
                })
        })
}

fn check_cancelled(cancel: &CancellationToken) -> RunnerResult<()> {
    if cancel.is_cancelled() {
        return Err(cpu_cancelled_error());
    }
    Ok(())
}

fn cpu_cancelled_error() -> RunnerError {
    RunnerError::Cancelled
}

#[cfg(test)]
#[derive(Clone)]
pub(in crate::executor) struct SessionHistoryCpuTestGate {
    inner: Arc<SessionHistoryCpuTestGateInner>,
}

#[cfg(test)]
struct SessionHistoryCpuTestGateInner {
    mode: SessionHistoryCpuTestGateMode,
    state: Mutex<SessionHistoryCpuTestGateState>,
    release: Condvar,
    submitted: Semaphore,
    entered: Semaphore,
    completed: Semaphore,
}

#[cfg(test)]
#[derive(Clone, Copy)]
enum SessionHistoryCpuTestGateMode {
    Every,
    Entry(usize),
}

#[cfg(test)]
#[derive(Default)]
struct SessionHistoryCpuTestGateState {
    entries: usize,
    releases: usize,
}

#[cfg(test)]
impl SessionHistoryCpuTestGate {
    pub(in crate::executor) fn every_entry() -> Self {
        Self::new(SessionHistoryCpuTestGateMode::Every)
    }

    pub(in crate::executor) fn at_entry(entry: usize) -> Self {
        Self::new(SessionHistoryCpuTestGateMode::Entry(entry.max(1)))
    }

    fn new(mode: SessionHistoryCpuTestGateMode) -> Self {
        Self {
            inner: Arc::new(SessionHistoryCpuTestGateInner {
                mode,
                state: Mutex::new(SessionHistoryCpuTestGateState::default()),
                release: Condvar::new(),
                submitted: Semaphore::new(0),
                entered: Semaphore::new(0),
                completed: Semaphore::new(0),
            }),
        }
    }

    fn record_submission(&self) {
        self.inner.submitted.add_permits(1);
    }

    fn enter(&self, cancel: &CancellationToken) -> bool {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.entries += 1;
        let entry = state.entries;
        self.inner.entered.add_permits(1);
        let should_block = match self.inner.mode {
            SessionHistoryCpuTestGateMode::Every => true,
            SessionHistoryCpuTestGateMode::Entry(blocked_entry) => entry == blocked_entry,
        };
        while should_block && state.releases == 0 && !cancel.is_cancelled() {
            let (next_state, _) = self
                .inner
                .release
                .wait_timeout(state, Duration::from_millis(5))
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next_state;
        }
        if should_block && state.releases > 0 {
            state.releases -= 1;
        }
        drop(state);
        self.inner.completed.add_permits(1);
        !cancel.is_cancelled()
    }

    pub(in crate::executor) fn release_one(&self) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.releases += 1;
        drop(state);
        self.inner.release.notify_one();
    }

    pub(in crate::executor) async fn wait_submitted(&self) {
        self.inner
            .submitted
            .acquire()
            .await
            .expect("test submission semaphore should remain open")
            .forget();
    }

    pub(in crate::executor) async fn wait_entered(&self) {
        self.inner
            .entered
            .acquire()
            .await
            .expect("test entry semaphore should remain open")
            .forget();
    }

    pub(in crate::executor) async fn wait_completed(&self) {
        self.inner
            .completed
            .acquire()
            .await
            .expect("test completion semaphore should remain open")
            .forget();
    }

    fn entry_count(&self) -> usize {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entries
    }
}

struct CancellationReader<R> {
    inner: R,
    cancel: CancellationToken,
    hooks: SessionHistoryCpuHooks,
}

impl<R> CancellationReader<R> {
    fn new(inner: R, cancel: CancellationToken, hooks: SessionHistoryCpuHooks) -> Self {
        Self {
            inner,
            cancel,
            hooks,
        }
    }
}

impl<R: Read> Read for CancellationReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.cancel.is_cancelled() {
            return Err(io::Error::other(CPU_CANCELLED));
        }
        let read = self.inner.read(buffer)?;
        self.hooks.reader_checkpoint(&self.cancel)?;
        if self.cancel.is_cancelled() {
            return Err(io::Error::other(CPU_CANCELLED));
        }
        Ok(read)
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::io::Write;

    use tokio::sync::oneshot;

    use super::*;

    fn raw_job(history: Vec<u8>, framework: EffectiveCliFramework) -> SessionHistoryCpuJob {
        SessionHistoryCpuJob::raw(
            "sess-123".into(),
            history.clone(),
            history.len() as u64,
            hex::encode(Sha256::digest(&history)),
            framework,
        )
    }

    fn codex_zstd_job(history: &[u8]) -> SessionHistoryCpuJob {
        SessionHistoryCpuJob::zstd(
            "019e9154-c304-70f0-adde-36efb1be1701".into(),
            zstd::encode_all(history, 0).expect("test history should compress"),
            history.len() as u64,
            hex::encode(Sha256::digest(history)),
            EffectiveCliFramework::Codex,
        )
    }

    async fn wait_for<T>(future: impl Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(5), future)
            .await
            .expect("test synchronization should complete")
    }

    fn padded_codex_timestamp_record(record_len: usize) -> Vec<u8> {
        let prefix =
            br#"{"type":"session_meta","payload":{"timestamp":"2026-07-13T01:02:03Z","padding":""#;
        let suffix = br#""}}"#;
        assert!(prefix.len() + suffix.len() <= record_len);
        let mut record = Vec::with_capacity(record_len);
        record.extend_from_slice(prefix);
        record.resize(record_len - suffix.len(), b'x');
        record.extend_from_slice(suffix);
        record
    }

    async fn assert_codex_timestamp_for_all_job_kinds(
        history: &[u8],
        expected_timestamp: Option<&str>,
    ) {
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(history).unwrap();
        let jobs = [
            (
                "identity",
                raw_job(history.to_vec(), EffectiveCliFramework::Codex),
            ),
            (
                "gzip",
                SessionHistoryCpuJob::gzip(
                    "sess-123".into(),
                    gzip.finish().unwrap(),
                    history.len() as u64,
                    hex::encode(Sha256::digest(history)),
                    EffectiveCliFramework::Codex,
                ),
            ),
            (
                "inline",
                SessionHistoryCpuJob::inline_codex(
                    "sess-123".into(),
                    Arc::new(String::from_utf8(history.to_vec()).unwrap()),
                ),
            ),
            ("zstd", codex_zstd_job(history)),
        ];
        let pool = SessionHistoryCpuPool::with_capacity(1);
        for (kind, job) in jobs {
            let session = pool
                .materialize(job, &CancellationToken::new())
                .await
                .unwrap()
                .result
                .unwrap()
                .session;
            assert_eq!(
                session
                    .codex_timestamp()
                    .map(|timestamp| timestamp.to_rfc3339())
                    .as_deref(),
                expected_timestamp,
                "{kind}: timestamp for {} history bytes",
                history.len(),
            );
            if let Some(encoded) = session.codex_zstd_history() {
                assert_eq!(zstd::decode_all(encoded).unwrap(), history, "{kind}");
            } else {
                assert_eq!(session.history_bytes(), history, "{kind}");
            }
        }
    }

    #[tokio::test]
    async fn codex_timestamp_jobs_enforce_record_byte_limit() {
        let limit = CODEX_TIMESTAMP_RECORD_MAX_BYTES;
        let timestamp = Some("2026-07-13T01:02:03+00:00");
        for (record_len, suffix, expected) in [
            (limit, "", timestamp),
            (limit, "\n", timestamp),
            (limit + 1, "", None),
            (limit + 1, "\n", None),
            (limit - 1, "\r\n", timestamp),
            (limit, "\r\n", None),
            (limit - 3, "\u{2003}\n", timestamp),
            (limit - 2, "\u{2003}\n", None),
        ] {
            let mut history = padded_codex_timestamp_record(record_len);
            history.extend_from_slice(suffix.as_bytes());
            assert_codex_timestamp_for_all_job_kinds(&history, expected).await;
        }
    }

    #[tokio::test]
    async fn codex_timestamp_jobs_recover_after_oversized_metadata() {
        let oversized = padded_codex_timestamp_record(CODEX_TIMESTAMP_RECORD_MAX_BYTES + 1);
        let mut whitespace_padded = padded_codex_timestamp_record(128);
        whitespace_padded.resize(CODEX_TIMESTAMP_RECORD_MAX_BYTES + 1, b' ');
        for mut history in [oversized, whitespace_padded] {
            history.extend_from_slice(b"\r\n");
            history.extend_from_slice(
                "\u{2003}{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-07-14T04:05:06Z\"}}\u{2003}"
                    .as_bytes(),
            );
            assert_codex_timestamp_for_all_job_kinds(&history, Some("2026-07-14T04:05:06+00:00"))
                .await;
        }
    }

    #[test]
    fn codex_timestamp_scanner_bounds_candidates_and_recovers_at_record_boundaries() {
        const RECORD_LIMIT: usize = 128;

        let cancel = CancellationToken::new();
        let hooks = SessionHistoryCpuHooks::default();
        let exact_record = padded_codex_timestamp_record(RECORD_LIMIT);
        let mut scanner = CodexTimestampRecordScanner::new(RECORD_LIMIT);
        for chunk in exact_record.chunks(17) {
            assert!(scanner.scan(chunk, &cancel, &hooks).unwrap().is_none());
            assert!(scanner.record.len() <= RECORD_LIMIT);
            assert!(scanner.record.capacity() <= RECORD_LIMIT);
        }
        let timestamp = scanner.finish(&cancel, &hooks).unwrap().unwrap();
        assert_eq!(timestamp.to_rfc3339(), "2026-07-13T01:02:03+00:00");

        let mut scanner = CodexTimestampRecordScanner::new(RECORD_LIMIT);
        let oversized_record = vec![b'x'; RECORD_LIMIT + 1];
        assert!(
            scanner
                .scan(&oversized_record, &cancel, &hooks)
                .unwrap()
                .is_none()
        );
        assert!(scanner.record_too_large);
        assert!(scanner.record.is_empty());
        assert!(scanner.record.capacity() <= RECORD_LIMIT);

        let mut next_record = b"\r\n".to_vec();
        next_record.extend_from_slice(
            br#"{"type":"session_meta","payload":{"timestamp":"2026-07-13T01:02:03Z"}}"#,
        );
        next_record.extend_from_slice(b"\r\n");
        let timestamp = scanner
            .scan(&next_record, &cancel, &hooks)
            .unwrap()
            .unwrap();
        assert_eq!(timestamp.to_rfc3339(), "2026-07-13T01:02:03+00:00");
        assert!(scanner.record.is_empty());
        assert!(scanner.record.capacity() <= RECORD_LIMIT);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bounded_cpu_work_keeps_runtime_responsive_and_serializes_admission() {
        let gate = SessionHistoryCpuTestGate::every_entry();
        let pool = SessionHistoryCpuPool::with_test_gates(1, Some(gate.clone()), None);

        let first_pool = pool.clone();
        let first = tokio::spawn(async move {
            first_pool
                .materialize(
                    raw_job(b"first".to_vec(), EffectiveCliFramework::ClaudeCode),
                    &CancellationToken::new(),
                )
                .await
        });
        wait_for(gate.wait_submitted()).await;
        wait_for(gate.wait_entered()).await;

        let (runtime_progress_tx, runtime_progress_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = runtime_progress_tx.send(());
        });
        wait_for(runtime_progress_rx)
            .await
            .expect("unrelated async task should run");

        let second_pool = pool.clone();
        let second = tokio::spawn(async move {
            second_pool
                .materialize(
                    raw_job(b"second".to_vec(), EffectiveCliFramework::ClaudeCode),
                    &CancellationToken::new(),
                )
                .await
        });
        wait_for(gate.wait_submitted()).await;
        assert_eq!(gate.entry_count(), 1);

        gate.release_one();
        let first = wait_for(first).await.unwrap().unwrap();
        first.result.unwrap();
        wait_for(gate.wait_entered()).await;
        assert_eq!(gate.entry_count(), 2);
        gate.release_one();
        let second = wait_for(second).await.unwrap().unwrap();
        second.result.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn active_cpu_cancellation_joins_cooperative_work() {
        let gate = SessionHistoryCpuTestGate::every_entry();
        let pool = SessionHistoryCpuPool::with_test_gates(1, Some(gate.clone()), None);
        let cancel = CancellationToken::new();
        let task_pool = pool.clone();
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            task_pool
                .materialize(
                    raw_job(b"cancel".to_vec(), EffectiveCliFramework::ClaudeCode),
                    &task_cancel,
                )
                .await
        });
        wait_for(gate.wait_submitted()).await;
        wait_for(gate.wait_entered()).await;

        cancel.cancel();
        let error = wait_for(task).await.unwrap().unwrap_err();
        assert!(matches!(error, RunnerError::Cancelled));
        wait_for(gate.wait_completed()).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dropping_cpu_future_signals_blocking_work() {
        let gate = SessionHistoryCpuTestGate::every_entry();
        let pool = SessionHistoryCpuPool::with_test_gates(1, Some(gate.clone()), None);
        let task = tokio::spawn(async move {
            pool.materialize(
                raw_job(b"drop".to_vec(), EffectiveCliFramework::ClaudeCode),
                &CancellationToken::new(),
            )
            .await
        });
        wait_for(gate.wait_entered()).await;

        task.abort();
        assert!(wait_for(task).await.unwrap_err().is_cancelled());
        wait_for(gate.wait_completed()).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_while_waiting_for_cpu_does_not_start_work() {
        let gate = SessionHistoryCpuTestGate::every_entry();
        let pool = SessionHistoryCpuPool::with_test_gates(1, Some(gate.clone()), None);
        let first_pool = pool.clone();
        let first = tokio::spawn(async move {
            first_pool
                .materialize(
                    raw_job(b"first".to_vec(), EffectiveCliFramework::ClaudeCode),
                    &CancellationToken::new(),
                )
                .await
        });
        wait_for(gate.wait_submitted()).await;
        wait_for(gate.wait_entered()).await;

        let cancel = CancellationToken::new();
        let second_cancel = cancel.clone();
        let second_pool = pool.clone();
        let second = tokio::spawn(async move {
            second_pool
                .materialize(
                    raw_job(b"second".to_vec(), EffectiveCliFramework::ClaudeCode),
                    &second_cancel,
                )
                .await
        });
        wait_for(gate.wait_submitted()).await;
        cancel.cancel();
        let error = wait_for(second).await.unwrap().unwrap_err();
        assert!(matches!(error, RunnerError::Cancelled));
        assert_eq!(gate.entry_count(), 1);

        gate.release_one();
        wait_for(first).await.unwrap().unwrap().result.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_interrupts_buffered_json_parse_within_large_line() {
        let reader_gate = SessionHistoryCpuTestGate::at_entry(1);
        let pool = SessionHistoryCpuPool::with_test_gates(1, None, Some(reader_gate.clone()));
        let history = Arc::new(format!(
            "{{\"type\":\"not_meta\",\"padding\":\"{}\"}}",
            "x".repeat(DECODER_BUFFER_BYTES * 3)
        ));
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let task = tokio::spawn(async move {
            pool.materialize(
                SessionHistoryCpuJob::inline_codex("sess-123".into(), history),
                &task_cancel,
            )
            .await
        });
        wait_for(reader_gate.wait_entered()).await;

        cancel.cancel();
        let error = wait_for(task).await.unwrap().unwrap_err();
        assert!(matches!(error, RunnerError::Cancelled));
        wait_for(reader_gate.wait_completed()).await;
    }

    #[tokio::test]
    async fn raw_codex_timestamp_scan_handles_utf8_across_chunk_boundary() {
        let mut history = "x".repeat(CPU_CHUNK_BYTES - 1).into_bytes();
        history.extend_from_slice("é\n".as_bytes());
        history.extend_from_slice(
            br#"{"type":"session_meta","payload":{"timestamp":"2026-07-13T01:02:03Z"}}"#,
        );
        let outcome = SessionHistoryCpuPool::with_capacity(1)
            .materialize(
                raw_job(history, EffectiveCliFramework::Codex),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let materialization = outcome.result.unwrap();
        assert_eq!(
            materialization
                .session
                .codex_timestamp()
                .map(|timestamp| timestamp.to_rfc3339())
                .as_deref(),
            Some("2026-07-13T01:02:03+00:00")
        );
    }

    #[tokio::test]
    async fn raw_codex_timestamp_scan_preserves_whole_payload_utf8_requirement() {
        let mut history =
            b"{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-07-13T01:02:03Z\"}}\n"
                .to_vec();
        history.push(0xff);
        let outcome = SessionHistoryCpuPool::with_capacity(1)
            .materialize(
                raw_job(history, EffectiveCliFramework::Codex),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(outcome.result.unwrap().session.codex_timestamp().is_none());
    }

    #[tokio::test]
    async fn codex_zstd_restore_materializes_raw_only_above_pruning_guard() {
        let history =
            b"{\"type\":\"session_meta\",\"payload\":{\"timestamp\":\"2026-07-13T01:02:03Z\"}}\n";
        let encoded = zstd::encode_all(history.as_slice(), 0).unwrap();

        let encoded_outcome =
            SessionHistoryCpuPool::with_test_codex_raw_restore_threshold(1, history.len() as u64)
                .materialize(codex_zstd_job(history), &CancellationToken::new())
                .await
                .unwrap()
                .result
                .unwrap();
        assert_eq!(encoded_outcome.session.history_bytes(), encoded);
        assert_eq!(
            encoded_outcome.session.codex_zstd_history(),
            Some(encoded.as_slice())
        );

        let raw_outcome = SessionHistoryCpuPool::with_test_codex_raw_restore_threshold(
            1,
            history.len() as u64 - 1,
        )
        .materialize(codex_zstd_job(history), &CancellationToken::new())
        .await
        .unwrap()
        .result
        .unwrap();
        assert_eq!(raw_outcome.session.history_bytes(), history);
        assert!(raw_outcome.session.codex_zstd_history().is_none());
        assert_eq!(
            raw_outcome
                .session
                .codex_timestamp()
                .map(|timestamp| timestamp.to_rfc3339())
                .as_deref(),
            Some("2026-07-13T01:02:03+00:00")
        );
    }

    #[tokio::test]
    async fn compressed_history_rejects_declared_raw_size_above_limit() {
        let outcome = SessionHistoryCpuPool::with_capacity(1)
            .materialize(
                SessionHistoryCpuJob::zstd(
                    "sess-123".into(),
                    Vec::new(),
                    RESUME_SESSION_HISTORY_MAX_BYTES + 1,
                    String::new(),
                    EffectiveCliFramework::Codex,
                ),
                &CancellationToken::new(),
            )
            .await
            .unwrap();

        assert!(
            outcome
                .result
                .unwrap_err()
                .to_string()
                .contains("rawSize is too large")
        );
        assert!(!outcome.timings.validation().unwrap().success());
    }
}
