//! Descriptor-safe session-history resolution for typed framework sources.
//!
//! The codex sessions layout is `${CODEX_HOME}/sessions/YYYY/MM/DD/<file>.jsonl[.zst]`.
//! Filenames are not stably keyed to thread_id in the real codex CLI
//! (the `rollout-` prefix mangles dashes), so we match by dash-stripped
//! UUID substring. Lookup only scans the expected `YYYY/MM/DD` layout and is
//! budgeted so user-controlled session trees cannot make checkpoint perform an
//! unbounded filesystem walk. If no filename matches, we fail fast — silently
//! picking "the most recent file in the tree" would risk uploading an unrelated
//! session as the resume context, which is a multi-tenant correctness hazard.
//! Resolution fails when there is no unique bounded match; it never selects a
//! newest or otherwise unrelated fallback.

use crate::error::AgentError;
#[cfg(target_os = "linux")]
use crate::nofollow_fs::Dir;
use guest_contracts::cli_agent_session_id::is_valid_cli_agent_session_id;
use guest_contracts::codex_thread_id::codex_thread_id_filename_key;
use guest_contracts::session_history_identity::SessionHistorySourceRef;
use sha2::{Digest, Sha256};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{self, BufReader, Read, Seek, Write};
use std::path::{Path, PathBuf};

// Checkpoint must resolve Codex history from user-controlled guest-home state.
// Keep the budget comfortably above normal date-partitioned histories while
// preventing layout-shaped trees from turning session lookup into an
// unbounded synchronous walk.
const CODEX_SESSION_LOOKUP_SCAN_BUDGET: usize = 16_384;
const CODEX_SESSION_LOOKUP_SCAN_BUDGET_ERROR: &str = "Codex session lookup exceeded scan budget";

pub(crate) fn session_history_exceeds_max_error(max_bytes: u64) -> AgentError {
    AgentError::CheckpointHistoryTooLarge { max_bytes }
}

pub(crate) struct SessionHistoryDigest {
    pub(crate) size_bytes: u64,
    pub(crate) sha256_hex: String,
}

pub(crate) enum SessionHistoryCheckpointSource {
    Decoded(Vec<u8>),
    CodexZstd { encoded: Vec<u8> },
}

pub(crate) struct SafeHistoryReplacementTarget {
    #[cfg(target_os = "linux")]
    parent: Dir,
    parent_path: PathBuf,
    leaf_name: OsString,
}

impl SafeHistoryReplacementTarget {
    #[cfg(target_os = "linux")]
    pub(crate) fn stage(&self, candidate: &[u8]) -> io::Result<SafeHistoryReplacement> {
        let parent = self.parent.try_clone()?;
        let staged_name =
            OsString::from(format!(".vm0-session-history-{}.tmp", uuid::Uuid::new_v4()));
        let mut staged_file = parent.create_child_file(&staged_name)?;
        let replacement = SafeHistoryReplacement {
            parent,
            parent_path: self.parent_path.clone(),
            staged_name,
            target_name: self.leaf_name.clone(),
            persisted: false,
        };
        staged_file.write_all(candidate)?;
        staged_file.flush()?;
        drop(staged_file);
        Ok(replacement)
    }

    #[cfg(not(target_os = "linux"))]
    pub(crate) fn stage(&self, _candidate: &[u8]) -> io::Result<SafeHistoryReplacement> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "safe session history replacement is unsupported on this platform",
        ))
    }
}

pub(crate) struct SafeHistoryReplacement {
    #[cfg(target_os = "linux")]
    parent: Dir,
    parent_path: PathBuf,
    staged_name: OsString,
    target_name: OsString,
    persisted: bool,
}

impl SafeHistoryReplacement {
    #[cfg(target_os = "linux")]
    pub(crate) fn persist(mut self) -> io::Result<()> {
        self.ensure_parent_path_still_matches()?;
        self.parent
            .rename_child(&self.staged_name, &self.target_name)?;
        self.persisted = true;
        self.ensure_parent_path_still_matches()
    }

    #[cfg(not(target_os = "linux"))]
    pub(crate) fn persist(self) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "safe session history replacement is unsupported on this platform",
        ))
    }

    #[cfg(target_os = "linux")]
    fn ensure_parent_path_still_matches(&self) -> io::Result<()> {
        let current = Dir::open_absolute(&self.parent_path)?;
        if current.identity()? == self.parent.identity()? {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                "session history parent path changed before replacement",
            ))
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for SafeHistoryReplacement {
    fn drop(&mut self) {
        if !self.persisted {
            let _ = self.parent.unlink_child_file(&self.staged_name);
        }
    }
}

pub(crate) struct ResolvedSessionHistory {
    path: PathBuf,
    file: File,
    is_zstd: bool,
    replacement_target: SafeHistoryReplacementTarget,
}

impl ResolvedSessionHistory {
    pub(crate) fn plain_file_mut(&mut self) -> Option<&mut File> {
        (!self.is_zstd).then_some(&mut self.file)
    }

    pub(crate) fn replacement_target(&self) -> &SafeHistoryReplacementTarget {
        &self.replacement_target
    }

    pub(crate) fn into_checkpoint_source_bounded(
        self,
        max_bytes: u64,
    ) -> Result<SessionHistoryCheckpointSource, AgentError> {
        read_open_codex_checkpoint_source_bounded(self.path, self.file, self.is_zstd, max_bytes)
    }

    fn into_decoded_reader(self) -> Result<DecodedSessionHistoryReader, AgentError> {
        DecodedSessionHistoryReader::open(self.path, self.file)
    }

