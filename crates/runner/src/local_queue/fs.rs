//! Filesystem helpers for private local queue state.

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use nix::fcntl::{Flock, FlockArg};

use crate::host_file::{self, DirMode};

/// The group directory outlives individual runs. Lock its existing inode so
/// cleanup cannot unlink a lock file while a publisher is waiting on it.
pub(super) fn lock_active_inputs(group_dir: &Path) -> io::Result<Flock<File>> {
    let dir = host_file::open_dir(
        group_dir,
        DirMode::SharedTrustedParent,
        "local queue group directory",
    )?;
    #[cfg(test)]
    crate::cmd::active_input_lock_attempt_for_test(&dir);

    Flock::lock(dir, FlockArg::LockExclusive).map_err(|(_, error)| {
        io::Error::new(
            io::Error::from(error).kind(),
            format!(
                "lock local active inputs in {}: {error}",
                group_dir.display()
            ),
        )
    })
}

pub(crate) fn ensure_profile_jobs_dir(group_dir: &Path, profile: &str) -> io::Result<PathBuf> {
    ensure_group_dir(group_dir)?;
    let dir = super::profile_jobs_dir(group_dir, profile)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
    ensure_queue_dir(&dir, "local queue profile jobs directory")?;
    Ok(dir)
}

pub(crate) fn ensure_results_dir(group_dir: &Path) -> io::Result<PathBuf> {
    ensure_group_dir(group_dir)?;
    let dir = super::results_dir(group_dir);
    ensure_queue_dir(&dir, "local queue results directory")?;
    Ok(dir)
}

pub(crate) fn validate_results_dir(group_dir: &Path) -> io::Result<PathBuf> {
    validate_group_dir(group_dir)?;
    let dir = super::results_dir(group_dir);
    host_file::validate_dir(&dir, DirMode::Private, "local queue results directory")?;
    Ok(dir)
}

pub(crate) fn ensure_claims_dir(group_dir: &Path) -> io::Result<PathBuf> {
    ensure_group_dir(group_dir)?;
    let dir = super::claims_dir(group_dir);
    ensure_queue_dir(&dir, "local queue claims directory")?;
    Ok(dir)
}

pub(crate) fn validate_claims_dir(group_dir: &Path) -> io::Result<PathBuf> {
    validate_group_dir(group_dir)?;
    let dir = super::claims_dir(group_dir);
    host_file::validate_dir(&dir, DirMode::Private, "local queue claims directory")?;
    Ok(dir)
}

pub(crate) fn ensure_cancels_dir(group_dir: &Path) -> io::Result<PathBuf> {
    ensure_group_dir(group_dir)?;
    let dir = super::cancels_dir(group_dir);
    ensure_queue_dir(&dir, "local queue cancels directory")?;
    Ok(dir)
}

pub(crate) fn validate_cancels_dir(group_dir: &Path) -> io::Result<PathBuf> {
    validate_group_dir(group_dir)?;
    let dir = super::cancels_dir(group_dir);
    host_file::validate_dir(&dir, DirMode::Private, "local queue cancels directory")?;
    Ok(dir)
}

pub(crate) fn ensure_run_inputs_dir(
    group_dir: &Path,
    run_id: crate::ids::RunId,
) -> io::Result<PathBuf> {
    ensure_group_dir(group_dir)?;
    let inputs_dir = super::inputs_dir(group_dir);
    ensure_queue_dir(&inputs_dir, "local queue inputs directory")?;
    let run_dir = super::run_inputs_dir(group_dir, run_id);
    ensure_queue_dir(&run_dir, "local queue run inputs directory")?;
    Ok(run_dir)
}

pub(crate) fn validate_inputs_dir(group_dir: &Path) -> io::Result<PathBuf> {
    validate_group_dir(group_dir)?;
    let inputs_dir = super::inputs_dir(group_dir);
    host_file::validate_dir(
        &inputs_dir,
        DirMode::Private,
        "local queue inputs directory",
    )?;
    Ok(inputs_dir)
}

