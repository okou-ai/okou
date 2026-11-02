use crate::LOG_TAG;
use crate::cleanup_directory::CleanupDirectory;
use guest_telemetry::{log_info, log_warn};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Materialize verified bundle instructions after ordinary Storage reconciliation.
/// The caller owns the private source file; only known framework files are replaced.
pub fn apply_agent_instructions(home: &Path, framework: &str, source: &Path) -> bool {
    let (relative_home, filename) = match framework {
        "claude-code" => (".claude", InstructionFilename::Claude),
        "codex" => (".codex", InstructionFilename::Agents),
        "pi" => (".pi/agent", InstructionFilename::Agents),
        _ => return false,
    };
    // The source was written through the Runner's private-file transport.
    if !matches!(
        lstat_instruction_path_state(source),
        InstructionPathState::RegularFile
    ) {
        return false;
    }
    if !existing_instruction_dir_is_safe(home) {
        return false;
    }
    let mut target = home.to_path_buf();
    for component in Path::new(relative_home).components() {
        target.push(component);
        if !ensure_final_instruction_dir(&target) {
            return false;
        }
    }
    copy_instruction_file(source, &target, filename, "Applied Agent instructions")
}

pub(crate) fn workflow_skill_relative_mount<'a>(home: &Path, mount: &'a Path) -> Option<&'a str> {
    let relative = mount.strip_prefix(home).ok()?.to_str()?;
    let name = [".claude/skills/", ".codex/skills/", ".pi/agent/skills/"]
        .iter()
        .find_map(|prefix| relative.strip_prefix(prefix))?;
    ((2..=64).contains(&name.len())
        && !name.starts_with('-')
        && !name.ends_with('-')
        && name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'))
    .then_some(relative)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct InstructionCleanup {
    mount_path: String,
    target_filename: Option<String>,
}
impl InstructionCleanup {
    pub(crate) fn new(mount_path: String, target_filename: Option<String>) -> Self {
        Self {
            mount_path,
            target_filename,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InstructionFilename {
    Claude,
    Agents,
}

enum InstructionPathState {
    Missing,
    Directory,
    RegularFile,
    Symlink,
    OtherNonRegular,
    MetadataError(io::Error),
}

impl InstructionFilename {
    pub(crate) const ALL: [Self; 2] = [Self::Claude, Self::Agents];

    fn parse(filename: &str) -> Option<Self> {
        match filename {
            "CLAUDE.md" => Some(Self::Claude),
            "AGENTS.md" => Some(Self::Agents),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "CLAUDE.md",
            Self::Agents => "AGENTS.md",
        }
    }
}

pub(crate) fn cleanup_instruction_files(entries: &[InstructionCleanup]) -> bool {
    for entry in entries {
        let Some(filenames) = cleanup_filenames(entry) else {
            return false;
        };
        let mount_path = Path::new(&entry.mount_path);
        // Preserve the no-op behavior of an empty mount path.
        if mount_path.as_os_str().is_empty() {
            continue;
        }
        let directory = match CleanupDirectory::open(mount_path) {
            Ok(directory) => directory,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => {
                log_warn!(
                    LOG_TAG,
                    "Failed to open instructions cleanup directory: {e}"
                );
                return false;
            }
        };
        // Retain the opened directory through every leaf metadata check and unlink.
        for filename in filenames {
            if !remove_instruction_file_if_safe(&directory.proc_path().join(filename.as_str())) {
                return false;
            }
        }
    }
    true
}
fn cleanup_filenames(entry: &InstructionCleanup) -> Option<Vec<InstructionFilename>> {
    match entry.target_filename.as_deref() {
        Some(raw) => match InstructionFilename::parse(raw) {
            Some(filename) => Some(vec![filename]),
            None => {
                log_warn!(
                    LOG_TAG,
                    "Skipping invalid instructions cleanup target filename"
                );
                None
            }
        },
        None => Some(InstructionFilename::ALL.to_vec()),
    }
}
fn remove_instruction_file_if_safe(path: &Path) -> bool {
    match lstat_instruction_path_state(path) {
        InstructionPathState::Missing => true,
        InstructionPathState::Directory | InstructionPathState::OtherNonRegular => {
            log_warn!(LOG_TAG, "Stale instructions path is not a regular file");
            false
        }
        InstructionPathState::RegularFile | InstructionPathState::Symlink => {
            match fs::remove_file(path) {
                Ok(_) => {
                    log_info!(LOG_TAG, "Removed stale instructions file");
                    true
                }
                Err(e) => {
                    log_warn!(LOG_TAG, "Failed to remove stale instructions file: {}", e);
                    false
                }
            }
        }
        InstructionPathState::MetadataError(e) => {
            log_warn!(LOG_TAG, "Failed to inspect stale instructions file: {}", e);
            false
        }
    }
}

fn ensure_final_instruction_dir(path: &Path) -> bool {
    match lstat_instruction_path_state(path) {
        InstructionPathState::Directory => true,
        InstructionPathState::Missing => match fs::create_dir_all(path) {
            Ok(()) => existing_instruction_dir_is_safe(path),
            Err(e) => {
                log_warn!(
                    LOG_TAG,
                    "Failed to create final instructions directory: {}",
                    e
                );
                false
            }
        },
        InstructionPathState::RegularFile
        | InstructionPathState::Symlink
        | InstructionPathState::OtherNonRegular => {
            log_warn!(
                LOG_TAG,
                "Skipping instructions operation because framework home is not a directory"
            );
            false
        }
        InstructionPathState::MetadataError(e) => {
            log_warn!(LOG_TAG, "Failed to inspect instructions directory: {}", e);
            false
        }
    }
}

fn existing_instruction_dir_is_safe(path: &Path) -> bool {
    match lstat_instruction_path_state(path) {
        InstructionPathState::Directory => true,
        InstructionPathState::Missing => false,
        InstructionPathState::RegularFile
        | InstructionPathState::Symlink
        | InstructionPathState::OtherNonRegular => {
            log_warn!(
                LOG_TAG,
                "Skipping instructions operation because framework home is not a directory"
            );
            false
        }
        InstructionPathState::MetadataError(e) => {
            log_warn!(LOG_TAG, "Failed to inspect instructions directory: {}", e);
            false
        }
    }
}

fn copy_instruction_file(
    source_path: &Path,
    final_mount_path: &Path,
    target_filename: InstructionFilename,
    success_message: &str,
) -> bool {
    copy_instruction_file_with(
        source_path,
        final_mount_path,
        target_filename,
        success_message,
        io::copy,
    )
}

fn copy_instruction_file_with(
    source_path: &Path,
    final_mount_path: &Path,
    target_filename: InstructionFilename,
    success_message: &str,
    copy: impl FnOnce(&mut fs::File, &mut fs::File) -> io::Result<u64>,
) -> bool {
    let target_path = final_mount_path.join(target_filename.as_str());
    match lstat_instruction_path_state(&target_path) {
        InstructionPathState::RegularFile | InstructionPathState::Missing => {}
        InstructionPathState::Directory
        | InstructionPathState::Symlink
        | InstructionPathState::OtherNonRegular => {
            log_warn!(
                LOG_TAG,
                "Skipping instructions copy because target is not a regular file"
            );
            return false;
        }
        InstructionPathState::MetadataError(e) => {
            log_warn!(LOG_TAG, "Failed to inspect instructions target: {}", e);
            return false;
        }
    }

    match copy_instruction_file_atomically(source_path, &target_path, copy) {
        Ok(()) => {
            log_info!(LOG_TAG, "{}", success_message);
            remove_alternates_after_successful_copy(final_mount_path, target_filename, &target_path)
        }
        Err(e) => {
            log_warn!(LOG_TAG, "Failed to copy instructions file: {}", e);
            false
        }
    }
}

fn copy_instruction_file_atomically(
    source_path: &Path,
    target_path: &Path,
    copy: impl FnOnce(&mut fs::File, &mut fs::File) -> io::Result<u64>,
) -> io::Result<()> {
    let mut source = fs::File::open(source_path)?;
    let source_permissions = source.metadata()?.permissions();
    let (mut temp_file, temp_path) = create_instruction_temp_file(target_path)?;
    let result = (|| {
        copy(&mut source, &mut temp_file)?;
        drop(temp_file);
        fs::set_permissions(&temp_path, source_permissions)?;
        fs::rename(&temp_path, target_path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn create_instruction_temp_file(target_path: &Path) -> io::Result<(fs::File, PathBuf)> {
    let Some(parent) = target_path.parent() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "instructions target has no parent directory",
        ));
    };
    let target_name = target_path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "instructions".into());
    for attempt in 0..16 {
        let temp_path = parent.join(format!(
            ".{target_name}.vm0-copy-{}-{attempt}.tmp",
            std::process::id()
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => return Ok((file, temp_path)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "failed to create instructions temp file",
    ))
}

fn lstat_instruction_path_state(path: &Path) -> InstructionPathState {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => InstructionPathState::Directory,
        Ok(metadata) if metadata.file_type().is_file() => InstructionPathState::RegularFile,
        Ok(metadata) if metadata.file_type().is_symlink() => InstructionPathState::Symlink,
        Ok(_) => InstructionPathState::OtherNonRegular,
        Err(e) if e.kind() == io::ErrorKind::NotFound => InstructionPathState::Missing,
        Err(e) => InstructionPathState::MetadataError(e),
    }
}

fn remove_alternates_after_successful_copy(
    mount_path: &Path,
    target_filename: InstructionFilename,
    target_path: &Path,
) -> bool {
    match lstat_instruction_path_state(target_path) {
        InstructionPathState::RegularFile => {
            return remove_alternate_instruction_files(mount_path, target_filename);
        }
        InstructionPathState::Directory => log_warn!(
            LOG_TAG,
            "Normalized instructions target is a directory after copy"
        ),
        InstructionPathState::Missing => log_warn!(
            LOG_TAG,
            "Normalized instructions target is missing after copy"
        ),
        InstructionPathState::Symlink | InstructionPathState::OtherNonRegular => log_warn!(
            LOG_TAG,
            "Normalized instructions target is not a regular file after copy"
        ),
        InstructionPathState::MetadataError(e) => log_warn!(
            LOG_TAG,
            "Failed to inspect normalized instructions target: {}",
            e
        ),
    }
    false
}

fn remove_alternate_instruction_files(
    mount_path: &Path,
    target_filename: InstructionFilename,
) -> bool {
    for candidate in InstructionFilename::ALL {
        if candidate == target_filename {
            continue;
        }

        let path = mount_path.join(candidate.as_str());
        match lstat_instruction_path_state(&path) {
            InstructionPathState::Missing => continue,
            InstructionPathState::Directory | InstructionPathState::OtherNonRegular => {
                log_warn!(
                    LOG_TAG,
                    "Non-runtime instructions path is not a regular file"
                );
                return false;
            }
            InstructionPathState::RegularFile | InstructionPathState::Symlink => {}
            InstructionPathState::MetadataError(e) => {
                log_warn!(
                    LOG_TAG,
                    "Failed to inspect non-runtime instructions file: {}",
                    e
                );
                return false;
            }
        }

        match fs::remove_file(&path) {
            Ok(_) => log_info!(LOG_TAG, "Removed non-runtime instructions file"),
            Err(e) => {
                log_warn!(
                    LOG_TAG,
                    "Failed to remove non-runtime instructions file: {}",
                    e
                );
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests;