    /// Digest the actual named source only while it remains on the retained home mount.
    pub(crate) fn digest_retained_home(
        self,
        max_bytes: u64,
    ) -> Result<SessionHistoryDigest, SessionHistoryDigestError> {
        #[cfg(target_os = "linux")]
        {
            use crate::nofollow_fs::file_identity;
            use std::os::unix::fs::MetadataExt;
            let home = Dir::open_absolute(Path::new("/home/user"))
                .map_err(|error| read_history_error(&self.path, error))?;
            let home_identity = home
                .identity()
                .map_err(|error| read_history_error(&self.path, error))?;
            let identity =
                file_identity(&self.file).map_err(|error| read_history_error(&self.path, error))?;
            identity
                .ensure_same_mount(home_identity)
                .map_err(|error| read_history_error(&self.path, error))?;
            self.replacement_target
                .parent
                .identity()
                .and_then(|parent| parent.ensure_same_mount(home_identity))
                .map_err(|error| read_history_error(&self.path, error))?;
            let before = self
                .file
                .metadata()
                .map_err(|error| read_history_error(&self.path, error))?;
            let file = self
                .file
                .try_clone()
                .map_err(|error| read_history_error(&self.path, error))?;
            let digest =
                DecodedSessionHistoryReader::open(self.path.clone(), file)?.digest(max_bytes)?;
            let current_parent = Dir::open_absolute(&self.replacement_target.parent_path)
                .map_err(|error| read_history_error(&self.path, error))?;
            let named = current_parent
                .open_child_file(&self.replacement_target.leaf_name)
                .map_err(|error| read_history_error(&self.path, error))?;
            let after = named
                .metadata()
                .map_err(|error| read_history_error(&self.path, error))?;
            if current_parent
                .identity()
                .map_err(|error| read_history_error(&self.path, error))?
                != self
                    .replacement_target
                    .parent
                    .identity()
                    .map_err(|error| read_history_error(&self.path, error))?
                || file_identity(&named).map_err(|error| read_history_error(&self.path, error))?
                    != identity
                || before.len() != after.len()
                || before.mtime() != after.mtime()
                || before.mtime_nsec() != after.mtime_nsec()
                || before.ctime() != after.ctime()
                || before.ctime_nsec() != after.ctime_nsec()
            {
                return Err(SessionHistoryDigestError::Read(AgentError::Checkpoint(
                    "retained home history changed during verification".into(),
                )));
            }
            Ok(digest)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = max_bytes;
            Err(SessionHistoryDigestError::Read(AgentError::Checkpoint(
                "retained home verification requires descriptor identity".into(),
            )))
        }
    }

    pub(crate) fn encoded_len(&self) -> Result<u64, AgentError> {
        self.file
            .metadata()
            .map(|metadata| metadata.len())
            .map_err(|error| read_history_error(&self.path, error))
    }
}

/// Resolve one canonical framework source and return its already-open regular file.
pub(crate) fn resolve_session_history_from_source(
    source: &SessionHistorySourceRef,
) -> Result<ResolvedSessionHistory, AgentError> {
    match source {
        SessionHistorySourceRef::ClaudeCode {
            config_dir,
            working_dir,
            session_id,
        } => {
            if !is_valid_cli_agent_session_id(session_id) {
                return Err(AgentError::Checkpoint(
                    "Invalid Claude session history source".to_string(),
                ));
            }
            let config_dir = validated_absolute_source_path(config_dir)?;
            let working_dir = validated_absolute_source_path(working_dir)?;
            let project_name = working_dir
                .strip_prefix("/")
                .map_err(|_| {
                    AgentError::Checkpoint(
                        "Invalid Claude session history working directory".to_string(),
                    )
                })?
                .to_string_lossy()
                .replace('/', "-");
            let project_dir = format!("-{project_name}");
            let leaf = format!("{session_id}.jsonl");
            open_exact_session_history(&config_dir, &["projects", &project_dir], OsStr::new(&leaf))
        }
        SessionHistorySourceRef::Codex {
            sessions_dir,
            thread_id,
        } => {
            let sessions_dir = validated_absolute_source_path(sessions_dir)?;
            let Some(session) = resolve_codex_session_history(&sessions_dir, thread_id)? else {
                return Err(codex_session_not_found_error(&sessions_dir));
            };
            #[cfg(target_os = "linux")]
            {
                Ok(session.into_resolved())
            }
            #[cfg(not(target_os = "linux"))]
            {
                let _ = session;
                Err(AgentError::Checkpoint(
                    "Safe session history resolution is unsupported on this platform".to_string(),
                ))
            }
        }
        SessionHistorySourceRef::Pi {
            session_path,
            session_id,
        } => {
            if !crate::session_metadata::is_pi_session_history_path(session_path, session_id) {
                return Err(AgentError::Checkpoint(
                    "Invalid Pi session history source".to_string(),
                ));
            }
            let path = Path::new(session_path);
            let parent = path.parent().ok_or_else(|| {
                AgentError::Checkpoint("Invalid Pi session history source".to_string())
            })?;
            let leaf = path.file_name().ok_or_else(|| {
                AgentError::Checkpoint("Invalid Pi session history source".to_string())
            })?;
            open_exact_session_history(parent, &[], leaf)
        }
    }
}

pub(crate) fn digest_session_history_from_source_bounded(
    source: &SessionHistorySourceRef,
    max_bytes: u64,
) -> Result<SessionHistoryDigest, SessionHistoryDigestError> {
    resolve_session_history_from_source(source)?
        .into_decoded_reader()?
        .digest(max_bytes)
}

