//! Accepted publication retains exact data and entry custody independently of observers.

use super::super::HOME_PUBLICATION_IO_SLOTS;
use super::super::fs::{
    PinnedImage, StagingFile, move_noreplace, sparse_copy_pinned, sync_directory,
};
use super::super::metadata::HomeImageFileIdentity;
use super::*;
use std::os::unix::fs::MetadataExt;
use tokio::time::Instant;

#[derive(Default)]
pub(super) struct PublicationProgress {
    entry: Option<HomeEntryLock>,
    source: Option<Arc<PinnedImage>>,
    image: Option<PublicationImage>,
    copy_target: Option<StagingFile>,
    previous: Option<HomeCacheMetadata>,
    metadata: Option<HomeCacheMetadata>,
    metadata_pin: Option<StagingFile>,
    committed: bool,
}

struct PublicationImage {
    pin: Arc<PinnedImage>,
    copied: bool,
    location: ImageLocation,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ImageLocation {
    Staging,
    Candidate,
}

impl PublicationProgress {
    pub(super) fn started(&self) -> bool {
        self.entry.is_some()
    }
}

struct PublicationRequest {
    run_id: RunId,
    cache_key: String,
    profile_name: String,
    rootfs_hash: String,
    reuse_key: String,
    working_dir: String,
    active_image: PathBuf,
    image_size_bytes: u64,
    terminal_status: HomeCacheTerminalStatus,
    completed_at: String,
    storage_fingerprints: StorageFingerprints,
    history_proof: Option<HomeCacheHistoryProofBinding>,
}

impl PublicationRequest {
    fn input(&self) -> HomeImagePromotionInput<'_> {
        HomeImagePromotionInput {
            run_id: self.run_id,
            cache_key: &self.cache_key,
            profile_name: &self.profile_name,
            rootfs_hash: &self.rootfs_hash,
            reuse_key: &self.reuse_key,
            working_dir: &self.working_dir,
            active_image: &self.active_image,
            image_size_bytes: self.image_size_bytes,
            terminal_status: self.terminal_status,
            completed_at: &self.completed_at,
            storage_fingerprints: &self.storage_fingerprints,
            history_proof: self.history_proof.as_ref(),
        }
    }
}

impl HomeImagePromotionContext {
    pub async fn promote(&self) -> LifecycleResult<HomeImagePromotionOutcome> {
        // Only one accepted attempt may use or advance a context's generation.
        let mut progress = self.publication.clone().lock_owned().await;
        let entry = match progress.entry.as_ref().or(self.entry_lock.as_ref()) {
            Some(entry) => entry.clone(),
            None => {
                match runner_host::lock::try_acquire(self.cache.entry_lock_path(&self.cache_key))
                    .await
                {
                    Ok(lock) => HomeEntryLock::new(
                        &self.cache,
                        &self.cache_key,
                        lock,
                        HomeCacheLockOwner::Finalizing,
                    ),
                    Err(error) => {
                        info!(run_id = %self.run_id, cache_key = self.cache_key, %error,
                        "home image cache promotion skipped: late entry lock unavailable");
                        self.observe_publication(
                            HomeObservationOutcome::Skipped,
                            "late_entry_lock_unavailable",
                        );
                        return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
                    }
                }
            }
        };
        progress.entry = Some(entry.clone());
        let request = PublicationRequest {
            run_id: self.run_id,
            cache_key: self.cache_key.clone(),
            profile_name: self.profile_name.clone(),
            rootfs_hash: self.rootfs_hash.clone(),
            reuse_key: self.reuse_key.clone(),
            working_dir: self.working_dir.clone(),
            active_image: self.active_image.clone(),
            image_size_bytes: self.image_size_bytes,
            terminal_status: self.terminal_status,
            completed_at: self.completed_at.clone(),
            storage_fingerprints: self.storage_fingerprints.clone(),
            history_proof: self.history_proof.clone(),
        };
        let cache = self.cache.clone();
        self.cache
            .inner
            .checkout_io
            .spawn(async move {
                let _entry = entry;
                let result = cache.promote_locked(request.input(), &mut progress).await;
                if result.is_err() {
                    cache.observe_publication(
                        &request.input(),
                        HomeObservationOutcome::Failed,
                        "publication_error",
                        None,
                        None,
                    );
                }
                result
            })
            .await
            .map_err(|error| {
                LifecycleError::Internal(format!("home publication task failed: {error}"))
            })?
    }
}

