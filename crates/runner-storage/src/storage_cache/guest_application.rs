//! Guest application handoff while the original population owner continues.

use super::*;
use guest_contracts::storage_manifest::{ArchiveReadiness, Manifest};
use std::sync::atomic::{AtomicBool, Ordering};

/// One transport phase. StoragePlan remains the only semantic planner.
pub struct GuestStorageBatch {
    pub manifest: Manifest,
    pub files: Vec<(String, Arc<decoded::CachedFiles>)>,
}

/// Initial application input and an optional decoded continuation.
///
/// A continuation requires both initial application and host population success.
pub struct GuestStorageInput {
    pub initial: GuestStorageBatch,
    pub decoded_tail: Option<GuestStorageBatch>,
}

impl GuestStorageInput {
    fn from_plan(mut plan: StoragePlan) -> Self {
        let files = plan.take_decoded();
        Self {
            initial: GuestStorageBatch {
                manifest: plan.into_guest_manifest(),
                files,
            },
            decoded_tail: None,
        }
    }

    fn prepare_early(
        mut self,
        readiness: &ArchiveReadiness,
    ) -> RunnerResult<Option<(Self, Vec<u8>)>> {
        readiness
            .validate(&self.initial.manifest)
            .map_err(|error| RunnerError::Internal(error.into()))?;
        self.initial.manifest.archive_readiness = Some(readiness.clone());
        let query = serialize_manifest(&self.initial.manifest)?;
        if query.len() <= guest_contracts::storage_files::MAX_MANIFEST_BYTES {
            return Ok(Some((self, query)));
        }
        if self.initial.files.is_empty() {
            return Ok(None);
        }

        // An early ordinary operation cannot validate the decoded continuation.
        // Check complete bindings and aggregate budgets before any Guest mutation.
        guest_contracts::storage_files::validate_bindings(
            &self.initial.manifest,
            self.initial.files.iter().map(|(mount, _)| mount.as_str()),
        )
        .map_err(|error| RunnerError::Internal(format!("early storage bindings: {error}")))?;
        let groups = self
            .initial
            .files
            .iter()
            .map(|(mount, files)| (mount.as_str(), files.files.as_slice()))
            .collect::<Vec<_>>();
        guest_contracts::storage_files::encoded_payload_len(&groups)
            .map_err(|error| RunnerError::Internal(format!("early storage payload: {error}")))?;
        let selected = self
            .initial
            .files
            .iter()
            .map(|(mount, _)| mount.as_str())
            .collect::<HashSet<_>>();
        let (decoded_storages, ordinary_storages) =
            std::mem::take(&mut self.initial.manifest.storages)
                .into_iter()
                .partition(|entry| selected.contains(entry.mount_path.as_str()));
        let (decoded_artifacts, ordinary_artifacts) =
            std::mem::take(&mut self.initial.manifest.artifacts)
                .into_iter()
                .partition(|entry| selected.contains(entry.mount_path.as_str()));
        self.initial.manifest.storages = ordinary_storages;
        self.initial.manifest.artifacts = ordinary_artifacts;
        self.decoded_tail = Some(GuestStorageBatch {
            manifest: Manifest {
                storages: decoded_storages,
                artifacts: decoded_artifacts,
                cleanup_paths: Vec::new(),
                instruction_cleanups: Vec::new(),
                archive_readiness: None,
            },
            files: std::mem::take(&mut self.initial.files),
        });
        // Cleanup and ordinary dependency ordering remain in the initial phase.
        // Its complete readiness query must still fit the existing Guest limit.
        readiness
            .validate(&self.initial.manifest)
            .map_err(|error| RunnerError::Internal(error.into()))?;
        let query = serialize_manifest(&self.initial.manifest)?;
        if query.len() > guest_contracts::storage_files::MAX_MANIFEST_BYTES {
            return Ok(None);
        }
        Ok(Some((self, query)))
    }
}

fn serialize_manifest(manifest: &Manifest) -> RunnerResult<Vec<u8>> {
    serde_json::to_vec(manifest)
        .map_err(|error| RunnerError::Internal(format!("Guest storage snapshot: {error}")))
}

/// One-shot application handoff, not a detached task or additional cache owner.
///
/// The caller must await both population and application, including when an
/// abort cannot be published. `host_failed` identifies a producer failure before
/// its abort can cause a secondary Guest error.
pub struct GuestApplication {
    input: Option<oneshot::Sender<GuestStorageInput>>,
    runtime: PathBuf,
    run_id: String,
    wait_timeout_ms: u32,
    host_failed: Arc<AtomicBool>,
    pending: Option<ArchiveReadiness>,
    published: HashSet<usize>,
}