fn validated_absolute_source_path(value: &str) -> Result<PathBuf, AgentError> {
    let path = Path::new(value);
    if !path.is_absolute()
        || path.components().any(|component| {
            !matches!(
                component,
                std::path::Component::RootDir | std::path::Component::Normal(_)
            )
        })
    {
        return Err(AgentError::Checkpoint(
            "Session history source path is not canonical absolute path".to_string(),
        ));
    }
    Ok(path.to_path_buf())
}

#[cfg(target_os = "linux")]
fn open_exact_session_history(
    root: &Path,
    directories: &[&str],
    leaf_name: &OsStr,
) -> Result<ResolvedSessionHistory, AgentError> {
    let mut parent = Dir::open_absolute(root).map_err(|error| read_history_error(root, error))?;
    let mut path = root.to_path_buf();
    for directory in directories {
        path.push(directory);
        parent = parent
            .open_child_dir(OsStr::new(directory))
            .map_err(|error| read_history_error(&path, error))?;
    }
    path.push(leaf_name);
    let file = parent
        .open_child_file(leaf_name)
        .map_err(|error| read_history_error(&path, error))?;
    let metadata = file
        .metadata()
        .map_err(|error| read_history_error(&path, error))?;
    if !metadata.file_type().is_file() {
        return Err(AgentError::Checkpoint(format!(
            "Session history source is not a regular file: {}",
            path.display()
        )));
    }
    Ok(ResolvedSessionHistory {
        replacement_target: SafeHistoryReplacementTarget {
            parent,
            parent_path: path.parent().unwrap_or(root).to_path_buf(),
            leaf_name: leaf_name.to_os_string(),
        },
        path,
        file,
        is_zstd: false,
    })
}

#[cfg(not(target_os = "linux"))]
fn open_exact_session_history(
    root: &Path,
    _directories: &[&str],
    _leaf_name: &OsStr,
) -> Result<ResolvedSessionHistory, AgentError> {
    Err(AgentError::Checkpoint(format!(
        "Safe session history resolution is unsupported on this platform: {}",
        root.display()
    )))
}

#[derive(Debug)]
pub(crate) enum SessionHistoryDigestError {
    Read(AgentError),
    ExceedsMaxBytes,
}

impl From<AgentError> for SessionHistoryDigestError {
    fn from(error: AgentError) -> Self {
        Self::Read(error)
    }
}

fn read_open_codex_checkpoint_source_bounded(
    path: PathBuf,
    mut file: File,
    is_zstd: bool,
    max_bytes: u64,
) -> Result<SessionHistoryCheckpointSource, AgentError> {
    file.rewind()
        .map_err(|error| read_history_error(&path, error))?;
    let source_len = file
        .metadata()
        .map_err(|error| read_history_error(&path, error))?
        .len();
    if is_zstd {
        if source_len <= max_bytes {
            let encoded = read_zstd_encoded_session_history(file, &path, max_bytes)?;
            return Ok(SessionHistoryCheckpointSource::CodexZstd { encoded });
        }
    } else if source_len > max_bytes {
        return Err(session_history_exceeds_max_error(max_bytes));
    }

    DecodedSessionHistoryReader::open(path, file)?
        .read(Some(max_bytes))
        .map(SessionHistoryCheckpointSource::Decoded)
}

fn resolve_codex_session_history(
    sessions_dir: &Path,
    thread_id: &str,
) -> Result<Option<ResolvedCodexSession>, AgentError> {
    let Some(id_norm) = codex_thread_id_filename_key(thread_id) else {
        return Ok(None);
    };
    if !codex_sessions_parent_is_usable(sessions_dir)? {
        return Ok(None);
    }
    resolve_codex_session_history_impl(sessions_dir, &id_norm)
}

fn codex_sessions_parent_is_usable(sessions_dir: &Path) -> Result<bool, AgentError> {
    let Some(parent) = sessions_dir.parent() else {
        return Ok(true);
    };
    if parent.as_os_str().is_empty() {
        return Ok(true);
    }
    match std::fs::symlink_metadata(parent) {
        Ok(metadata) => Ok(metadata.file_type().is_dir()),
        Err(err) if should_skip_unusable_codex_entry(&err) => Ok(false),
        Err(err) => Err(read_history_error(parent, err)),
    }
}

fn resolve_codex_session_history_impl(
    sessions_dir: &Path,
    id_norm: &str,
) -> Result<Option<ResolvedCodexSession>, AgentError> {
    let Some(root) = CodexSessionDir::open_root(sessions_dir)? else {
        return Ok(None);
    };
    let mut found = None;
    let mut budget = CodexSessionLookupBudget::new();
    scan_codex_session_dirs(
        &root,
        root.path(),
        CodexSessionDateLevel::Year,
        id_norm,
        &mut found,
        &mut budget,
    )?;
    Ok(found)
}

fn codex_session_not_found_error(sessions_dir: &Path) -> AgentError {
    AgentError::Checkpoint(format!(
        "Codex session file not found under {}",
        sessions_dir.display()
    ))
}