impl HomeImageCache {
    async fn publication_admission<'a>(
        &'a self,
        deadline: Instant,
        io_slots: u32,
    ) -> LifecycleResult<Option<tokio::sync::SemaphorePermit<'a>>> {
        if Instant::now() >= deadline {
            return Ok(None);
        }
        #[cfg(test)]
        self.inner.publication_admission_entered.add_permits(1);
        let admission = async {
            let io = self
                .inner
                .publication_admission
                .acquire_many(io_slots)
                .await
                .map_err(|error| {
                    LifecycleError::Internal(format!("home publication admission closed: {error}"))
                })?;
            Ok::<_, LifecycleError>(Some(io))
        };
        match tokio::time::timeout_at(deadline, admission).await {
            Ok(result) => result,
            Err(_) => Ok(None),
        }
    }

    async fn promote_locked(
        &self,
        input: HomeImagePromotionInput<'_>,
        progress: &mut PublicationProgress,
    ) -> LifecycleResult<HomeImagePromotionOutcome> {
        if progress.committed {
            return Ok(HomeImagePromotionOutcome::Promoted);
        }
        let paths = self.entry_paths(input.cache_key);
        let generation = input.run_id.to_string();
        let staging = paths.tmp_image(input.run_id);
        let candidate = paths
            .image(&generation)
            .ok_or_else(|| LifecycleError::Internal("invalid publication generation".into()))?;
        if let Some(binding) = input.history_proof {
            super::super::metadata::validate_history_binding(binding, &generation)?;
        }
        if input.rootfs_hash.is_empty()
            || input.image_size_bytes == 0
            || !input.image_size_bytes.is_multiple_of(1024 * 1024)
        {
            self.observe_publication(
                &input,
                HomeObservationOutcome::Skipped,
                "invalid_image_identity",
                None,
                None,
            );
            return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
        }
        let current = self
            .read_valid_metadata(
                &paths.metadata(),
                input.profile_name,
                input.reuse_key,
                input.working_dir,
                input.image_size_bytes,
            )
            .await
            .ok()
            .flatten();
        let own_commit = current
            .as_ref()
            .is_some_and(|metadata| metadata.image_generation == generation);
        if !own_commit
            && current
                .as_ref()
                .is_some_and(|metadata| metadata.last_completed_at.as_str() >= input.completed_at)
        {
            self.observe_publication(
                &input,
                HomeObservationOutcome::PreservedExisting,
                "newer_committed_image",
                current
                    .as_ref()
                    .map(|metadata| metadata.image_generation.as_str()),
                None,
            );
            return Ok(HomeImagePromotionOutcome::PreservedExisting);
        }
        if progress.source.is_none() {
            progress.previous = current.clone();
            let source = match PinnedImage::open(input.active_image, input.image_size_bytes) {
                Ok(source) => source,
                Err(error) => {
                    info!(%error, "home publication source unavailable");
                    self.observe_publication(
                        &input,
                        HomeObservationOutcome::Skipped,
                        "source_unavailable",
                        None,
                        None,
                    );
                    return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
                }
            };
            progress.source = Some(Arc::new(source));
        }
        let source = progress.source.as_ref().unwrap().clone();
        let destination = self.home_image_cache_fs_stats_path();
        let device = fs::metadata(&destination).await?.dev();
        // A retained Copy destination is an established transfer phase. A later
        // device observation cannot turn recovery back into a colliding Move.
        let mut copy_required = progress.image.is_none()
            && (progress.copy_target.is_some() || source.identity().dev != device);
        let deadline = Instant::now() + HOME_IMAGE_PUBLICATION_ADMISSION_TIMEOUT;
        let metadata_peak = runner_host::state_file::HOME_METADATA_MAX_BYTES.saturating_add(8192);
        let mut io_slots = 1;
        loop {
            let admission = match self.publication_admission(deadline, io_slots).await {
                Ok(Some(admission)) => admission,
                Ok(None) => {
                    info!(run_id = %input.run_id, cache_key = input.cache_key,
                        admission_timeout_ms = duration_ms(HOME_IMAGE_PUBLICATION_ADMISSION_TIMEOUT),
                        "home image cache promotion skipped: publication admission timeout");
                    self.observe_publication(
                        &input,
                        HomeObservationOutcome::Skipped,
                        "publication_admission_timeout",
                        None,
                        None,
                    );
                    return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
                }
                Err(error) => {
                    warn!(run_id = %input.run_id, %error, "home image cache promotion skipped: publication admission unavailable");
                    self.observe_publication(
                        &input,
                        HomeObservationOutcome::Skipped,
                        "publication_admission_unavailable",
                        None,
                        None,
                    );
                    return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
                }
            };
            #[cfg(test)]
            if let Some((entered, release)) = &self.publication_io_held_test_gate {
                entered.notify_one();
                release
                    .acquire()
                    .await
                    .expect("publication IO-held gate closed")
                    .forget();
            }
            // Accepted physical work retains IO admission. GC waits release it;
            // entry custody and pinned source bytes survive those waits.
            let copy_peak = if progress.image.is_none() && copy_required {
                source.validate_path(input.active_image)?;
                let file = source.clone_file_for_observation()?;
                let destination = destination.clone();
                let logical = input.image_size_bytes;
                tokio::task::spawn_blocking(move || {
                    let unit = nix::sys::statvfs::statvfs(&destination)
                        .map(|stats| stats.fragment_size())
                        .unwrap_or(logical.max(1));
                    sandbox::home_drive_copy_peak_bytes_from_file(&file, logical, unit)
                })
                .await
                .map_err(|error| {
                    LifecycleError::Internal(format!("publication copy demand: {error}"))
                })?
            } else {
                0
            };
            let additional = metadata_peak.saturating_add(copy_peak);
            let stats = self.fs_stats().await?;
            let pressure = self.pressure_thresholds(stats);
            if copy_peak > 0
                && io_slots == 1
                && !has_copy_headroom(
                    stats,
                    pressure,
                    additional.saturating_mul(HOME_PUBLICATION_IO_SLOTS as u64),
                )
            {
                // Independent Copies must leave room to commit their metadata.
                // Reuse the whole existing IO budget under pressure, releasing
                // partial admission before waiting under the original deadline.
                drop(admission);
                io_slots = HOME_PUBLICATION_IO_SLOTS as u32;
                continue;
            }
            if !has_copy_headroom(stats, pressure, additional) {
                drop(admission);
                if pressure.reserve_feasible
                    && self.gc_for_publication(additional, deadline).await?
                {
                    continue;
                }
                self.observe_publication(
                    &input,
                    HomeObservationOutcome::Skipped,
                    if copy_peak > 0 {
                        "copy_disk_reserve"
                    } else if pressure.reserve_feasible {
                        "disk_reserve"
                    } else {
                        "reserve_infeasible"
                    },
                    None,
                    None,
                );
                return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
            }
            if own_commit {
                let expected = progress
                    .metadata
                    .as_ref()
                    .ok_or_else(|| LifecycleError::Internal("unowned publication commit".into()))?;
                let stored = self.read_metadata_file(&paths.metadata()).await?;
                if serde_json::to_vec(&stored)
                    .map_err(|error| LifecycleError::Internal(error.to_string()))?
                    != serde_json::to_vec(expected)
                        .map_err(|error| LifecycleError::Internal(error.to_string()))?
                {
                    return Err(LifecycleError::Internal(
                        "uncertain publication commit changed".into(),
                    ));
                }
                progress
                    .image
                    .as_ref()
                    .ok_or_else(|| {
                        LifecycleError::Internal("publication image custody missing".into())
                    })?
                    .pin
                    .validate_path(&candidate)?;
                progress
                    .metadata_pin
                    .as_ref()
                    .ok_or_else(|| {
                        LifecycleError::Internal("publication commit pin missing".into())
                    })?
                    .validate_path(&paths.metadata())?;
                sync_directory(paths.entry_dir()).await?;
            } else {
                if progress.image.is_none() {
                    source.validate_path(input.active_image)?;
                    self.ensure_home_cache_entry_dir(input.cache_key).await?;
                    sync_directory(self.home_image_cache_dir()).await?;
                    if let Some(parent) = self.home_image_cache_dir().parent() {
                        sync_directory(parent).await?;
                    }
                    if fs::symlink_metadata(&candidate).await.is_ok()
                        || (progress.copy_target.is_none()
                            && fs::symlink_metadata(&staging).await.is_ok())
                    {
                        return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
                    }
                    let (pin, copied) = if copy_required {
                        #[cfg(test)]
                        if let Some(gate) = &self.publication_copy_test_gate {
                            gate.enter_and_wait().await;
                        }
                        let pin = sparse_copy_pinned(
                            &source,
                            &staging,
                            input.image_size_bytes,
                            &mut progress.copy_target,
                            || {
                                #[cfg(test)]
                                self.publication_fault(super::super::PublicationFault::BeforeCopy)?;
                                Ok(())
                            },
                        )
                        .await?;
                        source.validate_path(input.active_image)?;
                        progress.copy_target = None;
                        (Arc::new(pin), true)
                    } else {
                        match self.move_publication_source(input.active_image, &staging) {
                            Ok(()) => (source.clone(), false),
                            Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
                                // The failed rename leaves the pinned source unmoved.
                                drop(admission);
                                source.validate_path(input.active_image)?;
                                copy_required = true;
                                continue;
                            }
                            Err(error) => {
                                return Err(super::super::io_context::with_paths(
                                    error,
                                    "renameat2(RENAME_NOREPLACE)",
                                    input.active_image,
                                    &staging,
                                )
                                .into());
                            }
                        }
                    };
                    progress.image = Some(PublicationImage {
                        pin,
                        copied,
                        location: ImageLocation::Staging,
                    });
                }
                let image = progress.image.as_mut().unwrap();
                if image.location == ImageLocation::Staging {
                    image.pin.validate_path(&staging)?;
                    #[cfg(test)]
                    self.publication_fault(super::super::PublicationFault::BeforeImageSync)?;
                    #[cfg(test)]
                    let sync_gate = self.publication_sync_test_gate.clone();
                    image
                        .pin
                        .sync_owned(&staging, move || {
                            #[cfg(test)]
                            if let Some(gate) = sync_gate {
                                gate.enter_and_wait();
                            }
                        })
                        .await?;
                    sync_directory(paths.entry_dir()).await?;
                    if !image.copied
                        && let Some(parent) = input.active_image.parent()
                    {
                        sync_directory(parent).await?;
                    }
                    #[cfg(test)]
                    self.publication_fault(super::super::PublicationFault::AfterImageSync)?;
                    #[cfg(test)]
                    self.remove_staging_before_image_rename_for_test(&staging)
                        .await?;
                    move_noreplace(&staging, &candidate).map_err(|error| {
                        super::super::io_context::with_paths(
                            error,
                            "renameat2(RENAME_NOREPLACE)",
                            &staging,
                            &candidate,
                        )
                    })?;
                    image.location = ImageLocation::Candidate;
                }
                let observed = image.pin.validate_path(&candidate)?;
                #[cfg(test)]
                self.publication_fault(
                    super::super::PublicationFault::BeforeCandidateDirectorySync,
                )?;
                sync_directory(paths.entry_dir()).await?;
                let fresh = self.fs_stats().await?;
                if !has_copy_headroom(fresh, self.pressure_thresholds(fresh), metadata_peak) {
                    self.observe_publication(
                        &input,
                        HomeObservationOutcome::Skipped,
                        "post_transfer_reserve",
                        None,
                        None,
                    );
                    return Ok(HomeImagePromotionOutcome::SkippedUnpublished);
                }
                let metadata = progress.metadata.get_or_insert_with(|| HomeCacheMetadata {
                    format_version: CACHE_FORMAT_VERSION,
                    cache_scope: self.inner.cache_scope.clone(),
                    profile_name: input.profile_name.to_owned(),
                    rootfs_hash: input.rootfs_hash.to_owned(),
                    reuse_key: input.reuse_key.to_owned(),
                    working_dir: input.working_dir.to_owned(),
                    fingerprint_scope: "/home/user".to_owned(),
                    image_generation: generation.clone(),
                    history_proof: input.history_proof.cloned(),
                    last_completed_at: input.completed_at.to_owned(),
                    last_used_at: local_timestamp(),
                    last_terminal_status: input.terminal_status,
                    home_trust: HomeTrust::Clean,
                    logical_image_size_bytes: input.image_size_bytes,
                    allocated_bytes: allocated_bytes(&observed),
                    current_image: image.pin.identity(),
                    drive_layout: HOME_DRIVE_LAYOUT.to_owned(),
                    storage_fingerprints: filter_storage_fingerprints_for_home(
                        input.storage_fingerprints,
                    ),
                    state: HomeCacheEntryState::Current,
                });
                image.pin.validate_path(&candidate)?;
                self.write_metadata_with_progress(
                    input.cache_key,
                    input.run_id,
                    metadata.clone(),
                    &mut progress.metadata_pin,
                )
                .await?;
            }
            // A successful directory sync, including reconciliation, grants cleanup authority.
            progress.committed = true;
            self.retire_publication_sources(&input, progress, &candidate, source.identity())
                .await;
            // Close transferred/source descriptors while holding IO admission,
            // including unlinked Copy sources that still consume disk allocation.
            progress.source = None;
            progress.image = None;
            progress.metadata_pin = None;
            drop(source);
            info!(run_id = %input.run_id, cache_key = input.cache_key, image_generation = %generation,
                image_size_bytes = input.image_size_bytes, "home image cache promoted");
            self.observe_publication(
                &input,
                HomeObservationOutcome::Published,
                "synced_commit",
                Some(&generation),
                progress
                    .metadata
                    .as_ref()
                    .map(|metadata| metadata.allocated_bytes),
            );
            return Ok(HomeImagePromotionOutcome::Promoted);
        }
    }

    fn move_publication_source(&self, source: &Path, staging: &Path) -> std::io::Result<()> {
        #[cfg(test)]
        if self
            .inner
            .publication_fault
            .compare_exchange(
                super::super::PublicationFault::UnexpectedExdev as usize,
                0,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .is_ok()
        {
            return Err(std::io::Error::from_raw_os_error(libc::EXDEV));
        }
        move_noreplace(source, staging)
    }

    async fn retire_publication_sources(
        &self,
        input: &HomeImagePromotionInput<'_>,
        progress: &PublicationProgress,
        candidate: &Path,
        source_identity: HomeImageFileIdentity,
    ) {
        let paths = self.entry_paths(input.cache_key);
        if let Some(previous) = &progress.previous
            && let Some(old) = paths.image(&previous.image_generation)
            && old != candidate
            && let Ok(pin) = PinnedImage::open(&old, previous.logical_image_size_bytes)
            && pin.identity() == previous.current_image
            && pin.validate_path(&old).is_ok()
        {
            let removed = fs::remove_file(&old).await;
            let mut observation = HomeObservation::new(
                HomeObservationKind::Removal,
                if removed.is_ok() {
                    HomeObservationOutcome::Deleted
                } else {
                    HomeObservationOutcome::Failed
                },
            );
            observation.run_id = Some(input.run_id);
            observation.reuse_key = Some(input.reuse_key.to_owned());
            observation.cache_key = Some(input.cache_key.to_owned());
            observation.profile_name = Some(input.profile_name.to_owned());
            observation.image_generation = Some(previous.image_generation.clone());
            observation.reason = Some("replaced_generation".into());
            self.observe_home(observation);
            let _ = sync_directory(paths.entry_dir()).await;
        }
        if progress.image.as_ref().is_some_and(|image| image.copied)
            && let Ok(pin) = PinnedImage::open(input.active_image, input.image_size_bytes)
            && pin.identity() == source_identity
            && pin.validate_path(input.active_image).is_ok()
        {
            let _ = fs::remove_file(input.active_image).await;
            if let Some(parent) = input.active_image.parent() {
                let _ = sync_directory(parent).await;
            }
        }
    }
}
