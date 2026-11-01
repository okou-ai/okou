use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use sandbox::{
    HomeDriveSeedImage, HomeDriveSpaceReserve, SandboxError, SandboxInitializationPhase,
};

use crate::command;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HomeDriveImagePrepareStage {
    SeedSparseCopy,
    FreshFormat,
}

pub(crate) trait HomeDriveImagePrepareObserver: Send {
    fn mark_home_drive_present(&mut self);

    fn mark_home_seed_image_used(&mut self);

    fn record_stage_result(
        &mut self,
        stage: HomeDriveImagePrepareStage,
        started_at: Instant,
        result: sandbox::Result<()>,
    ) -> sandbox::Result<()>;
}

pub(crate) async fn prepare_home_drive_image(
    path: &Path,
    config: &sandbox::HomeDriveConfig,
    pressure: Option<&dyn sandbox::HomeDrivePressurePolicy>,
    mut observer: Option<&mut dyn HomeDriveImagePrepareObserver>,
) -> sandbox::Result<()> {
    if let Some(observer) = observer.as_deref_mut() {
        observer.mark_home_drive_present();
    }

    if config.size_mb == 0 {
        return Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: "home image size must be positive".into(),
        });
    }
    reject_image_symlink_components(path)?;
    if let Some(seed) = config.seed_image.as_ref() {
        let (HomeDriveSeedImage::Copy(source) | HomeDriveSeedImage::Move(source)) = seed;
        // Leaf validation below retains its more specific regular-file error.
        if let Some(parent) = source.parent() {
            reject_image_symlink_components(parent)?;
        }
        if path == source || same_image_file(path, source)? {
            return Err(SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: "home seed and active image must be distinct files".into(),
            });
        }
    }

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: format!("create home image dir: {e}"),
            })?;
    }

    match config.seed_image.as_ref() {
        Some(HomeDriveSeedImage::Copy(source_image)) => {
            if let Some(observer) = observer.as_deref_mut() {
                observer.mark_home_seed_image_used();
            }
            return copy_home_drive_seed_image(
                path,
                source_image,
                home_drive_size_bytes(config.size_mb),
                config.space_reserve,
                pressure,
                observer,
            )
            .await;
        }
        Some(HomeDriveSeedImage::Move(source_image)) => {
            if let Some(observer) = observer.as_deref_mut() {
                observer.mark_home_seed_image_used();
            }
            return move_home_drive_seed_image(
                path,
                source_image,
                home_drive_size_bytes(config.size_mb),
                config.space_reserve,
                pressure,
                observer,
            )
            .await;
        }
        None => {}
    }

    ensure_home_image_headroom(
        path,
        home_drive_size_bytes(config.size_mb),
        config.space_reserve,
        None,
        pressure,
    )
    .await?;

    // Lazy journal initialization is safe only on this fresh path: create
    // truncates the regular file, and extending it makes the new range read as
    // zero. Seed images return above and must not use this formatting option.
    let file = tokio::fs::File::create(path)
        .await
        .map_err(|e| SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!("create home image {}: {e}", path.display()),
        })?;
    file.set_len(home_drive_size_bytes(config.size_mb))
        .await
        .map_err(|e| SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!("set home image size {}: {e}", path.display()),
        })?;
    drop(file);

    let path_str = path.to_str().ok_or_else(|| SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: format!("home image path is not UTF-8: {}", path.display()),
    })?;
    let stage_started = Instant::now();
    let result = command::exec_status_with_timeout(
        "mkfs.ext4",
        &["-F", "-q", "-E", "lazy_journal_init=1", path_str],
        Duration::from_secs(60),
    )
    .await
    .map_err(|e| SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: format!("format home image: {e}"),
    });
    record_stage_result(
        observer,
        HomeDriveImagePrepareStage::FreshFormat,
        stage_started,
        result,
    )?;
    Ok(())
}

async fn copy_home_drive_seed_image(
    target: &Path,
    source: &Path,
    expected_size_bytes: u64,
    space_reserve: HomeDriveSpaceReserve,
    pressure: Option<&dyn sandbox::HomeDrivePressurePolicy>,
    observer: Option<&mut dyn HomeDriveImagePrepareObserver>,
) -> sandbox::Result<()> {
    validate_home_seed_source(source, expected_size_bytes).await?;
    copy_validated_home_drive_seed_image(
        target,
        source,
        expected_size_bytes,
        space_reserve,
        pressure,
        observer,
    )
    .await
}

