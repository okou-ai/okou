use crate::LOG_TAG;
use crate::cleanup_directory::CleanupDirectory;
use guest_telemetry::log_info;
use std::fs;
use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// Materialize the current Run's instruction file after ordinary Storage reconciliation.
/// The caller pins the source directory; only known framework files are replaced.
pub(crate) fn apply_agent_instructions(
    home: &Path,
    framework: &str,
    source: &Path,
) -> io::Result<()> {
    let (relative_home, filename) = match framework {
        "claude-code" => (".claude", InstructionFilename::Claude),
        "codex" => (".codex", InstructionFilename::Agents),
        "pi" => (".pi/agent", InstructionFilename::Agents),
        "antigravity" => (".gemini", InstructionFilename::Gemini),
        _ => return Err(io::Error::other("Unsupported instruction framework")),
    };
    // Storage delivered the source into the current Run's staging directory.
    match lstat_instruction_path_state(source) {
        InstructionPathState::RegularFile => {}
        InstructionPathState::MetadataError(error) => return Err(io::Error::other(error)),
        _ => {
            return Err(io::Error::other(
                "Missing or nonregular staged instruction file",
            ));
        }
    }
    require_instruction_directory(lstat_instruction_path_state(home))?;
    let mut target = home.to_path_buf();
    for component in Path::new(relative_home).components() {
        target.push(component);
        ensure_final_instruction_dir(&target)?;
    }
    copy_instruction_file(source, &target, filename, "Applied Agent instructions")
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
    Gemini,
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
    pub(crate) const ALL: [Self; 3] = [Self::Claude, Self::Agents, Self::Gemini];

    fn parse(filename: &str) -> Option<Self> {
        match filename {
            "CLAUDE.md" => Some(Self::Claude),
            "AGENTS.md" => Some(Self::Agents),
            "GEMINI.md" => Some(Self::Gemini),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "CLAUDE.md",
            Self::Agents => "AGENTS.md",
            Self::Gemini => "GEMINI.md",
        }
    }
}

pub(crate) fn cleanup_instruction_files(entries: &[InstructionCleanup]) -> io::Result<()> {
    for entry in entries {
        let filenames = match entry.target_filename.as_deref() {
            Some(raw) => vec![InstructionFilename::parse(raw).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "Invalid instruction cleanup filename",
                )
            })?],
            None => InstructionFilename::ALL.to_vec(),
        };
        let mount_path = Path::new(&entry.mount_path);
        // Preserve the no-op behavior of an empty mount path.
        if mount_path.as_os_str().is_empty() {
            continue;
        }
        let directory = match CleanupDirectory::open(mount_path) {
            Ok(directory) => directory,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        // Retain the opened directory through every leaf metadata check and unlink.
        for filename in filenames {
            remove_instruction_file_if_safe(
                &directory.proc_path().join(filename.as_str()),
                "Removed stale instructions file",
            )?;
        }
    }
    Ok(())
}

fn remove_instruction_file_if_safe(path: &Path, success_message: &str) -> io::Result<()> {
    match lstat_instruction_path_state(path) {
        InstructionPathState::Missing => return Ok(()),
        InstructionPathState::Directory | InstructionPathState::OtherNonRegular => {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Instruction cleanup target is not a regular file",
            ));
        }
        InstructionPathState::RegularFile | InstructionPathState::Symlink => {}
        InstructionPathState::MetadataError(error) => return Err(error),
    }
    fs::remove_file(path)?;
    log_info!(LOG_TAG, "{success_message}");
    Ok(())
}

fn ensure_final_instruction_dir(path: &Path) -> io::Result<()> {
    let state = match lstat_instruction_path_state(path) {
        InstructionPathState::Missing => {
            fs::create_dir_all(path)?;
            lstat_instruction_path_state(path)
        }
        state => state,
    };
    require_instruction_directory(state)
}

fn require_instruction_directory(state: InstructionPathState) -> io::Result<()> {
    match state {
        InstructionPathState::Directory => Ok(()),
        InstructionPathState::Missing => Err(io::Error::new(
            io::ErrorKind::NotFound,
            "Instruction directory is missing",
        )),
        InstructionPathState::RegularFile
        | InstructionPathState::Symlink
        | InstructionPathState::OtherNonRegular => Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            "Instruction parent is not a directory",
        )),
        InstructionPathState::MetadataError(error) => Err(error),
    }
}

fn copy_instruction_file(
    source_path: &Path,
    final_mount_path: &Path,
    target_filename: InstructionFilename,
    success_message: &str,
) -> io::Result<()> {
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
) -> io::Result<()> {
    let target_path = final_mount_path.join(target_filename.as_str());
    match lstat_instruction_path_state(&target_path) {
        InstructionPathState::RegularFile | InstructionPathState::Missing => {}
        InstructionPathState::Directory
        | InstructionPathState::Symlink
        | InstructionPathState::OtherNonRegular => {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Instruction target is not a regular file",
            ));
        }
        InstructionPathState::MetadataError(error) => return Err(error),
    }

    copy_instruction_file_atomically(source_path, &target_path, copy)?;
    log_info!(LOG_TAG, "{success_message}");
    remove_alternates_after_successful_copy(final_mount_path, target_filename, &target_path)
}

fn copy_instruction_file_atomically(
    source_path: &Path,
    target_path: &Path,
    copy: impl FnOnce(&mut fs::File, &mut fs::File) -> io::Result<u64>,
) -> io::Result<()> {
    let mut source = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(source_path)
        .map_err(io::Error::other)?;
    let source_metadata = source.metadata().map_err(io::Error::other)?;
    if !source_metadata.is_file() {
        return Err(io::Error::other("Instruction source is not a regular file"));
    }
    let source_permissions = source_metadata.permissions();
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
) -> io::Result<()> {
    match lstat_instruction_path_state(target_path) {
        InstructionPathState::RegularFile => {}
        InstructionPathState::Missing => {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Instruction target is missing after copy",
            ));
        }
        InstructionPathState::MetadataError(error) => return Err(error),
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Instruction target is not a regular file after copy",
            ));
        }
    }

    for candidate in InstructionFilename::ALL {
        if candidate != target_filename {
            remove_instruction_file_if_safe(
                &mount_path.join(candidate.as_str()),
                "Removed non-runtime instructions file",
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