impl GuestApplication {
    pub(super) fn mark_failed(&self) {
        self.host_failed.store(true, Ordering::Release);
    }

    pub fn new(
        input: oneshot::Sender<GuestStorageInput>,
        runtime: PathBuf,
        run_id: String,
        wait_timeout: Duration,
        host_failed: Arc<AtomicBool>,
    ) -> RunnerResult<Self> {
        if !runtime.is_absolute() || runtime.to_str().is_none() {
            return Err(RunnerError::Internal(
                "invalid Guest publication runtime".into(),
            ));
        }
        let wait_timeout_ms = u32::try_from(wait_timeout.as_millis())
            .ok()
            .filter(|timeout| *timeout > 0 && *timeout <= ArchiveReadiness::MAX_WAIT_TIMEOUT_MS)
            .ok_or_else(|| RunnerError::Internal("invalid Guest publication budget".into()))?;
        Ok(Self {
            input: Some(input),
            runtime,
            run_id,
            wait_timeout_ms,
            host_failed,
            pending: None,
            published: HashSet::new(),
        })
    }

    fn send(&mut self, input: GuestStorageInput) -> RunnerResult<()> {
        let sender = self.input.take().ok_or_else(|| {
            RunnerError::Internal("Guest storage input already handed off".into())
        })?;
        sender.send(input).map_err(|_| RunnerError::Cancelled)
    }

    pub(super) async fn start_if_useful(
        &mut self,
        sandbox: &dyn Sandbox,
        plan: &StoragePlan,
        pending: &[CacheTargetGroup],
        decoded: &[(CacheTargetGroup, TargetOutcome)],
        ordinary: &[(CacheTargetGroup, TargetOutcome)],
    ) -> RunnerResult<bool> {
        let archive_ready = ordinary
            .iter()
            .any(|(_, outcome)| matches!(outcome, TargetOutcome::Hit));
        if pending.is_empty() || (!archive_ready && decoded.is_empty()) {
            return Ok(false);
        }

        // This clone is consumed immediately into transport bytes/owned file
        // bindings. It never becomes another independently mutable plan.
        let mut snapshot = plan.clone();
        for (group, outcome) in ordinary {
            if matches!(outcome, TargetOutcome::Hit) {
                for target in group
                    .targets()
                    .filter(|target| !plan.has_decoded(target.handle))
                {
                    rewrite_url(&mut snapshot, target);
                }
            }
        }
        for group in pending {
            for target in group
                .targets()
                .filter(|target| !plan.has_decoded(target.handle))
            {
                rewrite_url(&mut snapshot, target);
            }
        }
        let input = GuestStorageInput::from_plan(snapshot);
        let mut seen = HashSet::new();
        let sources = pending
            .iter()
            .map(|group| {
                let target = &group.representative;
                format!(
                    "file://{}",
                    guest_archive_path(&target.name, &target.version)
                )
            })
            .filter(|url| seen.insert(url.clone()))
            .collect();
        let readiness = ArchiveReadiness {
            id: uuid::Uuid::new_v4(),
            sources,
            wait_timeout_ms: Some(self.wait_timeout_ms),
            check_only: true,
        };
        let Some((mut input, query)) = input.prepare_early(&readiness)? else {
            return Ok(false);
        };
        let checked = sandbox
            .apply_storage_manifest(&sandbox::StorageManifestRequest {
                manifest_json: &query,
                run_id: &self.run_id,
                runtime_dir: self.runtime.to_str().ok_or_else(|| {
                    RunnerError::Internal("invalid Guest publication runtime".into())
                })?,
                timeout: Duration::from_millis(u64::from(self.wait_timeout_ms)),
            })
            .await?;
        if checked.stdout_truncated
            || !matches!(
                checked.termination,
                sandbox::ExecTermination::Exited { exit_code: 0 }
            )
        {
            return Err(RunnerError::Internal(
                sandbox::helper_exec::format_helper_exec_failure(
                    "Guest archive eligibility check",
                    &checked,
                ),
            ));
        }
        let eligible: bool = serde_json::from_slice(&checked.stdout).map_err(|error| {
            RunnerError::Internal(format!("invalid Guest archive eligibility: {error}"))
        })?;
        if !eligible {
            return Ok(false);
        }
        let mut readiness = readiness;
        readiness.check_only = false;
        input.initial.manifest.archive_readiness = Some(readiness.clone());
        self.pending = Some(readiness);
        self.send(input).map(|()| true)
    }