async fn copy_validated_home_drive_seed_image(
    target: &Path,
    source: &Path,
    expected_size_bytes: u64,
    space_reserve: HomeDriveSpaceReserve,
    pressure: Option<&dyn sandbox::HomeDrivePressurePolicy>,
    observer: Option<&mut dyn HomeDriveImagePrepareObserver>,
) -> sandbox::Result<()> {
    let source_str = source
        .to_str()
        .ok_or_else(|| SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!("home seed image path is not UTF-8: {}", source.display()),
        })?;
    let target_str = target
        .to_str()
        .ok_or_else(|| SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!("home image path is not UTF-8: {}", target.display()),
        })?;

    ensure_home_image_headroom(
        target,
        expected_size_bytes,
        space_reserve,
        Some(source),
        pressure,
    )
    .await?;

    let stage_started = Instant::now();
    let result = command::exec_status_with_timeout(
        "cp",
        &["--sparse=always", "--", source_str, target_str],
        Duration::from_secs(300),
    )
    .await
    .map_err(|e| SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: format!("copy home seed image: {e}"),
    });
    record_stage_result(
        observer,
        HomeDriveImagePrepareStage::SeedSparseCopy,
        stage_started,
        result,
    )?;

    validate_home_seed_target(target, expected_size_bytes, "copied").await
}

async fn move_home_drive_seed_image(
    target: &Path,
    source: &Path,
    expected_size_bytes: u64,
    space_reserve: HomeDriveSpaceReserve,
    pressure: Option<&dyn sandbox::HomeDrivePressurePolicy>,
    observer: Option<&mut dyn HomeDriveImagePrepareObserver>,
) -> sandbox::Result<()> {
    validate_home_seed_source(source, expected_size_bytes).await?;
    match std::fs::rename(source, target) {
        Ok(()) => validate_home_seed_target(target, expected_size_bytes, "moved").await,
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
            copy_validated_home_drive_seed_image(
                target,
                source,
                expected_size_bytes,
                space_reserve,
                pressure,
                observer,
            )
            .await?;
            std::fs::remove_file(source).map_err(|e| SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: format!("remove copied home seed image {}: {e}", source.display()),
            })
        }
        Err(e) => Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!(
                "move home seed image {} to {}: {e}",
                source.display(),
                target.display()
            ),
        }),
    }
}

async fn validate_home_seed_source(
    source: &Path,
    expected_size_bytes: u64,
) -> sandbox::Result<std::fs::Metadata> {
    let source_metadata =
        tokio::fs::symlink_metadata(source)
            .await
            .map_err(|e| SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: format!("read home seed image {}: {e}", source.display()),
            })?;
    if !source_metadata.is_file() {
        return Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!(
                "home seed image is not a regular file: {}",
                source.display()
            ),
        });
    }
    if source_metadata.len() != expected_size_bytes {
        return Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!(
                "home seed image size mismatch for {}: expected {} bytes, got {} bytes",
                source.display(),
                expected_size_bytes,
                source_metadata.len()
            ),
        });
    }
    Ok(source_metadata)
}

struct HomeImageHeadroom {
    device: u64,
    capacity: u64,
    available: u64,
    required: u64,
    infeasible: bool,
}

async fn observe_home_image_headroom(
    target: &Path,
    logical_peak: u64,
    reserve: HomeDriveSpaceReserve,
    copy_source: Option<&Path>,
) -> sandbox::Result<HomeImageHeadroom> {
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .to_owned();
    let source = copy_source.map(Path::to_owned);
    tokio::task::spawn_blocking(move || {
        let stats =
            nix::sys::statvfs::statvfs(&parent).map_err(|error| SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: format!("query home image filesystem {}: {error}", parent.display()),
            })?;
        let capacity = stats.blocks().saturating_mul(stats.fragment_size());
        let available = stats
            .blocks_available()
            .saturating_mul(stats.fragment_size());
        let reserve_bytes = reserve.bytes_for_capacity(capacity);
        let unit = stats.fragment_size().max(1);
        let full_peak = logical_peak.div_ceil(unit).saturating_mul(unit);
        let full_required = reserve_bytes
            .checked_add(full_peak)
            .and_then(|bytes| bytes.checked_add(8192));
        let peak = if full_required.is_some_and(|required| available >= required) {
            full_peak
        } else {
            source.as_ref().map_or(full_peak, |source| {
                sandbox::home_drive_copy_peak_bytes(source, logical_peak, stats.fragment_size())
            })
        };
        let required = reserve
            .bytes_for_capacity(capacity)
            .checked_add(peak)
            .and_then(|bytes| bytes.checked_add(8192));
        let device = std::fs::metadata(&parent)
            .map_err(|error| SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: format!(
                    "inspect home image filesystem {}: {error}",
                    parent.display()
                ),
            })?
            .dev();
        Ok(HomeImageHeadroom {
            device,
            capacity,
            available,
            infeasible: required.is_none_or(|required| required > capacity),
            required: required.unwrap_or(u64::MAX),
        })
    })
    .await
    .map_err(|error| SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: format!("home image filesystem check failed: {error}"),
    })?
}