fn scan_codex_session_dirs(
    dir: &CodexSessionDir,
    root_path: &Path,
    level: CodexSessionDateLevel,
    id_norm: &str,
    found: &mut Option<ResolvedCodexSession>,
    budget: &mut CodexSessionLookupBudget,
) -> Result<(), AgentError> {
    let entries = match dir.read_dir() {
        Ok(entries) => entries,
        Err(err) if should_skip_unusable_codex_entry(&err) => return Ok(()),
        Err(err) => return Err(read_history_error(dir.path(), err)),
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) if should_skip_unusable_codex_entry(&err) => continue,
            Err(err) => return Err(read_history_error(dir.path(), err)),
        };
        budget.inspect_entry()?;

        let name = entry.file_name();
        let path = dir.child_path(&name);
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(err) if should_skip_unusable_codex_entry(&err) => continue,
            Err(err) => return Err(read_history_error(&path, err)),
        };
        if file_type.is_dir() && level.matches(&name) {
            let child = match dir.open_child_dir(&name) {
                Ok(child) => child,
                Err(err) if should_skip_unusable_codex_entry(&err) => continue,
                Err(err) => return Err(read_history_error(&path, err)),
            };
            match level.next() {
                Some(next_level) => {
                    scan_codex_session_dirs(&child, root_path, next_level, id_norm, found, budget)?;
                }
                None => scan_codex_session_leaf_files(&child, root_path, id_norm, found, budget)?,
            }
        }
    }

    Ok(())
}

fn scan_codex_session_leaf_files(
    dir: &CodexSessionDir,
    root_path: &Path,
    id_norm: &str,
    found: &mut Option<ResolvedCodexSession>,
    budget: &mut CodexSessionLookupBudget,
) -> Result<(), AgentError> {
    let entries = match dir.read_dir() {
        Ok(entries) => entries,
        Err(err) if should_skip_unusable_codex_entry(&err) => return Ok(()),
        Err(err) => return Err(read_history_error(dir.path(), err)),
    };

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) if should_skip_unusable_codex_entry(&err) => continue,
            Err(err) => return Err(read_history_error(dir.path(), err)),
        };
        budget.inspect_entry()?;

        let name = entry.file_name();
        let path = dir.child_path(&name);
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(err) if should_skip_unusable_codex_entry(&err) => continue,
            Err(err) => return Err(read_history_error(&path, err)),
        };
        if file_type.is_file() && codex_session_filename_matches(&name, id_norm) {
            let Some(session) = dir.resolve_leaf_file(&name, path)? else {
                continue;
            };
            if found.is_some() {
                return Err(duplicate_codex_session_error(root_path));
            }
            *found = Some(session);
        }
    }

    Ok(())
}

struct CodexSessionDir {
    path: PathBuf,
    #[cfg(target_os = "linux")]
    dir: Dir,
}

impl CodexSessionDir {
    fn open_root(path: &Path) -> Result<Option<Self>, AgentError> {
        Self::open_root_impl(path)
    }