    /// Publish one complete staging batch only for an already active handoff.
    pub(super) async fn publish_staged(
        &mut self,
        sandbox: &dyn Sandbox,
        staged: &[(CacheTargetGroup, TargetOutcome)],
    ) -> RunnerResult<()> {
        let Some(readiness) = &self.pending else {
            return Ok(());
        };
        let mut indices = Vec::new();
        for (group, _) in staged {
            let target = &group.representative;
            let url = format!(
                "file://{}",
                guest_archive_path(&target.name, &target.version)
            );
            let index = readiness
                .sources
                .iter()
                .position(|source| source == &url)
                .ok_or_else(|| {
                    RunnerError::Internal("staged source lost its readiness binding".into())
                })?;
            if !self.published.contains(&index) && !indices.contains(&index) {
                indices.push(index);
            }
        }
        let paths = indices
            .iter()
            .map(|index| readiness.ready_path(&self.runtime, *index))
            .collect::<Vec<_>>();
        let writes = paths
            .iter()
            .map(|path| {
                Ok(WriteFileEntry {
                    path: path.to_str().ok_or_else(|| {
                        RunnerError::Internal("invalid Guest readiness path".into())
                    })?,
                    content: &[],
                })
            })
            .collect::<RunnerResult<Vec<_>>>()?;
        if !writes.is_empty() {
            sandbox.write_private_files(&writes).await?;
            self.published.extend(indices);
        }
        Ok(())
    }
}

/// Populate using the existing owners and hand off ordered application phases.
///
/// `prepared` stays borrowed by its Executor, so hard cancellation retains the
/// original delivery for explicit drain. No accepted operation is detached.
pub async fn populate_cache_for_guest(
    prepared: &mut PreparedStorage,
    sandbox: &dyn Sandbox,
    home: &HomePaths,
    telemetry: &mut JobTelemetry,
    decoded: &decoded::DecodedCache,
    mut application: GuestApplication,
) -> RunnerResult<Option<DeferredBackgroundFill>> {
    let result = populate_cache_inner(
        &mut prepared.plan,
        sandbox,
        home,
        telemetry,
        PopulationSources {
            fresh_delivery: Some(&mut prepared.delivery),
            decoded: Some(decoded),
            application: Some(&mut application),
        },
    )
    .await;

    // A consumer can fail while an accepted staging write is still finishing.
    // Settle that write, then stop before admitting a new ready publication.
    let result = if result.is_ok() && prepared.delivery.cancel.is_cancelled() {
        Err(RunnerError::Cancelled)
    } else {
        result
    };

    let result = async {
        match result {
            Ok(deferred) => {
                if let Some(readiness) = &application.pending {
                    let paths = (0..readiness.sources.len())
                        .filter(|index| !application.published.contains(index))
                        .map(|index| readiness.ready_path(&application.runtime, index))
                        .collect::<Vec<_>>();
                    let paths = paths
                        .iter()
                        .map(|path| {
                            path.to_str().ok_or_else(|| {
                                RunnerError::Internal("invalid Guest readiness path".into())
                            })
                        })
                        .collect::<RunnerResult<Vec<_>>>()?;
                    let writes = paths
                        .iter()
                        .map(|path| WriteFileEntry { path, content: &[] })
                        .collect::<Vec<_>>();
                    if writes.is_empty() {
                        return Ok(deferred);
                    }
                    match sandbox.write_private_files(&writes).await {
                        Ok(()) => Ok(deferred),
                        Err(error) => Err(error.into()),
                    }
                } else {
                    application.send(GuestStorageInput::from_plan(prepared.plan.clone()))?;
                    Ok(deferred)
                }
            }
            Err(error) => Err(error),
        }
    }
    .await;
    if result.is_err() {
        application.host_failed.store(true, Ordering::Release);
        prepared.delivery.cancel_and_drain(telemetry).await;
        if let Some(readiness) = &application.pending {
            let path = readiness.failed_path(&application.runtime);
            if let Some(path) = path.to_str() {
                let abort = sandbox.write_private_file(path, &[]).await;
                telemetry.record(
                    "storage_cache_guest_abort_publish",
                    Duration::ZERO,
                    abort.is_ok(),
                    abort.is_err().then_some("abort-publication"),
                );
            }
        }
    }
    result
}