pub(crate) fn validate_run_inputs_dir(
    group_dir: &Path,
    run_id: crate::ids::RunId,
) -> io::Result<PathBuf> {
    validate_inputs_dir(group_dir)?;
    let run_dir = super::run_inputs_dir(group_dir, run_id);
    host_file::validate_dir(
        &run_dir,
        DirMode::Private,
        "local queue run inputs directory",
    )?;
    Ok(run_dir)
}

pub(crate) fn ensure_group_dir(group_dir: &Path) -> io::Result<()> {
    host_file::ensure_dir(
        group_dir,
        DirMode::SharedTrustedParent,
        "local queue group directory",
    )
}

pub(crate) fn validate_group_dir(group_dir: &Path) -> io::Result<()> {
    host_file::validate_dir(
        group_dir,
        DirMode::SharedTrustedParent,
        "local queue group directory",
    )
}

fn ensure_queue_dir(path: &Path, context: &str) -> io::Result<()> {
    host_file::ensure_dir(path, DirMode::Private, context)
}

pub(crate) fn write_private_file(path: &Path, bytes: &[u8], context: &str) -> io::Result<()> {
    let mut file = open_private_file(path, false, true, context)?;
    file.write_all(bytes)
        .map_err(|e| io::Error::new(e.kind(), format!("write {context} {}: {e}", path.display())))
}

pub(crate) fn read_private_file(path: &Path, context: &str) -> io::Result<Vec<u8>> {
    let mut file = open_private_read_file(path, context)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| io::Error::new(e.kind(), format!("read {context} {}: {e}", path.display())))?;
    Ok(bytes)
}

pub(crate) fn read_private_file_with_max(
    path: &Path,
    context: &str,
    max_bytes: usize,
) -> io::Result<Vec<u8>> {
    let file = open_private_read_file(path, context)?;
    let metadata = file
        .metadata()
        .map_err(|e| io::Error::new(e.kind(), format!("stat {context} {}: {e}", path.display())))?;
    if metadata.len() > max_bytes as u64 {
        return Err(private_file_too_large(
            path,
            context,
            metadata.len(),
            max_bytes,
        ));
    }

    let read_limit = max_bytes.checked_add(1).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("read limit for {context} {} is too large", path.display()),
        )
    })?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(read_limit as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| io::Error::new(e.kind(), format!("read {context} {}: {e}", path.display())))?;
    if bytes.len() > max_bytes {
        return Err(private_file_too_large(
            path,
            context,
            bytes.len() as u64,
            max_bytes,
        ));
    }
    Ok(bytes)
}

fn private_file_too_large(
    path: &Path,
    context: &str,
    observed_bytes: u64,
    max_bytes: usize,
) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!(
            "{context} {} exceeds {max_bytes} bytes (observed at least {observed_bytes} bytes)",
            path.display()
        ),
    )
}

pub(crate) fn private_file_has_content(path: &Path, context: &str) -> io::Result<bool> {
    let file = match open_private_read_file(path, context) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    let metadata = file
        .metadata()
        .map_err(|e| io::Error::new(e.kind(), format!("stat {context} {}: {e}", path.display())))?;
    Ok(metadata.len() > 0)
}

pub(crate) fn write_private_marker(path: &Path, context: &str) -> io::Result<()> {
    write_private_file(path, b"", context)
}

pub(crate) fn create_private_marker(path: &Path, context: &str) -> io::Result<()> {
    open_private_file(path, true, false, context).map(|_| ())
}

pub(crate) fn marker_file_exists(path: &Path, context: &str) -> io::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_file()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(io::Error::new(
            e.kind(),
            format!("stat {context} {}: {e}", path.display()),
        )),
    }
}

pub(crate) fn marker_path_occupied(path: &Path, context: &str) -> io::Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(io::Error::new(
            e.kind(),
            format!("stat {context} {}: {e}", path.display()),
        )),
    }
}