    #[cfg(target_os = "linux")]
    fn open_root_impl(path: &Path) -> Result<Option<Self>, AgentError> {
        match Dir::open_absolute(path) {
            Ok(dir) => Ok(Some(Self {
                path: path.to_path_buf(),
                dir,
            })),
            Err(err) if should_skip_unusable_codex_entry(&err) => Ok(None),
            Err(err) => Err(read_history_error(path, err)),
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn open_root_impl(path: &Path) -> Result<Option<Self>, AgentError> {
        Err(AgentError::Checkpoint(format!(
            "Safe session history resolution is unsupported on this platform: {}",
            path.display()
        )))
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn child_path(&self, name: &OsStr) -> PathBuf {
        self.path.join(Path::new(name))
    }

    #[cfg(target_os = "linux")]
    fn read_dir(&self) -> io::Result<std::fs::ReadDir> {
        self.dir.read_dir()
    }

    #[cfg(not(target_os = "linux"))]
    fn read_dir(&self) -> io::Result<std::fs::ReadDir> {
        std::fs::read_dir(&self.path)
    }

    #[cfg(target_os = "linux")]
    fn open_child_dir(&self, name: &OsStr) -> io::Result<Self> {
        let dir = self.dir.open_child_dir(name)?;
        Ok(Self {
            path: self.child_path(name),
            dir,
        })
    }

    #[cfg(not(target_os = "linux"))]
    fn open_child_dir(&self, name: &OsStr) -> io::Result<Self> {
        Ok(Self {
            path: self.child_path(name),
        })
    }

    #[cfg(target_os = "linux")]
    fn resolve_leaf_file(
        &self,
        name: &OsStr,
        path: PathBuf,
    ) -> Result<Option<ResolvedCodexSession>, AgentError> {
        let file = match self.dir.open_child_file(name) {
            Ok(file) => file,
            Err(err) if should_skip_unusable_codex_entry(&err) => return Ok(None),
            Err(err) => return Err(read_history_error(&path, err)),
        };
        let metadata = file
            .metadata()
            .map_err(|err| read_history_error(&path, err))?;
        if !metadata.file_type().is_file() {
            return Ok(None);
        }
        let parent = self
            .dir
            .try_clone()
            .map_err(|err| read_history_error(&path, err))?;
        Ok(Some(ResolvedCodexSession {
            path,
            file,
            parent,
            leaf_name: name.to_os_string(),
        }))
    }

    #[cfg(not(target_os = "linux"))]
    fn resolve_leaf_file(
        &self,
        _name: &OsStr,
        path: PathBuf,
    ) -> Result<Option<ResolvedCodexSession>, AgentError> {
        Ok(Some(ResolvedCodexSession { path }))
    }
}

#[derive(Clone, Copy)]
enum CodexSessionDateLevel {
    Year,
    Month,
    Day,
}

impl CodexSessionDateLevel {
    fn matches(self, name: &OsStr) -> bool {
        match self {
            Self::Year => is_codex_session_year_dir_name(name),
            Self::Month => is_codex_session_month_dir_name(name),
            Self::Day => is_codex_session_day_dir_name(name),
        }
    }

    fn next(self) -> Option<Self> {
        match self {
            Self::Year => Some(Self::Month),
            Self::Month => Some(Self::Day),
            Self::Day => None,
        }
    }
}

struct ResolvedCodexSession {
    path: PathBuf,
    #[cfg(target_os = "linux")]
    file: File,
    #[cfg(target_os = "linux")]
    parent: Dir,
    #[cfg(target_os = "linux")]
    leaf_name: OsString,
}

impl ResolvedCodexSession {
    fn is_zstd(&self) -> bool {
        is_zstd_session_history(&self.path)
    }

    #[cfg(target_os = "linux")]
    fn into_resolved(self) -> ResolvedSessionHistory {
        let is_zstd = self.is_zstd();
        let Self {
            path,
            file,
            parent,
            leaf_name,
        } = self;
        ResolvedSessionHistory {
            replacement_target: SafeHistoryReplacementTarget {
                parent,
                parent_path: path
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| path.clone()),
                leaf_name,
            },
            path,
            file,
            is_zstd,
        }
    }
}

fn read_zstd_encoded_session_history(
    file: File,
    path: &Path,
    max_encoded_bytes: u64,
) -> Result<Vec<u8>, AgentError> {
    let mut bytes = Vec::new();
    file.take(max_encoded_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| read_history_error(path, error))?;
    if bytes.len() as u64 > max_encoded_bytes {
        return Err(session_history_exceeds_max_error(max_encoded_bytes));
    }
    Ok(bytes)
}

struct CodexSessionLookupBudget {
    inspected_entries: usize,
}

impl CodexSessionLookupBudget {
    fn new() -> Self {
        Self {
            inspected_entries: 0,
        }
    }

    fn inspect_entry(&mut self) -> Result<(), AgentError> {
        self.inspected_entries += 1;
        if self.inspected_entries > CODEX_SESSION_LOOKUP_SCAN_BUDGET {
            return Err(AgentError::Checkpoint(
                CODEX_SESSION_LOOKUP_SCAN_BUDGET_ERROR.to_string(),
            ));
        }
        Ok(())
    }
}

fn duplicate_codex_session_error(root: &Path) -> AgentError {
    AgentError::Checkpoint(format!(
        "Multiple Codex session files found under {}",
        root.display()
    ))
}

fn codex_session_filename_matches(name: &OsStr, id_norm: &str) -> bool {
    let name = name.to_string_lossy();
    if !(name.ends_with(".jsonl") || name.ends_with(".jsonl.zst")) {
        return false;
    }

    let name_norm = name.replace('-', "").to_ascii_lowercase();
    name_norm.contains(id_norm)
}

fn is_codex_session_year_dir_name(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    name.len() == 4 && name.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_codex_session_month_dir_name(name: &OsStr) -> bool {
    is_numeric_codex_session_date_component(name, 2, 1, 12)
}

fn is_codex_session_day_dir_name(name: &OsStr) -> bool {
    is_numeric_codex_session_date_component(name, 2, 1, 31)
}

fn is_numeric_codex_session_date_component(name: &OsStr, len: usize, min: u8, max: u8) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    if name.len() != len || !name.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let Ok(value) = name.parse::<u8>() else {
        return false;
    };
    (min..=max).contains(&value)
}

fn should_skip_unusable_codex_entry(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    ) || is_filesystem_loop_error(err)
}

#[cfg(target_os = "linux")]
fn is_filesystem_loop_error(err: &io::Error) -> bool {
    err.raw_os_error() == Some(libc::ELOOP)
}

#[cfg(not(target_os = "linux"))]
fn is_filesystem_loop_error(_: &io::Error) -> bool {
    false
}

fn read_history_error(_path: &Path, source: io::Error) -> AgentError {
    AgentError::Checkpoint(format!("Failed to read session history: {source}"))
}

enum DecodedSessionHistoryReader {
    Plain { path: PathBuf, reader: File },
    Zstd(zstd::stream::read::Decoder<'static, BufReader<File>>),
}

impl DecodedSessionHistoryReader {
    fn open(path: PathBuf, file: File) -> Result<Self, AgentError> {
        if is_zstd_session_history(&path) {
            let decoder =
                zstd::stream::read::Decoder::new(file).map_err(zstd_session_history_error)?;
            return Ok(Self::Zstd(decoder));
        }

        Ok(Self::Plain { path, reader: file })
    }

    fn read(self, max_bytes: Option<u64>) -> Result<Vec<u8>, AgentError> {
        match self {
            Self::Plain { path, reader } => {
                read_history_reader(reader, max_bytes, |e| read_history_error(&path, e))
            }
            Self::Zstd(reader) => {
                read_history_reader(reader, max_bytes, zstd_session_history_error)
            }
        }
    }

