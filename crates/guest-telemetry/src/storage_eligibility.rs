//! Read-only namespace admission shared by the fixed storage worker and helper.

use guest_contracts::storage_manifest::Manifest;
use guest_contracts::storage_paths::normalize_path;
use std::io;
use std::path::{Path, PathBuf};

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn unaliased(
    path: &Path,
    required: bool,
    control: &mut impl FnMut() -> io::Result<()>,
) -> io::Result<bool> {
    for prefix in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        // Control errors must never become an ordinary-input eligibility choice.
        control()?;
        match std::fs::symlink_metadata(prefix) {
            Ok(metadata) if !metadata.is_dir() => return Ok(false),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
            Err(error) if required => return Err(error),
            Err(_) => return Ok(false),
        }
    }
    Ok(true)
}

/// Check source bindings and sufficient namespace safety without modifying inputs.
///
/// Private runtime errors fail; unconfirmed input paths choose ordinary application.
/// The caller retains its operation deadline/cancellation through `control`.
pub fn eligible(
    manifest: &Manifest,
    runtime: Option<&Path>,
    mut control: impl FnMut() -> io::Result<()>,
) -> io::Result<bool> {
    control()?;
    let descriptor = manifest
        .archive_readiness
        .as_ref()
        .ok_or_else(|| invalid("missing archive readiness descriptor"))?;
    descriptor.validate(manifest).map_err(invalid)?;
    if !cfg!(target_os = "linux") {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "archive readiness requires Linux",
        ));
    }
    let runtime = runtime
        .filter(|path| path.is_absolute() && normalize_path(path) == *path)
        .ok_or_else(|| invalid("pending archives require a private absolute runtime"))?;
    if !unaliased(runtime, true, &mut control)? {
        return Err(invalid(
            "private runtime has a non-directory or aliased prefix",
        ));
    }
    for target in manifest
        .storages
        .iter()
        .map(|entry| PathBuf::from(&entry.mount_path))
        .chain(
            manifest
                .artifacts
                .iter()
                .map(|entry| PathBuf::from(&entry.mount_path)),
        )
        .chain(manifest.cleanup_paths.iter().map(PathBuf::from))
        .chain(
            manifest
                .instruction_cleanups
                .iter()
                .map(|entry| PathBuf::from(&entry.mount_path)),
        )
    {
        control()?;
        if !target.is_absolute()
            || normalize_path(&target) != target
            || target.starts_with(runtime)
            || runtime.starts_with(&target)
            || !unaliased(&target, false, &mut control)?
        {
            return Ok(false);
        }
    }
    control()?;
    Ok(true)
}

#[cfg(all(test, target_os = "linux"))]
mod tests;
