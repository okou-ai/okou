//! Verify and install a complete private archive without trusting writable Guest cache state.
use crate::cleanup_directory::CleanupDirectory;
use guest_contracts::content_bundle::{BundleApplication, BundleArchiveSource, MAX_METADATA_BYTES};
use std::{
    collections::HashSet,
    fs, io,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
};

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Invalid content bundle application",
    )
}

pub fn apply_content_bundle(home: &Path, runtime: &Path, metadata: &[u8]) -> bool {
    match apply(home, runtime, metadata) {
        Ok(()) => true,
        Err(error) => {
            guest_telemetry::log_error!(
                crate::LOG_TAG,
                "Content bundle application failed: {error}"
            );
            false
        }
    }
}
fn apply(home: &Path, runtime: &Path, metadata: &[u8]) -> io::Result<()> {
    if metadata.len() > MAX_METADATA_BYTES {
        return Err(invalid());
    }
    let input: BundleApplication = serde_json::from_slice(metadata).map_err(|_| invalid())?;
    let archive = match &input {
        BundleApplication::Instructions { archive, .. }
        | BundleApplication::Skill { archive, .. } => archive,
    };
    let staging = runtime.join("bundle-staging");
    match fs::remove_dir_all(&staging) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    fs::create_dir(&staging)?;
    fs::set_permissions(&staging, fs::Permissions::from_mode(0o700))?;
    let paths = unpack_archive(runtime, archive, &staging)?;
    match input {
        BundleApplication::Instructions { framework, archive } => {
            if paths.len() != 1 || !paths.contains("instructions.md") {
                return Err(invalid());
            }
            let source = staging.join("instructions.md");
            if !crate::instructions::apply_agent_instructions(home, &framework, &source) {
                return Err(invalid());
            }
            fs::remove_dir_all(staging)?;
            fs::remove_file(archive.source)
        }
        BundleApplication::Skill { mount, archive } => {
            let Some(relative) =
                crate::instructions::workflow_skill_relative_mount(home, Path::new(&mount))
            else {
                return Err(invalid());
            };
            if !paths.contains("SKILL.md") {
                return Err(invalid());
            }
            // All package paths are validated before touching a managed destination.
            let target = home.join(relative);
            let parent = target.parent().ok_or_else(invalid)?;
            let mut dir = home.to_path_buf();
            for part in parent
                .strip_prefix(home)
                .map_err(|_| invalid())?
                .components()
            {
                dir.push(part);
                match fs::create_dir(&dir) {
                    Ok(()) => fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?,
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(e),
                }
                if !fs::symlink_metadata(&dir)?.file_type().is_dir() {
                    return Err(invalid());
                }
            }
            let pinned = CleanupDirectory::open(parent)?;
            let target = pinned
                .proc_path()
                .join(target.file_name().ok_or_else(invalid)?);
            match fs::symlink_metadata(&target) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                    fs::remove_dir_all(&target)?
                }
                Ok(_) => return Err(invalid()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
            fs::rename(staging, target)?;
            fs::remove_file(archive.source)
        }
    }
}

fn unpack_archive(
    runtime: &Path,
    archive: &BundleArchiveSource,
    staging: &Path,
) -> io::Result<HashSet<String>> {
    let path = Path::new(&archive.source);
    if path.parent() != Some(runtime)
        || !path
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("bundle-"))
        || archive.archive_bytes == 0
        || archive.archive_bytes > 32 * 1024 * 1024
    {
        return Err(invalid());
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() || file.metadata()?.len() != archive.archive_bytes {
        return Err(invalid());
    }
    let source = crate::source::verify_archive(
        crate::source::ArchiveSource::local(file, Some(archive.archive_bytes)),
        &archive.sha256,
        Some(archive.archive_bytes),
    )
    .map_err(|error| io::Error::other(error.to_string()))?;
    let mut paths = HashSet::<String>::new();
    let mut total = 0u64;
    crate::archive::extract_tar_gz_checked(
        source,
        staging,
        34 * 1024 * 1024,
        |path, kind, size| {
            if !kind.is_file() || paths.len() >= 501 {
                return Err(invalid());
            }
            let path = path.to_str().ok_or_else(invalid)?;
            if path.is_empty()
                || path.encode_utf16().count() > 256
                || path.contains(['\\', '\0'])
                || path
                    .split('/')
                    .any(|p| p.is_empty() || p == "." || p == "..")
                || paths.contains(path)
                || paths.iter().any(|existing| {
                    path.strip_prefix(existing.as_str())
                        .is_some_and(|suffix| suffix.starts_with('/'))
                        || existing
                            .strip_prefix(path)
                            .is_some_and(|suffix| suffix.starts_with('/'))
                })
            {
                return Err(invalid());
            }
            total = total.saturating_add(size);
            if total > 32 * 1024 * 1024 {
                return Err(invalid());
            }
            paths.insert(path.into());
            Ok(())
        },
    )
    .map_err(|error| io::Error::other(error.to_string()))?;
    for path in &paths {
        fs::set_permissions(staging.join(path), fs::Permissions::from_mode(0o600))?;
    }
    Ok(paths)
}
