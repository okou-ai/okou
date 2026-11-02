//! Guest-owned session metadata captured from CLI events.

use crate::env::{Framework, GuestConfig};
use crate::paths;
use guest_contracts::cli_agent_session_id::is_valid_cli_agent_session_id;
use guest_contracts::codex_thread_id::canonical_codex_thread_id;
use guest_contracts::session_history_identity::SessionHistorySourceRef;
use guest_telemetry::{log_info, log_warn};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};

const LOG_TAG: &str = "sandbox:guest-agent";

/// Finalized framework launch facts that do not depend on a CLI session ID.
#[derive(Clone, Debug)]
pub(crate) enum SessionHistoryLaunchSource {
    ClaudeCode {
        config_dir: Option<String>,
        working_dir: String,
    },
    Codex {
        sessions_dir: Option<String>,
    },
    Pi,
}

impl SessionHistoryLaunchSource {
    /// Derive the source from the same owned config values used to build the
    /// finalized CLI child environment and explicit working directory.
    pub(crate) fn for_config(config: &GuestConfig) -> Self {
        match config.framework {
            Framework::ClaudeCode => Self::ClaudeCode {
                config_dir: normalized_absolute_launch_path(
                    &config.claude_config_dir,
                    paths::CANONICAL_WORKING_DIR,
                ),
                working_dir: paths::CANONICAL_WORKING_DIR.to_string(),
            },
            Framework::Codex => Self::Codex {
                sessions_dir: normalized_absolute_launch_path(
                    &Path::new(&config.codex_home_dir)
                        .join("sessions")
                        .to_string_lossy(),
                    paths::CANONICAL_WORKING_DIR,
                ),
            },
            Framework::Pi => Self::Pi,
        }
    }

    pub(crate) const fn framework(&self) -> Framework {
        match self {
            Self::ClaudeCode { .. } => Framework::ClaudeCode,
            Self::Codex { .. } => Framework::Codex,
            Self::Pi => Framework::Pi,
        }
    }

    fn capture(
        &self,
        raw_session_id: &str,
        pi_session_path: Option<&str>,
    ) -> Option<CapturedSessionMetadata> {
        let (cli_agent_session_id, history_source) = match self {
            Self::ClaudeCode {
                config_dir,
                working_dir,
            } => {
                if !is_valid_cli_agent_session_id(raw_session_id) {
                    return None;
                }
                let source =
                    config_dir
                        .as_ref()
                        .map(|config_dir| SessionHistorySourceRef::ClaudeCode {
                            config_dir: config_dir.clone(),
                            working_dir: working_dir.clone(),
                            session_id: raw_session_id.to_string(),
                        });
                (raw_session_id.to_string(), source)
            }
            Self::Codex { sessions_dir } => {
                let thread_id = canonical_codex_thread_id(raw_session_id)?;
                let source =
                    sessions_dir
                        .as_ref()
                        .map(|sessions_dir| SessionHistorySourceRef::Codex {
                            sessions_dir: sessions_dir.clone(),
                            thread_id: thread_id.clone(),
                        });
                (thread_id, source)
            }
            Self::Pi => {
                if !is_valid_cli_agent_session_id(raw_session_id) {
                    return None;
                }
                let source = pi_session_path.and_then(|session_path| {
                    pi_session_history_source(session_path, raw_session_id)
                });
                (raw_session_id.to_string(), source)
            }
        };
        Some(CapturedSessionMetadata {
            cli_agent_session_id,
            history_source,
        })
    }
}

pub(crate) fn is_pi_session_history_path(session_path: &str, session_id: &str) -> bool {
    if !is_valid_cli_agent_session_id(session_id) {
        return false;
    }
    let path = Path::new(session_path);
    let valid_parent = path.parent()
        == Some(Path::new(
            api_contracts::generated::constants::runners::paths::CANONICAL_PI_SESSION_DIR,
        ));
    let valid_extension =
        path.extension().and_then(|extension| extension.to_str()) == Some("jsonl");
    let valid_stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| {
            stem == session_id
                || stem
                    .strip_suffix(session_id)
                    .is_some_and(|prefix| prefix.ends_with('-') || prefix.ends_with('_'))
        });
    valid_parent && valid_extension && valid_stem
}