    fn digest(self, max_bytes: u64) -> Result<SessionHistoryDigest, SessionHistoryDigestError> {
        match self {
            Self::Plain { path, reader } => {
                digest_history_reader(reader, max_bytes, |e| read_history_error(&path, e))
            }
            Self::Zstd(reader) => {
                digest_history_reader(reader, max_bytes, zstd_session_history_error)
            }
        }
    }
}

fn zstd_session_history_error(source: io::Error) -> AgentError {
    AgentError::Checkpoint(format!(
        "Failed to decompress zstd session history: {source}"
    ))
}

fn is_zstd_session_history(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zst"))
}

fn read_history_reader(
    mut reader: impl Read,
    max_bytes: Option<u64>,
    map_error: impl Fn(io::Error) -> AgentError,
) -> Result<Vec<u8>, AgentError> {
    let mut bytes = Vec::new();
    match decoded_read_limit(max_bytes) {
        Some(limit) => reader.by_ref().take(limit).read_to_end(&mut bytes),
        None => reader.read_to_end(&mut bytes),
    }
    .map_err(map_error)?;
    if let Some(max_bytes) = max_bytes
        && bytes.len() as u64 > max_bytes
    {
        return Err(session_history_exceeds_max_error(max_bytes));
    }
    Ok(bytes)
}

fn decoded_read_limit(max_bytes: Option<u64>) -> Option<u64> {
    // `u64::MAX` cannot be exceeded by an in-memory Vec on supported targets,
    // so there is no extra probe byte to read for that cap.
    max_bytes.and_then(|max_bytes| max_bytes.checked_add(1))
}

fn digest_history_reader(
    mut reader: impl Read,
    max_bytes: u64,
    map_error: impl Fn(io::Error) -> AgentError,
) -> Result<SessionHistoryDigest, SessionHistoryDigestError> {
    let mut hasher = Sha256::new();
    let mut size_bytes = 0u64;
    let mut buffer = [0u8; 8192];

    loop {
        let bytes_read = reader
            .read(&mut buffer)
            .map_err(|error| SessionHistoryDigestError::Read(map_error(error)))?;
        if bytes_read == 0 {
            break;
        }
        size_bytes = size_bytes
            .checked_add(bytes_read as u64)
            .ok_or(SessionHistoryDigestError::ExceedsMaxBytes)?;
        if size_bytes > max_bytes {
            return Err(SessionHistoryDigestError::ExceedsMaxBytes);
        }
        let chunk = buffer.get(..bytes_read).ok_or_else(|| {
            SessionHistoryDigestError::Read(map_error(io::Error::other(
                "session history reader returned more bytes than the provided buffer",
            )))
        })?;
        hasher.update(chunk);
    }

    Ok(SessionHistoryDigest {
        size_bytes,
        sha256_hex: hex::encode(hasher.finalize()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_CLAUDE_SESSION_ID: &str = "session-history-source-test";

    fn claude_source(config_dir: &Path) -> SessionHistorySourceRef {
        SessionHistorySourceRef::ClaudeCode {
            config_dir: config_dir.to_string_lossy().into_owned(),
            working_dir: crate::paths::CANONICAL_WORKING_DIR.to_string(),
            session_id: TEST_CLAUDE_SESSION_ID.to_string(),
        }
    }

    fn claude_history_path(config_dir: &Path) -> PathBuf {
        config_dir
            .join("projects/-home-user-workspace")
            .join(format!("{TEST_CLAUDE_SESSION_ID}.jsonl"))
    }

    fn codex_source(sessions_dir: &Path, thread_id: &str) -> SessionHistorySourceRef {
        SessionHistorySourceRef::Codex {
            sessions_dir: sessions_dir.to_string_lossy().into_owned(),
            thread_id: thread_id.to_string(),
        }
    }

    fn resolve_test_payload(payload: &str) -> Result<ResolvedSessionHistory, AgentError> {
        let path = Path::new(payload);
        let parent_path = path.parent().ok_or_else(|| {
            AgentError::Checkpoint("test session history has no parent".to_string())
        })?;
        let leaf_name = path.file_name().ok_or_else(|| {
            AgentError::Checkpoint("test session history has no file name".to_string())
        })?;
        #[cfg(target_os = "linux")]
        {
            let parent = Dir::open_absolute(parent_path)
                .map_err(|error| read_history_error(parent_path, error))?;
            let file = parent
                .open_child_file(leaf_name)
                .map_err(|error| read_history_error(path, error))?;
            let is_zstd = is_zstd_session_history(path);
            Ok(ResolvedSessionHistory {
                replacement_target: SafeHistoryReplacementTarget {
                    parent,
                    parent_path: parent_path.to_path_buf(),
                    leaf_name: leaf_name.to_os_string(),
                },
                path: path.to_path_buf(),
                file,
                is_zstd,
            })
        }
        #[cfg(not(target_os = "linux"))]
        Err(AgentError::Checkpoint(
            "Safe session history resolution is unsupported on this platform".to_string(),
        ))
    }

    fn read_session_history_from_payload_bounded(
        payload: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>, AgentError> {
        match resolve_test_payload(payload)?.into_checkpoint_source_bounded(max_bytes)? {
            SessionHistoryCheckpointSource::Decoded(bytes) => Ok(bytes),
            SessionHistoryCheckpointSource::CodexZstd { encoded } => {
                let decoder = zstd::stream::read::Decoder::new(encoded.as_slice())
                    .map_err(zstd_session_history_error)?;
                read_history_reader(decoder, Some(max_bytes), zstd_session_history_error)
            }
        }
    }

    fn read_session_history_from_source_for_test_bounded(
        source: &SessionHistorySourceRef,
        max_bytes: u64,
    ) -> Result<Vec<u8>, AgentError> {
        match resolve_session_history_from_source(source)?
            .into_checkpoint_source_bounded(max_bytes)?
        {
            SessionHistoryCheckpointSource::Decoded(bytes) => Ok(bytes),
            SessionHistoryCheckpointSource::CodexZstd { encoded } => {
                let decoder = zstd::stream::read::Decoder::new(encoded.as_slice())
                    .map_err(zstd_session_history_error)?;
                read_history_reader(decoder, Some(max_bytes), zstd_session_history_error)
            }
        }
    }

    fn write_history_file(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn assert_over_limit(error: AgentError, max_bytes: u64) {
        match error {
            AgentError::CheckpointHistoryTooLarge {
                max_bytes: actual_max_bytes,
            } => assert_eq!(actual_max_bytes, max_bytes),
            other => panic!("expected typed over-limit error, got: {other}"),
        }
    }

    #[test]
    fn resolves_claude_history_from_custom_config_root() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("custom-claude");
        let history_path = claude_history_path(&config_dir);
        std::fs::create_dir_all(history_path.parent().unwrap()).unwrap();
        std::fs::write(&history_path, b"custom history").unwrap();

        let source = resolve_session_history_from_source(&claude_source(&config_dir)).unwrap();
        let bytes = match source.into_checkpoint_source_bounded(32).unwrap() {
            SessionHistoryCheckpointSource::Decoded(bytes) => bytes,
            SessionHistoryCheckpointSource::CodexZstd { .. } => {
                panic!("Claude history must use decoded bytes")
            }
        };

        assert_eq!(bytes, b"custom history");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_claude_history_through_intermediate_symlink() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("claude-config");
        let outside_projects = dir.path().join("outside-projects");
        let outside_history = outside_projects
            .join("-home-user-workspace")
            .join(format!("{TEST_CLAUDE_SESSION_ID}.jsonl"));
        std::fs::create_dir_all(outside_history.parent().unwrap()).unwrap();
        std::fs::write(&outside_history, b"parent-only sentinel").unwrap();
        std::fs::create_dir(&config_dir).unwrap();
        symlink(&outside_projects, config_dir.join("projects")).unwrap();

        let error = resolve_session_history_from_source(&claude_source(&config_dir))
            .err()
            .expect("intermediate symlink must be rejected");

        assert!(error.to_string().contains("Failed to read session history"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_claude_history_final_symlink() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("claude-config");
        let history_path = claude_history_path(&config_dir);
        let outside_history = dir.path().join("outside-history.jsonl");
        std::fs::create_dir_all(history_path.parent().unwrap()).unwrap();
        std::fs::write(&outside_history, b"parent-only sentinel").unwrap();
        symlink(&outside_history, &history_path).unwrap();

        let error = resolve_session_history_from_source(&claude_source(&config_dir))
            .err()
            .expect("final symlink must be rejected");

        assert!(error.to_string().contains("Failed to read session history"));
    }

    #[test]
    fn rejects_missing_and_duplicate_codex_matches() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_dir = dir.path().join("sessions");
        let thread_id = "019e9154-c304-70f0-adde-36efb1be1701";
        std::fs::create_dir_all(&sessions_dir).unwrap();
        let source = codex_source(&sessions_dir, thread_id);

        let missing = resolve_session_history_from_source(&source)
            .err()
            .expect("missing Codex source must be unavailable");
        assert!(missing.to_string().contains("not found"));

        for day in ["02", "03"] {
            let day_dir = sessions_dir.join("2026/07").join(day);
            std::fs::create_dir_all(&day_dir).unwrap();
            std::fs::write(
                day_dir.join("rollout-019e9154c30470f0adde36efb1be1701.jsonl"),
                b"history",
            )
            .unwrap();
        }

        let duplicate = resolve_session_history_from_source(&source)
            .err()
            .expect("duplicate Codex source must be unavailable");
        assert!(
            duplicate
                .to_string()
                .contains("Multiple Codex session files")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_proc_magic_link_source() {
        let source = SessionHistorySourceRef::ClaudeCode {
            config_dir: "/proc/self".to_string(),
            working_dir: crate::paths::CANONICAL_WORKING_DIR.to_string(),
            session_id: TEST_CLAUDE_SESSION_ID.to_string(),
        };

        assert!(resolve_session_history_from_source(&source).is_err());
    }

    #[test]
    fn bounded_read_allows_literal_history_at_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_history_file(&dir, "history.jsonl", b"abcd");

        let bytes = read_session_history_from_payload_bounded(path.to_str().unwrap(), 4).unwrap();

        assert_eq!(bytes, b"abcd");
    }

    #[test]
    fn bounded_read_allows_empty_literal_history_with_zero_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_history_file(&dir, "history.jsonl", b"");

        let bytes = read_session_history_from_payload_bounded(path.to_str().unwrap(), 0).unwrap();

        assert_eq!(bytes, b"");
    }

    #[test]
    fn bounded_read_rejects_nonempty_literal_history_with_zero_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_history_file(&dir, "history.jsonl", b"a");

        let err = read_session_history_from_payload_bounded(path.to_str().unwrap(), 0)
            .expect_err("bounded literal read must reject nonempty history when cap is zero");

        assert_over_limit(err, 0);
    }

    #[test]
    fn bounded_read_rejects_nonempty_zstd_history_with_zero_limit() {
        let dir = tempfile::tempdir().unwrap();
        let compressed = zstd::encode_all(b"a".as_slice(), 0).unwrap();
        let path = write_history_file(&dir, "history.jsonl.zst", &compressed);

        let err = read_session_history_from_payload_bounded(path.to_str().unwrap(), 0)
            .expect_err("bounded zstd read must reject nonempty history when cap is zero");

        assert_over_limit(err, 0);
    }

    #[test]
    fn bounded_read_rejects_literal_history_over_limit_before_reading() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_history_file(&dir, "history.jsonl", b"abcde");
        let resolved = resolve_test_payload(path.to_str().unwrap()).unwrap();
        let mut observed_file = resolved.file.try_clone().unwrap();

        let err = resolved
            .into_checkpoint_source_bounded(4)
            .err()
            .expect("bounded literal read must reject over-limit history");

        assert_over_limit(err, 4);
        assert_eq!(observed_file.stream_position().unwrap(), 0);
    }

    #[test]
    fn bounded_read_rejects_codex_history_over_limit() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_dir = dir.path().join("sessions");
        let day_dir = sessions_dir.join("2026").join("07").join("02");
        std::fs::create_dir_all(&day_dir).unwrap();
        let thread_id = "019e9154-c304-70f0-adde-36efb1be1701";
        let path = day_dir.join("rollout-019e9154c30470f0adde36efb1be1701.jsonl");
        std::fs::write(path, b"abcde").unwrap();
        let source = codex_source(&sessions_dir, thread_id);

        let err = read_session_history_from_source_for_test_bounded(&source, 4)
            .expect_err("bounded Codex read must reject over-limit history");

        assert_over_limit(err, 4);
    }

    #[test]
    fn codex_zstd_read_and_digest_are_consistent() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_dir = dir.path().join("sessions");
        let day_dir = sessions_dir.join("2026").join("07").join("02");
        std::fs::create_dir_all(&day_dir).unwrap();
        let thread_id = "019e9154-c304-70f0-adde-36efb1be1701";
        let history = br#"{"type":"session_meta","timestamp":"2026-07-02T10:00:00Z"}"#;
        let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
        let path = day_dir.join("rollout-019e9154c30470f0adde36efb1be1701.jsonl.zst");
        std::fs::write(path, &compressed).unwrap();
        let source = codex_source(&sessions_dir, thread_id);

        let bytes =
            read_session_history_from_source_for_test_bounded(&source, history.len() as u64)
                .unwrap();
        let digest =
            digest_session_history_from_source_bounded(&source, history.len() as u64).unwrap();

        assert_eq!(bytes, history);
        assert_eq!(digest.size_bytes, history.len() as u64);
        assert_eq!(digest.sha256_hex, hex::encode(Sha256::digest(history)));
    }

    #[test]
    fn codex_zstd_checkpoint_source_falls_back_to_decoded_when_encoded_exceeds_cap() {
        let dir = tempfile::tempdir().unwrap();
        let sessions_dir = dir.path().join("sessions");
        let day_dir = sessions_dir.join("2026").join("07").join("02");
        std::fs::create_dir_all(&day_dir).unwrap();
        let thread_id = "019e9154-c304-70f0-adde-36efb1be1701";
        let history = b"a";
        let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
        assert!(
            compressed.len() > history.len(),
            "fixture must be larger when encoded"
        );
        let path = day_dir.join("rollout-019e9154c30470f0adde36efb1be1701.jsonl.zst");
        std::fs::write(path, compressed).unwrap();
        let source = codex_source(&sessions_dir, thread_id);

        let source = resolve_session_history_from_source(&source)
            .unwrap()
            .into_checkpoint_source_bounded(history.len() as u64)
            .unwrap();

        match source {
            SessionHistoryCheckpointSource::Decoded(bytes) => assert_eq!(bytes, history),
            SessionHistoryCheckpointSource::CodexZstd { .. } => {
                panic!("oversized encoded body should fall back to decoded history")
            }
        }
    }

    #[test]
    fn bounded_read_allows_literal_history_with_u64_max_limit() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_history_file(&dir, "history.jsonl", b"abcde");

        let bytes =
            read_session_history_from_payload_bounded(path.to_str().unwrap(), u64::MAX).unwrap();

        assert_eq!(bytes, b"abcde");
    }

    #[test]
    fn bounded_read_allows_zstd_history_at_decoded_limit() {
        let dir = tempfile::tempdir().unwrap();
        let max_bytes = 1024;
        let history = vec![b'a'; max_bytes as usize];
        let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
        let path = write_history_file(&dir, "history.jsonl.zst", &compressed);

        let bytes = read_session_history_from_payload_bounded(path.to_str().unwrap(), max_bytes)
            .expect("bounded zstd read must allow history exactly at the decoded cap");

        assert_eq!(bytes, history);
    }

    #[test]
    fn bounded_read_rejects_truncated_zstd_history_at_decoded_limit() {
        let dir = tempfile::tempdir().unwrap();
        let max_bytes = 1024;
        let history = vec![b'a'; max_bytes as usize];
        let mut compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
        compressed.pop().expect("encoded fixture must not be empty");
        let path = write_history_file(&dir, "history.jsonl.zst", &compressed);

        let err = read_session_history_from_payload_bounded(path.to_str().unwrap(), max_bytes)
            .expect_err("bounded zstd read must reject truncated history at the decoded cap");

        let message = err.to_string();
        assert!(
            message.contains("Failed to decompress zstd session history"),
            "expected decompression error for truncated zstd history, got: {message}"
        );
    }

    #[test]
    fn bounded_read_rejects_zstd_history_over_decoded_limit() {
        let dir = tempfile::tempdir().unwrap();
        let max_bytes = 1024;
        let history = vec![b'a'; max_bytes as usize + 1];
        let compressed = zstd::encode_all(history.as_slice(), 0).unwrap();
        assert!(
            compressed.len() <= max_bytes as usize,
            "test fixture should be smaller than the decoded cap"
        );
        let path = write_history_file(&dir, "history.jsonl.zst", &compressed);

        let err = read_session_history_from_payload_bounded(path.to_str().unwrap(), max_bytes)
            .expect_err("bounded zstd read must reject over-limit decoded history");

        assert_over_limit(err, max_bytes);
    }
}
