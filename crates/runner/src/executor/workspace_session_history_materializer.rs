//! Owned host-side materialization for a validated workspace history sidecar.
//!
//! Fresh workspace preparation opens the validated sidecar while its cache
//! entry lease is held, then transfers the file into this owner. The file read
//! and bounded CPU work can overlap sandbox startup; the executor consumes the
//! result only after guest storage preparation and performs guest restore
//! separately.

use std::time::{Duration, Instant};

use tokio::fs::File;
use tokio::io::AsyncReadExt;
use tokio::task::{JoinError, JoinHandle};
use tokio_util::sync::CancellationToken;

use super::cli_framework::EffectiveCliFramework;
use super::session_history_cpu::{SessionHistoryCpuJob, SessionHistoryCpuPool};
use super::session_restore::MaterializedResumeSession;
use crate::error::{RunnerError, RunnerResult};
use crate::telemetry::WorkspaceSessionHistoryTelemetry;
use crate::types::ResumeSession;
use crate::workspace_image_cache::{
    WorkspaceSessionHistorySidecar, WorkspaceSessionHistorySidecarRepresentation,
};

/// Owns prestarted file read and bounded CPU work for one workspace sidecar.
pub(crate) struct WorkspaceSessionHistoryMaterializer {
    state: WorkspaceSessionHistoryMaterializerState,
}

enum WorkspaceSessionHistoryMaterializerState {
    Completed(WorkspaceSessionHistoryMaterialization),
    Materializing {
        cancel: CancellationToken,
        task: JoinHandle<WorkspaceSessionHistoryMaterialization>,
    },
    Consumed,
}

struct WorkspaceSessionHistoryTaskInput {
    file: File,
    sidecar: WorkspaceSessionHistorySidecar,
    cli_agent_session_id: String,
    expected_raw_size: u64,
    expected_hash: String,
    framework: EffectiveCliFramework,
}

/// One-shot result produced by [`WorkspaceSessionHistoryMaterializer`].
pub(super) enum WorkspaceSessionHistoryMaterialization {
    Materialized {
        session: MaterializedResumeSession,
        timings: WorkspaceSessionHistoryTimings,
        telemetry: WorkspaceSessionHistoryTelemetry,
    },
    Failed {
        timings: WorkspaceSessionHistoryTimings,
        error: RunnerError,
    },
}

/// Fixed host-side timings carried from background work to executor telemetry.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct WorkspaceSessionHistoryTimings {
    file_read: Option<WorkspaceSessionHistoryPhaseTiming>,
    cpu_admission_wait: Option<Duration>,
    materialization: Option<WorkspaceSessionHistoryPhaseTiming>,
}

/// Result and duration of one fixed workspace-sidecar phase.
#[derive(Clone, Copy, Debug)]
pub(super) struct WorkspaceSessionHistoryPhaseTiming {
    elapsed: Duration,
    success: bool,
}

impl WorkspaceSessionHistoryMaterializer {
    /// Opens the validated sidecar and starts body read plus bounded CPU work.
    pub(super) async fn start(
        sidecar: WorkspaceSessionHistorySidecar,
        resume_session: Option<&ResumeSession>,
        framework: EffectiveCliFramework,
        cpu: &SessionHistoryCpuPool,
        cancel: CancellationToken,
    ) -> Self {
        let Some(resume_session) = resume_session else {
            return Self::completed_failure(
                WorkspaceSessionHistoryTimings::default(),
                RunnerError::Internal("resume session missing for sidecar restore".into()),
            );
        };
        let Some(history_ref) = resume_session.history_ref() else {
            return Self::completed_failure(
                WorkspaceSessionHistoryTimings::default(),
                RunnerError::Internal(
                    "resume session history ref missing for sidecar restore".into(),
                ),
            );
        };

        let open_started = Instant::now();
        let file = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(RunnerError::Cancelled),
            result = File::open(&sidecar.path) => result.map_err(RunnerError::from),
        };
        let open_elapsed = open_started.elapsed();
        let file = match file {
            Ok(file) => file,
            Err(error) => {
                return Self::completed_failure(
                    WorkspaceSessionHistoryTimings {
                        file_read: Some(WorkspaceSessionHistoryPhaseTiming::new(
                            open_elapsed,
                            false,
                        )),
                        ..WorkspaceSessionHistoryTimings::default()
                    },
                    error,
                );
            }
        };

