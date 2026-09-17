use crate::LOG_TAG;
use guest_telemetry::{log_info, log_warn};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const STAGED_INSTRUCTIONS_DIR_NAME: &str = "storage-instructions";

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct InstructionNormalization {
    source_path: String,
    final_mount_path: String,
    target_filename: String,
    cleanup_source_path: Option<String>,
}

impl InstructionNormalization {
    pub(crate) fn in_place(mount_path: String, target_filename: String) -> Self {
        Self {
            source_path: mount_path.clone(),
            final_mount_path: mount_path,
            target_filename,
            cleanup_source_path: None,
        }
    }

    pub(crate) fn staged(
        source_path: String,
        final_mount_path: String,
        target_filename: String,
    ) -> Self {
        Self {
            cleanup_source_path: Some(source_path.clone()),
            source_path,
            final_mount_path,
            target_filename,
        }
    }
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

pub(crate) fn normalize_instruction_files(entries: &[InstructionNormalization]) {
    for entry in entries {
        let raw_target_filename = entry.target_filename.as_str();
        let Some(target_filename) = InstructionFilename::parse(raw_target_filename) else {
            log_warn!(LOG_TAG, "Skipping invalid instructions target filename");
            cleanup_staged_instruction_source(entry);
            continue;
        };

        if entry.source_path == entry.final_mount_path {
            normalize_instruction_files_in_place(
                Path::new(&entry.final_mount_path),
                target_filename,
            );
        } else {
            promote_staged_instruction_file(entry, target_filename);
            cleanup_staged_instruction_source(entry);
        }
    }
}

pub(crate) fn cleanup_instruction_files(entries: &[InstructionCleanup]) {
    for entry in entries {
        let Some(filenames) = cleanup_filenames(entry) else {
            continue;
        };
        let mount_path = Path::new(&entry.mount_path);
        if !existing_instruction_dir_is_safe(mount_path) {
            continue;
        }
        for filename in filenames {
            remove_instruction_file_if_safe(&mount_path.join(filename.as_str()));
        }
    }
}

pub(crate) fn cleanup_staged_instruction_sources(entries: &[InstructionNormalization]) {
    for entry in entries {
        cleanup_staged_instruction_source(entry);
    }
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

fn normalize_instruction_files_in_place(mount_path: &Path, target_filename: InstructionFilename) {
    let target_path = mount_path.join(target_filename.as_str());
    match lstat_instruction_path_state(&target_path) {
        InstructionPathState::RegularFile => {
            remove_alternate_instruction_files(mount_path, target_filename);
            return;
        }
        InstructionPathState::Missing => {}
        InstructionPathState::Directory
        | InstructionPathState::Symlink
        | InstructionPathState::OtherNonRegular => {
            log_warn!(
                LOG_TAG,
                "Skipping instructions normalization because target is not a regular file"
            );
            return;
        }
        InstructionPathState::MetadataError(e) => {
            log_warn!(LOG_TAG, "Failed to inspect instructions target: {}", e);
            return;
        }
    }

    let Some(source_path) = alternate_instruction_source(mount_path, target_filename) else {
        log_warn!(LOG_TAG, "No instructions file found to normalize");
        return;
    };

    copy_instruction_file(
        &source_path,
        mount_path,
        target_filename,
        "Normalized instructions file",
    );
}

fn promote_staged_instruction_file(
    entry: &InstructionNormalization,
    target_filename: InstructionFilename,
) -> bool {
    let source_mount_path = Path::new(&entry.source_path);
    let final_mount_path = Path::new(&entry.final_mount_path);
    let Some(source_path) = instruction_source(source_mount_path, target_filename) else {
        log_warn!(LOG_TAG, "No staged instructions file found to promote");
        return false;
    };

    if !ensure_final_instruction_dir(final_mount_path) {
        return false;
    }

    copy_instruction_file(
        &source_path,
        final_mount_path,
        target_filename,
        "Promoted staged instructions file",
    )
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

fn instruction_source(
    mount_path: &Path,
    target_filename: InstructionFilename,
) -> Option<std::path::PathBuf> {
    let target_path = mount_path.join(target_filename.as_str());
    if matches!(
        lstat_instruction_path_state(&target_path),
        InstructionPathState::RegularFile
    ) {
        return Some(target_path);
    }
    alternate_instruction_source(mount_path, target_filename)
}

fn alternate_instruction_source(
    mount_path: &Path,
    target_filename: InstructionFilename,
) -> Option<std::path::PathBuf> {
    InstructionFilename::ALL
        .iter()
        .copied()
        .filter(|candidate| *candidate != target_filename)
        .map(|candidate| mount_path.join(candidate.as_str()))
        .find(|path| {
            matches!(
                lstat_instruction_path_state(path),
                InstructionPathState::RegularFile
            )
        })
}

fn copy_instruction_file(
    source_path: &Path,
    final_mount_path: &Path,
    target_filename: InstructionFilename,
    success_message: &str,
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

    match copy_instruction_file_atomically(source_path, &target_path) {
        Ok(()) => {
            log_info!(LOG_TAG, "{}", success_message);
            remove_alternates_after_successful_copy(
                final_mount_path,
                target_filename,
                &target_path,
            );
            true
        }
        Err(e) => {
            log_warn!(LOG_TAG, "Failed to copy instructions file: {}", e);
            false
        }
    }
}

fn copy_instruction_file_atomically(source_path: &Path, target_path: &Path) -> io::Result<()> {
    let mut source = fs::File::open(source_path)?;
    let source_permissions = source.metadata()?.permissions();
    let (mut temp_file, temp_path) = create_instruction_temp_file(target_path)?;
    let result = (|| {
        io::copy(&mut source, &mut temp_file)?;
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

fn cleanup_staged_instruction_source(entry: &InstructionNormalization) {
    let Some(path) = entry.cleanup_source_path.as_deref() else {
        return;
    };
    let path = Path::new(path);
    match fs::remove_dir_all(path) {
        Ok(_) => {
            log_info!(LOG_TAG, "Removed staged instructions directory");
            cleanup_empty_staged_instruction_parent(path);
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            cleanup_empty_staged_instruction_parent(path);
        }
        Err(e) => log_warn!(
            LOG_TAG,
            "Failed to remove staged instructions directory: {}",
            e
        ),
    }
}

fn cleanup_empty_staged_instruction_parent(path: &Path) {
    let Some(parent) = path.parent() else {
        return;
    };
    if parent.file_name().and_then(|name| name.to_str()) != Some(STAGED_INSTRUCTIONS_DIR_NAME) {
        return;
    }
    match fs::remove_dir(parent) {
        Ok(_) => log_info!(
            LOG_TAG,
            "Removed empty staged instructions parent directory"
        ),
        Err(e)
            if matches!(
                e.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::DirectoryNotEmpty
            ) => {}
        Err(e) => log_warn!(
            LOG_TAG,
            "Failed to remove empty staged instructions parent directory: {}",
            e
        ),
    }
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
) {
    match lstat_instruction_path_state(target_path) {
        InstructionPathState::RegularFile => {
            remove_alternate_instruction_files(mount_path, target_filename);
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
}

fn remove_alternate_instruction_files(mount_path: &Path, target_filename: InstructionFilename) {
    for candidate in InstructionFilename::ALL {
        if candidate == target_filename {
            continue;
        }

        let path = mount_path.join(candidate.as_str());
        match lstat_instruction_path_state(&path) {
            InstructionPathState::Missing => continue,
            InstructionPathState::Directory => continue,
            InstructionPathState::RegularFile | InstructionPathState::Symlink => {}
            InstructionPathState::OtherNonRegular => continue,
            InstructionPathState::MetadataError(e) => {
                log_warn!(
                    LOG_TAG,
                    "Failed to inspect non-runtime instructions file: {}",
                    e
                );
                continue;
            }
        }

        match fs::remove_file(&path) {
            Ok(_) => log_info!(LOG_TAG, "Removed non-runtime instructions file"),
            Err(e) => log_warn!(
                LOG_TAG,
                "Failed to remove non-runtime instructions file: {}",
                e
            ),
        }
    }
}

fn remove_instruction_file_if_safe(path: &Path) {
    match lstat_instruction_path_state(path) {
        InstructionPathState::Missing => {}
        InstructionPathState::Directory => {}
        InstructionPathState::RegularFile | InstructionPathState::Symlink => {
            match fs::remove_file(path) {
                Ok(_) => log_info!(LOG_TAG, "Removed stale instructions file"),
                Err(e) => log_warn!(LOG_TAG, "Failed to remove stale instructions file: {}", e),
            }
        }
        InstructionPathState::OtherNonRegular => {}
        InstructionPathState::MetadataError(e) => {
            log_warn!(LOG_TAG, "Failed to inspect stale instructions file: {}", e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disable_system_log() {
        guest_telemetry::log::clear_system_log_file();
    }

    #[test]
    fn normalize_instruction_files_copies_claude_to_agents_for_codex_target() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        fs::create_dir_all(&mount).unwrap();
        fs::write(mount.join("CLAUDE.md"), "runtime instructions").unwrap();

        normalize_instruction_files(&[InstructionNormalization::in_place(
            mount.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert_eq!(
            fs::read_to_string(mount.join("AGENTS.md")).unwrap(),
            "runtime instructions"
        );
        assert!(!mount.join("CLAUDE.md").exists());
    }

    #[test]
    fn normalize_instruction_files_copies_agents_to_claude_for_claude_target() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".claude");
        fs::create_dir_all(&mount).unwrap();
        fs::write(mount.join("AGENTS.md"), "runtime instructions").unwrap();

        normalize_instruction_files(&[InstructionNormalization::in_place(
            mount.to_string_lossy().into(),
            "CLAUDE.md".into(),
        )]);

        assert_eq!(
            fs::read_to_string(mount.join("CLAUDE.md")).unwrap(),
            "runtime instructions"
        );
        assert!(!mount.join("AGENTS.md").exists());
    }

    #[test]
    fn normalize_instruction_files_leaves_existing_target_unchanged() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        fs::create_dir_all(&mount).unwrap();
        fs::write(mount.join("CLAUDE.md"), "legacy").unwrap();
        fs::write(mount.join("AGENTS.md"), "canonical").unwrap();

        normalize_instruction_files(&[InstructionNormalization::in_place(
            mount.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert_eq!(
            fs::read_to_string(mount.join("AGENTS.md")).unwrap(),
            "canonical"
        );
        assert!(!mount.join("CLAUDE.md").exists());
    }

    #[test]
    fn normalize_instruction_files_keeps_alternate_when_target_is_directory() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        fs::create_dir_all(mount.join("AGENTS.md")).unwrap();
        fs::write(mount.join("CLAUDE.md"), "runtime instructions").unwrap();

        normalize_instruction_files(&[InstructionNormalization::in_place(
            mount.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert_eq!(
            fs::read_to_string(mount.join("CLAUDE.md")).unwrap(),
            "runtime instructions"
        );
        assert!(mount.join("AGENTS.md").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn normalize_instruction_files_keeps_alternate_when_target_is_symlink() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        fs::create_dir_all(&mount).unwrap();
        fs::write(mount.join("target.md"), "linked target").unwrap();
        fs::write(mount.join("CLAUDE.md"), "runtime instructions").unwrap();
        std::os::unix::fs::symlink(mount.join("target.md"), mount.join("AGENTS.md")).unwrap();

        normalize_instruction_files(&[InstructionNormalization::in_place(
            mount.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert_eq!(
            fs::read_to_string(mount.join("CLAUDE.md")).unwrap(),
            "runtime instructions"
        );
        assert!(
            mount
                .join("AGENTS.md")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(unix)]
    #[test]
    fn normalize_instruction_files_removes_dangling_alternate_symlink() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        fs::create_dir_all(&mount).unwrap();
        fs::write(mount.join("AGENTS.md"), "runtime instructions").unwrap();
        std::os::unix::fs::symlink(mount.join("missing.md"), mount.join("CLAUDE.md")).unwrap();

        normalize_instruction_files(&[InstructionNormalization::in_place(
            mount.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert!(mount.join("CLAUDE.md").symlink_metadata().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn normalize_instruction_files_ignores_alternate_symlink_source() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        fs::create_dir_all(&mount).unwrap();
        fs::write(mount.join("linked.md"), "runtime instructions").unwrap();
        std::os::unix::fs::symlink(mount.join("linked.md"), mount.join("CLAUDE.md")).unwrap();

        normalize_instruction_files(&[InstructionNormalization::in_place(
            mount.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert!(mount.join("AGENTS.md").symlink_metadata().is_err());
        assert!(
            mount
                .join("CLAUDE.md")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn normalize_instruction_files_promotes_staged_target_to_final_home() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("staged");
        let final_home = dir.path().join(".codex");
        fs::create_dir_all(staged.join("nested")).unwrap();
        fs::create_dir_all(final_home.join("skills").join("workflow")).unwrap();
        fs::write(staged.join("AGENTS.md"), "new instructions").unwrap();
        fs::write(staged.join("extra.txt"), "extra").unwrap();
        fs::write(staged.join("nested").join("AGENTS.md"), "nested").unwrap();
        fs::write(final_home.join("AGENTS.md"), "old instructions").unwrap();
        fs::write(final_home.join("CLAUDE.md"), "old alternate").unwrap();
        fs::write(
            final_home.join("skills").join("workflow").join("SKILL.md"),
            "skill",
        )
        .unwrap();

        normalize_instruction_files(&[InstructionNormalization::staged(
            staged.to_string_lossy().into(),
            final_home.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert_eq!(
            fs::read_to_string(final_home.join("AGENTS.md")).unwrap(),
            "new instructions"
        );
        assert!(!final_home.join("CLAUDE.md").exists());
        assert!(!final_home.join("extra.txt").exists());
        assert!(!final_home.join("nested").exists());
        assert_eq!(
            fs::read_to_string(final_home.join("skills").join("workflow").join("SKILL.md"))
                .unwrap(),
            "skill"
        );
        assert!(!staged.exists());
    }

    #[test]
    fn copy_instruction_file_failure_keeps_existing_target() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let final_home = dir.path().join(".codex");
        fs::create_dir_all(&final_home).unwrap();
        fs::write(final_home.join("AGENTS.md"), "old instructions").unwrap();

        assert!(!copy_instruction_file(
            &dir.path().join("missing.md"),
            &final_home,
            InstructionFilename::Agents,
            "Copied instructions file",
        ));

        assert_eq!(
            fs::read_to_string(final_home.join("AGENTS.md")).unwrap(),
            "old instructions"
        );
        assert_eq!(fs::read_dir(&final_home).unwrap().count(), 1);
    }

    #[test]
    fn normalize_instruction_files_promotes_staged_alternate_when_target_is_missing() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("staged");
        let final_home = dir.path().join(".codex");
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("CLAUDE.md"), "alternate instructions").unwrap();

        normalize_instruction_files(&[InstructionNormalization::staged(
            staged.to_string_lossy().into(),
            final_home.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert_eq!(
            fs::read_to_string(final_home.join("AGENTS.md")).unwrap(),
            "alternate instructions"
        );
        assert!(!final_home.join("CLAUDE.md").exists());
        assert!(!staged.exists());
    }

    #[test]
    fn normalize_instruction_files_removes_staged_source_when_promote_has_no_instruction_file() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("staged");
        let final_home = dir.path().join(".codex");
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("extra.txt"), "ignored").unwrap();

        normalize_instruction_files(&[InstructionNormalization::staged(
            staged.to_string_lossy().into(),
            final_home.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert!(!final_home.join("AGENTS.md").exists());
        assert!(!staged.exists());
    }

    #[test]
    fn normalize_instruction_files_removes_staged_source_for_invalid_target() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("staged");
        let final_home = dir.path().join(".codex");
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("AGENTS.md"), "new instructions").unwrap();

        normalize_instruction_files(&[InstructionNormalization::staged(
            staged.to_string_lossy().into(),
            final_home.to_string_lossy().into(),
            "../outside.md".into(),
        )]);

        assert!(!final_home.join("AGENTS.md").exists());
        assert!(!staged.exists());
    }

    #[cfg(unix)]
    #[test]
    fn normalize_instruction_files_does_not_follow_final_target_symlink() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("staged");
        let final_home = dir.path().join(".codex");
        let linked_target = dir.path().join("outside.md");
        fs::create_dir_all(&staged).unwrap();
        fs::create_dir_all(&final_home).unwrap();
        fs::write(staged.join("AGENTS.md"), "new instructions").unwrap();
        fs::write(&linked_target, "outside").unwrap();
        std::os::unix::fs::symlink(&linked_target, final_home.join("AGENTS.md")).unwrap();

        normalize_instruction_files(&[InstructionNormalization::staged(
            staged.to_string_lossy().into(),
            final_home.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert_eq!(fs::read_to_string(&linked_target).unwrap(), "outside");
        assert!(
            final_home
                .join("AGENTS.md")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(!staged.exists());
    }

    #[cfg(unix)]
    #[test]
    fn normalize_instruction_files_does_not_follow_final_home_symlink() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("staged");
        let final_home = dir.path().join(".codex");
        let outside_home = dir.path().join("outside-home");
        fs::create_dir_all(&staged).unwrap();
        fs::create_dir_all(&outside_home).unwrap();
        fs::write(staged.join("AGENTS.md"), "new instructions").unwrap();
        std::os::unix::fs::symlink(&outside_home, &final_home).unwrap();

        normalize_instruction_files(&[InstructionNormalization::staged(
            staged.to_string_lossy().into(),
            final_home.to_string_lossy().into(),
            "AGENTS.md".into(),
        )]);

        assert!(!outside_home.join("AGENTS.md").exists());
        assert!(
            final_home
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(!staged.exists());
    }

    #[test]
    fn cleanup_instruction_files_removes_only_known_instruction_files() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        fs::create_dir_all(mount.join("skills").join("workflow")).unwrap();
        fs::create_dir_all(mount.join("CLAUDE.md")).unwrap();
        fs::write(mount.join("AGENTS.md"), "old").unwrap();
        fs::write(mount.join("settings.json"), "{}").unwrap();
        fs::write(
            mount.join("skills").join("workflow").join("SKILL.md"),
            "skill",
        )
        .unwrap();

        cleanup_instruction_files(&[InstructionCleanup::new(
            mount.to_string_lossy().into(),
            None,
        )]);

        assert!(!mount.join("AGENTS.md").exists());
        assert!(mount.join("CLAUDE.md").is_dir());
        assert_eq!(
            fs::read_to_string(mount.join("settings.json")).unwrap(),
            "{}"
        );
        assert_eq!(
            fs::read_to_string(mount.join("skills").join("workflow").join("SKILL.md")).unwrap(),
            "skill"
        );
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_instruction_files_removes_instruction_symlink_without_following_it() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        let linked_target = dir.path().join("outside.md");
        fs::create_dir_all(&mount).unwrap();
        fs::write(&linked_target, "outside").unwrap();
        std::os::unix::fs::symlink(&linked_target, mount.join("AGENTS.md")).unwrap();

        cleanup_instruction_files(&[InstructionCleanup::new(
            mount.to_string_lossy().into(),
            Some("AGENTS.md".into()),
        )]);

        assert!(mount.join("AGENTS.md").symlink_metadata().is_err());
        assert_eq!(fs::read_to_string(&linked_target).unwrap(), "outside");
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_instruction_files_does_not_follow_home_symlink() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        let outside_home = dir.path().join("outside-home");
        fs::create_dir_all(&outside_home).unwrap();
        fs::write(outside_home.join("AGENTS.md"), "outside").unwrap();
        std::os::unix::fs::symlink(&outside_home, &mount).unwrap();

        cleanup_instruction_files(&[InstructionCleanup::new(
            mount.to_string_lossy().into(),
            None,
        )]);

        assert_eq!(
            fs::read_to_string(outside_home.join("AGENTS.md")).unwrap(),
            "outside"
        );
        assert!(mount.symlink_metadata().unwrap().file_type().is_symlink());
    }

    #[test]
    fn normalize_instruction_files_skips_invalid_target_without_deleting_files() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let mount = dir.path().join(".codex");
        fs::create_dir_all(&mount).unwrap();
        fs::write(mount.join("CLAUDE.md"), "claude").unwrap();
        fs::write(mount.join("AGENTS.md"), "agents").unwrap();

        normalize_instruction_files(&[InstructionNormalization::in_place(
            mount.to_string_lossy().into(),
            "../outside.md".into(),
        )]);

        assert_eq!(
            fs::read_to_string(mount.join("CLAUDE.md")).unwrap(),
            "claude"
        );
        assert_eq!(
            fs::read_to_string(mount.join("AGENTS.md")).unwrap(),
            "agents"
        );
        assert!(!dir.path().join("outside.md").exists());
    }
}