fn pi_session_history_source(
    session_path: &str,
    session_id: &str,
) -> Option<SessionHistorySourceRef> {
    if !is_pi_session_history_path(session_path, session_id) {
        return None;
    }
    Some(SessionHistorySourceRef::Pi {
        session_path: session_path.to_string(),
        session_id: session_id.to_string(),
    })
}

/// First valid CLI session identity and its finalized history source.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapturedSessionMetadata {
    cli_agent_session_id: String,
    history_source: Option<SessionHistorySourceRef>,
}

impl CapturedSessionMetadata {
    /// Return the normalized CLI agent session identity.
    pub fn cli_agent_session_id(&self) -> &str {
        &self.cli_agent_session_id
    }

    /// Return the canonical history source when launch and event validation succeeded.
    pub fn history_source(&self) -> Option<&SessionHistorySourceRef> {
        self.history_source.as_ref()
    }

    /// Build captured metadata for integration tests that exercise finalization entry points.
    #[doc(hidden)]
    pub fn for_test(
        cli_agent_session_id: impl Into<String>,
        history_source: Option<SessionHistorySourceRef>,
    ) -> Self {
        Self {
            cli_agent_session_id: cli_agent_session_id.into(),
            history_source,
        }
    }
}

/// Shared first-write-wins metadata store for one guest-agent execution.
#[derive(Clone, Default)]
pub struct SessionMetadataStore(Arc<OnceLock<CapturedSessionMetadata>>);

impl SessionMetadataStore {
    /// Return the captured metadata, if a valid identity event was observed.
    pub fn captured(&self) -> Option<&CapturedSessionMetadata> {
        self.0.get()
    }

    fn capture(&self, metadata: CapturedSessionMetadata) -> bool {
        self.0.set(metadata).is_ok()
    }

    /// Preload metadata for integration tests that call finalization directly.
    #[doc(hidden)]
    pub fn capture_for_test(&self, metadata: CapturedSessionMetadata) -> bool {
        self.capture(metadata)
    }
}

/// Capture first-event-wins metadata and retain it outside workload-writable files.
pub(crate) struct SessionMetadataCapture {
    launch_source: SessionHistoryLaunchSource,
    store: SessionMetadataStore,
    session_id_file: String,
}

impl SessionMetadataCapture {
    pub(crate) fn new(
        launch_source: SessionHistoryLaunchSource,
        store: SessionMetadataStore,
        session_id_file: &str,
    ) -> Self {
        Self {
            launch_source,
            store,
            session_id_file: session_id_file.to_string(),
        }
    }

    pub(crate) fn capture_session_id(&self, raw_session_id: &str) {
        self.capture(raw_session_id, None);
    }

    pub(crate) fn capture_pi_session_id(&self, raw_session_id: &str, session_path: Option<&str>) {
        self.capture(raw_session_id, session_path);
    }

    fn capture(&self, raw_session_id: &str, pi_session_path: Option<&str>) {
        let Some(metadata) = self.launch_source.capture(raw_session_id, pi_session_path) else {
            return;
        };
        if !self.store.capture(metadata.clone()) {
            return;
        }

        log_info!(LOG_TAG, "Captured session ID");
        if metadata.history_source().is_none() {
            log_warn!(
                LOG_TAG,
                "Session history source is unavailable because launch or event metadata is invalid"
            );
        }
        match guest_contracts::runtime_paths::write_private_new(
            &self.session_id_file,
            metadata.cli_agent_session_id(),
        ) {
            Ok(()) => log_info!(LOG_TAG, "Session ID written to {}", self.session_id_file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => log_info!(
                LOG_TAG,
                "Session ID file already exists; keeping its first observed value"
            ),
            Err(error) => log_warn!(
                LOG_TAG,
                "Failed to write non-authoritative session ID to {}: {error}",
                self.session_id_file
            ),
        }
    }
}

fn normalized_absolute_launch_path(value: &str, working_dir: &str) -> Option<String> {
    let path = Path::new(value);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(working_dir).join(path)
    };
    normalize_absolute_path(&absolute).map(|path| path.to_string_lossy().into_owned())
}

fn normalize_absolute_path(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let mut normalized = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::CurDir => {}
            Component::Normal(name) => normalized.push(name),
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            Component::Prefix(_) => return None,
        }
    }
    Some(normalized)
}

#[cfg(test)]
mod tests;