        let cpu = cpu.clone();
        let cli_agent_session_id = resume_session.cli_agent_session_id.clone();
        let expected_raw_size = history_ref.raw_size;
        let expected_hash = history_ref.hash.clone();
        let task_cancel = cancel.child_token();
        let task_cancel_for_task = task_cancel.clone();
        let task = tokio::spawn(async move {
            materialize_workspace_sidecar(
                WorkspaceSessionHistoryTaskInput {
                    file,
                    sidecar,
                    cli_agent_session_id,
                    expected_raw_size,
                    expected_hash,
                    framework,
                },
                cpu,
                open_elapsed,
                task_cancel_for_task,
            )
            .await
        });
        Self {
            state: WorkspaceSessionHistoryMaterializerState::Materializing {
                cancel: task_cancel,
                task,
            },
        }
    }

    fn completed_failure(timings: WorkspaceSessionHistoryTimings, error: RunnerError) -> Self {
        Self {
            state: WorkspaceSessionHistoryMaterializerState::Completed(
                WorkspaceSessionHistoryMaterialization::Failed { timings, error },
            ),
        }
    }

    /// Returns whether background work has already produced its result.
    pub(super) fn is_finished(&self) -> bool {
        match &self.state {
            WorkspaceSessionHistoryMaterializerState::Completed(_) => true,
            WorkspaceSessionHistoryMaterializerState::Materializing { task, .. } => {
                task.is_finished()
            }
            WorkspaceSessionHistoryMaterializerState::Consumed => true,
        }
    }

    /// Consumes the owner and returns its result, giving cancellation priority.
    pub(super) async fn finish(
        mut self,
        cancel: &CancellationToken,
    ) -> WorkspaceSessionHistoryMaterialization {
        let state = std::mem::replace(
            &mut self.state,
            WorkspaceSessionHistoryMaterializerState::Consumed,
        );
        match state {
            WorkspaceSessionHistoryMaterializerState::Completed(result) => {
                if cancel.is_cancelled() {
                    result.into_cancelled()
                } else {
                    result
                }
            }
            WorkspaceSessionHistoryMaterializerState::Materializing {
                cancel: task_cancel,
                mut task,
            } => {
                if cancel.is_cancelled() || task_cancel.is_cancelled() {
                    task_cancel.cancel();
                    return joined_materialization(task.await).into_cancelled();
                }
                let (result, cancellation_observed) = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => {
                        task_cancel.cancel();
                        (joined_materialization(task.await), true)
                    }
                    _ = task_cancel.cancelled() => {
                        (joined_materialization(task.await), true)
                    }
                    joined = &mut task => (joined_materialization(joined), false),
                };
                if cancellation_observed || cancel.is_cancelled() || task_cancel.is_cancelled() {
                    result.into_cancelled()
                } else {
                    result
                }
            }
            WorkspaceSessionHistoryMaterializerState::Consumed => {
                WorkspaceSessionHistoryMaterialization::Failed {
                    timings: WorkspaceSessionHistoryTimings::default(),
                    error: RunnerError::Internal(
                        "workspace session history materializer was already consumed".into(),
                    ),
                }
            }
        }
    }

    /// Cancels and joins owned work before its workspace cache entry changes.
    pub(super) async fn cancel(mut self) {
        let state = std::mem::replace(
            &mut self.state,
            WorkspaceSessionHistoryMaterializerState::Consumed,
        );
        if let WorkspaceSessionHistoryMaterializerState::Materializing { cancel, task } = state {
            cancel.cancel();
            let _ = task.await;
        }
    }
}

impl Drop for WorkspaceSessionHistoryMaterializer {
    fn drop(&mut self) {
        if let WorkspaceSessionHistoryMaterializerState::Materializing { cancel, task } =
            &self.state
        {
            cancel.cancel();
            task.abort();
        }
    }
}

impl WorkspaceSessionHistoryMaterialization {
    fn into_cancelled(self) -> Self {
        let timings = match self {
            Self::Materialized { timings, .. } | Self::Failed { timings, .. } => timings,
        };
        Self::Failed {
            timings,
            error: RunnerError::Cancelled,
        }
    }
}

impl WorkspaceSessionHistoryTimings {
    pub(crate) fn file_read(self) -> Option<WorkspaceSessionHistoryPhaseTiming> {
        self.file_read
    }

    pub(crate) fn cpu_admission_wait(self) -> Option<Duration> {
        self.cpu_admission_wait
    }

    pub(crate) fn materialization(self) -> Option<WorkspaceSessionHistoryPhaseTiming> {
        self.materialization
    }

    pub(crate) fn host_service_time(self) -> Duration {
        self.file_read
            .map(WorkspaceSessionHistoryPhaseTiming::elapsed)
            .unwrap_or_default()
            .saturating_add(
                self.materialization
                    .map(WorkspaceSessionHistoryPhaseTiming::elapsed)
                    .unwrap_or_default(),
            )
    }
}