pub(crate) fn open_private_new_file(path: &Path, context: &str) -> io::Result<File> {
    open_private_file(path, true, false, context)
}

fn open_private_read_file(path: &Path, context: &str) -> io::Result<File> {
    let parent = host_file::file_parent(path);
    host_file::validate_dir(parent, DirMode::Private, context)?;

    let mut options = File::options();
    options
        .read(true)
        .custom_flags(host_file::private_file_open_flags());
    let file = options
        .open(path)
        .map_err(|e| io::Error::new(e.kind(), format!("open {context} {}: {e}", path.display())))?;
    host_file::secure_regular_private_file(&file, path, context)?;
    Ok(file)
}

fn open_private_file(
    path: &Path,
    create_new: bool,
    truncate: bool,
    context: &str,
) -> io::Result<File> {
    let parent = host_file::file_parent(path);
    host_file::validate_dir(parent, DirMode::Private, context)?;

    let mut options = File::options();
    options
        .write(true)
        .mode(host_file::PRIVATE_FILE_MODE)
        .custom_flags(host_file::private_file_open_flags());
    if create_new {
        options.create_new(true);
    } else {
        options.create(true).truncate(truncate);
    }

    let file = options
        .open(path)
        .map_err(|e| io::Error::new(e.kind(), format!("open {context} {}: {e}", path.display())))?;
    if let Err(e) = host_file::secure_regular_private_file(&file, path, context) {
        if create_new {
            let _ = std::fs::remove_file(path);
        }
        return Err(e);
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::*;

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn ensure_profile_jobs_dir_keeps_existing_group_dir_mode() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path().join("group");
        std::fs::create_dir(&group_dir).unwrap();
        std::fs::set_permissions(&group_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        let job_dir = ensure_profile_jobs_dir(&group_dir, crate::profile::DEFAULT_PROFILE).unwrap();

        assert_eq!(mode(&group_dir), 0o755);
        assert_eq!(mode(&job_dir), 0o700);
    }

    #[test]
    fn ensure_profile_jobs_dir_creates_missing_group_dir_as_shared_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path().join("groups").join("org").join("group");

        let job_dir = ensure_profile_jobs_dir(&group_dir, crate::profile::DEFAULT_PROFILE).unwrap();

        assert_eq!(mode(&group_dir), host_file::SHARED_TRUSTED_DIR_MODE);
        assert_eq!(mode(&job_dir), host_file::PRIVATE_DIR_MODE);
    }

    #[test]
    fn ensure_group_dir_rejects_final_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let groups_dir = dir.path().join("groups").join("org");
        std::fs::create_dir_all(&groups_dir).unwrap();
        let target = dir.path().join("target-group");
        let group_dir = groups_dir.join("group");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &group_dir).unwrap();

        let error =
            ensure_group_dir(&group_dir).expect_err("final group symlink should be rejected");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn ensure_profile_jobs_dir_rejects_final_profile_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let group_dir = dir.path().join("groups").join("org").join("group");
        let profile_parent = group_dir.join("jobs").join("vm0");
        std::fs::create_dir_all(&profile_parent).unwrap();
        let target = dir.path().join("target-profile");
        let profile_dir = profile_parent.join("default");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &profile_dir).unwrap();

        let error = ensure_profile_jobs_dir(&group_dir, crate::profile::DEFAULT_PROFILE)
            .expect_err("final profile symlink should be rejected");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn ensure_profile_jobs_dir_rejects_intermediate_group_symlink_without_touching_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let link = dir.path().join("link");
        let group_dir = link.join("group");
        std::fs::create_dir(&target).unwrap();
        symlink(&target, &link).unwrap();

        let error = ensure_profile_jobs_dir(&group_dir, crate::profile::DEFAULT_PROFILE)
            .expect_err("intermediate group symlink should be rejected");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(!target.join("group").exists());
    }
}