async fn ensure_home_image_headroom(
    target: &Path,
    logical_peak: u64,
    reserve: HomeDriveSpaceReserve,
    copy_source: Option<&Path>,
    pressure: Option<&dyn sandbox::HomeDrivePressurePolicy>,
) -> sandbox::Result<()> {
    let mut observed =
        observe_home_image_headroom(target, logical_peak, reserve, copy_source).await?;
    if !observed.infeasible && observed.available >= observed.required {
        return Ok(());
    }
    if !observed.infeasible
        && let Some(pressure) = pressure
    {
        let deadline = tokio::time::Instant::now() + sandbox::HOME_DRIVE_RECLAIM_OBSERVATION;
        // Only the observer expires. The policy owns accepted physical work and
        // the provider never treats a callback result as an allocation grant.
        let _ = tokio::time::timeout_at(
            deadline,
            pressure.reclaim(observed.device, observed.required, deadline),
        )
        .await;
        observed = observe_home_image_headroom(target, logical_peak, reserve, copy_source).await?;
        if !observed.infeasible && observed.available >= observed.required {
            return Ok(());
        }
    }
    Err(SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: format!(
            "insufficient home image headroom for {}: available {} bytes, required {} bytes, capacity {} bytes, reason {}",
            target.display(),
            observed.available,
            observed.required,
            observed.capacity,
            if observed.infeasible {
                "reserve_infeasible"
            } else {
                "insufficient_headroom"
            }
        ),
    })
}

async fn validate_home_seed_target(
    target: &Path,
    expected_size_bytes: u64,
    action: &str,
) -> sandbox::Result<()> {
    let target_metadata =
        tokio::fs::symlink_metadata(target)
            .await
            .map_err(|e| SandboxError::Initialization {
                phase: SandboxInitializationPhase::SandboxAllocation,
                message: format!("read {action} home image {}: {e}", target.display()),
            })?;
    if !target_metadata.is_file() {
        return Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!(
                "{action} home image is not a regular file: {}",
                target.display()
            ),
        });
    }
    if target_metadata.len() != expected_size_bytes {
        return Err(SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: format!(
                "{action} home image size mismatch for {}: expected {} bytes, got {} bytes",
                target.display(),
                expected_size_bytes,
                target_metadata.len()
            ),
        });
    }

    Ok(())
}

fn same_image_file(target: &Path, source: &Path) -> sandbox::Result<bool> {
    let target = match std::fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(image_path_error(target, error)),
    };
    let source_metadata =
        std::fs::symlink_metadata(source).map_err(|error| image_path_error(source, error))?;
    Ok((target.dev(), target.ino()) == (source_metadata.dev(), source_metadata.ino()))
}

fn reject_image_symlink_components(path: &Path) -> sandbox::Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir | Component::Normal(_) => current.push(component),
            _ => {
                return Err(SandboxError::Initialization {
                    phase: SandboxInitializationPhase::SandboxAllocation,
                    message: format!("home image path must be normalized: {}", path.display()),
                });
            }
        }
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(SandboxError::Initialization {
                    phase: SandboxInitializationPhase::SandboxAllocation,
                    message: format!("refusing symlink home image path: {}", current.display()),
                });
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(image_path_error(&current, error)),
        }
    }
    Ok(())
}

fn image_path_error(path: &Path, error: std::io::Error) -> SandboxError {
    SandboxError::Initialization {
        phase: SandboxInitializationPhase::SandboxAllocation,
        message: format!("inspect home image path {}: {error}", path.display()),
    }
}

fn home_drive_size_bytes(size_mb: u32) -> u64 {
    u64::from(size_mb) * 1024 * 1024
}

fn record_stage_result(
    observer: Option<&mut dyn HomeDriveImagePrepareObserver>,
    stage: HomeDriveImagePrepareStage,
    started_at: Instant,
    result: sandbox::Result<()>,
) -> sandbox::Result<()> {
    match observer {
        Some(observer) => observer.record_stage_result(stage, started_at, result),
        None => result,
    }
}

#[cfg(test)]
mod tests;