impl WorkspaceSessionHistoryPhaseTiming {
    const fn new(elapsed: Duration, success: bool) -> Self {
        Self { elapsed, success }
    }

    pub(crate) const fn elapsed(self) -> Duration {
        self.elapsed
    }

    pub(crate) const fn success(self) -> bool {
        self.success
    }
}

async fn materialize_workspace_sidecar(
    input: WorkspaceSessionHistoryTaskInput,
    cpu: SessionHistoryCpuPool,
    open_elapsed: Duration,
    cancel: CancellationToken,
) -> WorkspaceSessionHistoryMaterialization {
    let WorkspaceSessionHistoryTaskInput {
        file,
        sidecar,
        cli_agent_session_id,
        expected_raw_size,
        expected_hash,
        framework,
    } = input;
    let read_started = Instant::now();
    let mut bytes = Vec::with_capacity(sidecar.encoded_size.min(1024 * 1024) as usize);
    let mut limited_file = file.take(sidecar.encoded_size.saturating_add(1));
    let read_result: RunnerResult<()> = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(RunnerError::Cancelled),
        result = limited_file.read_to_end(&mut bytes) => {
            result.map(|_| ()).map_err(RunnerError::from)
        },
    };
    let read_elapsed = open_elapsed.saturating_add(read_started.elapsed());
    if let Err(error) = read_result {
        return WorkspaceSessionHistoryMaterialization::Failed {
            timings: WorkspaceSessionHistoryTimings {
                file_read: Some(WorkspaceSessionHistoryPhaseTiming::new(read_elapsed, false)),
                ..WorkspaceSessionHistoryTimings::default()
            },
            error,
        };
    }
    if bytes.len() as u64 != sidecar.encoded_size {
        return WorkspaceSessionHistoryMaterialization::Failed {
            timings: WorkspaceSessionHistoryTimings {
                file_read: Some(WorkspaceSessionHistoryPhaseTiming::new(read_elapsed, false)),
                ..WorkspaceSessionHistoryTimings::default()
            },
            error: RunnerError::Internal("workspace session history sidecar size mismatch".into()),
        };
    }

    let job = match sidecar.representation {
        WorkspaceSessionHistorySidecarRepresentation::Raw => SessionHistoryCpuJob::raw(
            cli_agent_session_id,
            bytes,
            expected_raw_size,
            expected_hash,
            framework,
        ),
        WorkspaceSessionHistorySidecarRepresentation::CodexZstd => SessionHistoryCpuJob::zstd(
            cli_agent_session_id,
            bytes,
            expected_raw_size,
            expected_hash,
            EffectiveCliFramework::Codex,
        ),
    };
    let materialization_started = Instant::now();
    let cpu_outcome = cpu.materialize(job, &cancel).await;
    let materialization_elapsed = materialization_started.elapsed();
    let mut timings = WorkspaceSessionHistoryTimings {
        file_read: Some(WorkspaceSessionHistoryPhaseTiming::new(read_elapsed, true)),
        materialization: Some(WorkspaceSessionHistoryPhaseTiming::new(
            materialization_elapsed,
            cpu_outcome
                .as_ref()
                .is_ok_and(|outcome| outcome.result.is_ok()),
        )),
        ..WorkspaceSessionHistoryTimings::default()
    };
    let cpu_outcome = match cpu_outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            return WorkspaceSessionHistoryMaterialization::Failed { timings, error };
        }
    };
    timings.cpu_admission_wait = Some(cpu_outcome.timings.admission_wait());
    match cpu_outcome.result {
        Ok(materialization) => WorkspaceSessionHistoryMaterialization::Materialized {
            telemetry: WorkspaceSessionHistoryTelemetry::new(
                framework.into(),
                expected_raw_size,
                sidecar.encoded_size,
                sidecar.representation,
                materialization.session.codex_zstd_history().is_some(),
                materialization.session.history_bytes().len() as u64,
            ),
            session: materialization.session,
            timings,
        },
        Err(error) => WorkspaceSessionHistoryMaterialization::Failed { timings, error },
    }
}

fn joined_materialization(
    joined: Result<WorkspaceSessionHistoryMaterialization, JoinError>,
) -> WorkspaceSessionHistoryMaterialization {
    joined.unwrap_or_else(|error| WorkspaceSessionHistoryMaterialization::Failed {
        timings: WorkspaceSessionHistoryTimings::default(),
        error: RunnerError::Internal(format!(
            "workspace session history materialization task failed: {error}"
        )),
    })
}
