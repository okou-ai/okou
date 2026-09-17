//! Guest filesystem paths and derived runtime-file paths.
//!
//! [`GuestPaths`] is the owned path model for one guest-agent run. It is built
//! from the runtime directory captured at bootstrap and then passed explicitly
//! through callers. Avoid adding zero-argument facade readers that derive paths
//! from process-global environment state.
//!
//! Naming conventions:
//! - "system log" = guest-agent's own stderr (matches TS `SYSTEM_LOG_FILE` and API `systemLog`)
//! - "agent log" = best-effort local agent-event log with backend-specific JSONL representation
//! - "metrics" = periodic CPU/memory/disk snapshots
//! - "sandbox ops" = operation timing records (defined in guest-telemetry, re-exported here)
//! - runtime-file paths are scoped to the current run ID

pub use api_contracts::generated::constants::runners::paths::{
    CANONICAL_CODEX_HOME_DIR, CANONICAL_GUEST_HOME_DIR, CANONICAL_WORKING_DIR,
};
#[doc(inline)]
pub use guest_contracts::runtime_paths::{ensure_parent_dir, write_private};
use std::path::{Path, PathBuf};

/// Immutable run-scoped guest paths derived from one runtime directory.
#[derive(Clone, Debug)]
pub struct GuestPaths {
    runtime_dir: PathBuf,
    session_id_file: String,
    checkpoint_error_file: String,
    final_session_history_identity_file: String,
    failure_diagnostic_file: String,
    claude_append_system_prompt_file: String,
    pi_launch_payload_file: String,
    pi_deferred_handoff_file: String,
    system_log_file: String,
    agent_log_file: String,
    metrics_log_file: String,
    sandbox_ops_file: String,
    telemetry_system_log_pos_file: String,
    telemetry_metrics_pos_file: String,
    telemetry_sandbox_ops_pos_file: String,
}

impl GuestPaths {
    /// Build all run-scoped paths from an explicit runtime directory.
    pub fn from_runtime_dir(runtime_dir: impl Into<PathBuf>) -> Self {
        let runtime_dir = runtime_dir.into();
        Self {
            session_id_file: path_to_string(guest_contracts::runtime_paths::session_id_file(
                &runtime_dir,
            )),
            checkpoint_error_file: path_to_string(
                guest_contracts::runtime_paths::checkpoint_error_file(&runtime_dir),
            ),
            final_session_history_identity_file: path_to_string(
                guest_contracts::runtime_paths::final_session_history_identity_file(&runtime_dir),
            ),
            failure_diagnostic_file: path_to_string(
                guest_contracts::runtime_paths::failure_diagnostic_file(&runtime_dir),
            ),
            claude_append_system_prompt_file: path_to_string(
                guest_contracts::runtime_paths::claude_append_system_prompt_file(&runtime_dir),
            ),
            pi_launch_payload_file: path_to_string(
                guest_contracts::runtime_paths::pi_launch_payload_file(&runtime_dir),
            ),
            pi_deferred_handoff_file: path_to_string(
                guest_contracts::runtime_paths::pi_deferred_handoff_file(&runtime_dir),
            ),
            system_log_file: path_to_string(guest_contracts::runtime_paths::system_log_file(
                &runtime_dir,
            )),
            agent_log_file: path_to_string(guest_contracts::runtime_paths::agent_log_file(
                &runtime_dir,
            )),
            metrics_log_file: path_to_string(guest_contracts::runtime_paths::metrics_log_file(
                &runtime_dir,
            )),
            sandbox_ops_file: path_to_string(guest_contracts::runtime_paths::sandbox_ops_log_file(
                &runtime_dir,
            )),
            telemetry_system_log_pos_file: path_to_string(
                guest_contracts::runtime_paths::telemetry_system_log_pos_file(&runtime_dir),
            ),
            telemetry_metrics_pos_file: path_to_string(
                guest_contracts::runtime_paths::telemetry_metrics_pos_file(&runtime_dir),
            ),
            telemetry_sandbox_ops_pos_file: path_to_string(
                guest_contracts::runtime_paths::telemetry_sandbox_ops_pos_file(&runtime_dir),
            ),
            runtime_dir,
        }
    }

    /// Build paths by resolving the current process runtime-dir contract.
    pub fn from_process_env(
        run_id: &str,
    ) -> Result<Self, guest_contracts::runtime_paths::RuntimePathError> {
        guest_contracts::runtime_paths::run_dir_from_env(run_id).map(Self::from_runtime_dir)
    }

    /// Build paths from values captured during bootstrap without rereading env.
    pub fn from_captured_env(
        run_id: &str,
        runtime_dir: Option<&Path>,
        process_home: Option<&Path>,
    ) -> Result<Self, guest_contracts::runtime_paths::RuntimePathError> {
        guest_contracts::runtime_paths::run_dir_from_captured_env(run_id, runtime_dir, process_home)
            .map(Self::from_runtime_dir)
    }

    /// Build paths from a guest home and run id using the default layout.
    pub fn from_home(
        guest_home: impl AsRef<Path>,
        run_id: &str,
    ) -> Result<Self, guest_contracts::runtime_paths::RuntimePathError> {
        guest_contracts::runtime_paths::run_dir_for_home(guest_home, run_id)
            .map(Self::from_runtime_dir)
    }

    /// Return the runtime directory captured when these paths were built.
    ///
    /// This returns the run root as a borrowed [`Path`]. The accessor only
    /// returns the captured path; it does not create, validate, or otherwise
    /// access filesystem entries.
    pub fn runtime_dir(&self) -> &Path {
        &self.runtime_dir
    }

    /// Return the run-root `session-id` path.
    ///
    /// The private text file stores the first observed, non-authoritative
    /// CLI-agent session ID. This accessor returns a borrowed `&str` and only
    /// derives the path; it does not create, validate, or otherwise access the
    /// file. See the canonical [session-id path helper][session_id_file] for
    /// the shared runtime layout.
    ///
    /// [session_id_file]: guest_contracts::runtime_paths::session_id_file
    pub fn session_id_file(&self) -> &str {
        &self.session_id_file
    }

    /// Return the run-root `checkpoint-error` path.
    ///
    /// The private text file contains a non-empty checkpoint or guest error
    /// message when one is recorded. This accessor returns a borrowed `&str`
    /// and only derives the path; it does not create, validate, or otherwise
    /// access the file. See the canonical [checkpoint-error path helper][checkpoint_error_file]
    /// for the shared runtime layout.
    ///
    /// [checkpoint_error_file]: guest_contracts::runtime_paths::checkpoint_error_file
    pub fn checkpoint_error_file(&self) -> &str {
        &self.checkpoint_error_file
    }

    /// Return the run-root `final-session-history-identity.json` path.
    ///
    /// The JSON file stores the metadata used to verify the final session
    /// history identity. This accessor returns a borrowed `&str` and only
    /// derives the path; it does not create, validate, or otherwise access the
    /// file. See the canonical [final-session-history identity path helper][final_session_history_identity_file]
    /// for the shared runtime layout.
    ///
    /// [final_session_history_identity_file]:
    ///     guest_contracts::runtime_paths::final_session_history_identity_file
    pub fn final_session_history_identity_file(&self) -> &str {
        &self.final_session_history_identity_file
    }

    /// Return the run-root `failure-diagnostic.json` path.
    ///
    /// The file contains the structured JSON diagnostic for a guest failure.
    /// This accessor returns a borrowed `&str` and only derives the path; it
    /// does not create, validate, or otherwise access the file. See the
    /// canonical [failure-diagnostic path helper][failure_diagnostic_file] for
    /// the shared runtime layout.
    ///
    /// [failure_diagnostic_file]: guest_contracts::runtime_paths::failure_diagnostic_file
    pub fn failure_diagnostic_file(&self) -> &str {
        &self.failure_diagnostic_file
    }

    /// Return the private run-root `claude-append-system-prompt` path.
    ///
    /// This transient plain-text file carries an appended system prompt to the
    /// Claude CLI child without putting the prompt in its argument vector.
    /// This accessor returns a borrowed `&str` and only derives the path; it
    /// does not create, validate, or otherwise access the file. See the
    /// canonical [Claude prompt path helper][claude_append_system_prompt_file]
    /// for the shared runtime layout.
    ///
    /// [claude_append_system_prompt_file]:
    ///     guest_contracts::runtime_paths::claude_append_system_prompt_file
    pub fn claude_append_system_prompt_file(&self) -> &str {
        &self.claude_append_system_prompt_file
    }

    /// Return the private `pi-launch-payload/payload.json` path.
    ///
    /// This transient JSON file carries launch inputs to the Pi CLI child.
    /// This accessor returns a borrowed `&str` and only derives the path; it
    /// does not create, validate, or otherwise access the file. See the
    /// canonical [Pi launch payload path helper][pi_launch_payload_file] for
    /// the shared runtime layout.
    ///
    /// [pi_launch_payload_file]: guest_contracts::runtime_paths::pi_launch_payload_file
    pub fn pi_launch_payload_file(&self) -> &str {
        &self.pi_launch_payload_file
    }

    /// Return the private `pi-deferred-handoff/payload.json` path.
    ///
    /// The guest writes authenticated handoff bytes here before spawning a
    /// deferred Pi CLI. The accessor only returns the captured path.
    pub fn pi_deferred_handoff_file(&self) -> &str {
        &self.pi_deferred_handoff_file
    }

    /// Return the `logs/system.log` path.
    ///
    /// This stream contains structured guest system-log text, one line per
    /// emitted log entry; it is not a JSONL stream. This accessor returns a
    /// borrowed `&str` and only derives the path; it does not create, validate,
    /// or otherwise access the file. See the canonical [system log path helper][system_log_file]
    /// for the shared runtime layout.
    ///
    /// [system_log_file]: guest_contracts::runtime_paths::system_log_file
    pub fn system_log_file(&self) -> &str {
        &self.system_log_file
    }

    /// Return the `logs/agent.jsonl` path.
    ///
    /// This best-effort local agent-event log uses a backend-specific JSONL
    /// representation. The Codex app-server backend writes normalized
    /// compatibility events and may include synthesized events such as
    /// `thread.started`; it does not store raw app-server JSON-RPC stdout. See
    /// the [Codex normalization policy] for the mapping rules.
    ///
    /// This accessor returns a borrowed `&str` and only derives the path; it
    /// does not create, validate, or otherwise access the file. See the canonical
    /// [agent log path helper][agent_log_file] for the shared runtime layout.
    ///
    /// [Codex normalization policy]: https://github.com/vm0-ai/vm0/blob/main/crates/guest-agent/src/cli/codex_app_server_events.rs
    /// [agent_log_file]: guest_contracts::runtime_paths::agent_log_file
    pub fn agent_log_file(&self) -> &str {
        &self.agent_log_file
    }

    /// Return the `logs/metrics.jsonl` path.
    ///
    /// This JSONL stream contains periodic CPU, memory, and disk snapshots.
    /// This accessor returns a borrowed `&str` and only derives the path; it
    /// does not create, validate, or otherwise access the file. See the
    /// canonical [metrics log path helper][metrics_log_file] for the shared
    /// runtime layout.
    ///
    /// [metrics_log_file]: guest_contracts::runtime_paths::metrics_log_file
    pub fn metrics_log_file(&self) -> &str {
        &self.metrics_log_file
    }

    /// Return the `logs/sandbox-ops.jsonl` path.
    ///
    /// This JSONL stream contains sandbox-operation timing records. This
    /// accessor returns a borrowed `&str` and only derives the path; it does
    /// not create, validate, or otherwise access the file. See the canonical
    /// [sandbox operations log path helper][sandbox_ops_log_file] for the
    /// shared runtime layout.
    ///
    /// [sandbox_ops_log_file]: guest_contracts::runtime_paths::sandbox_ops_log_file
    pub fn sandbox_ops_file(&self) -> &str {
        &self.sandbox_ops_file
    }

    /// Return the `telemetry/system-log.pos` path.
    ///
    /// This file stores the decimal-text read/upload offset for
    /// [`Self::system_log_file`], separately from the log stream itself. This
    /// accessor returns a borrowed `&str` and only derives the path; it does
    /// not create, validate, or otherwise access the file. See the canonical
    /// [system-log telemetry position helper][telemetry_system_log_pos_file]
    /// for the shared runtime layout.
    ///
    /// [telemetry_system_log_pos_file]:
    ///     guest_contracts::runtime_paths::telemetry_system_log_pos_file
    pub fn telemetry_system_log_pos_file(&self) -> &str {
        &self.telemetry_system_log_pos_file
    }

    /// Return the `telemetry/metrics.pos` path.
    ///
    /// This file stores the decimal-text read/upload offset for
    /// [`Self::metrics_log_file`], separately from the log stream itself. This
    /// accessor returns a borrowed `&str` and only derives the path; it does
    /// not create, validate, or otherwise access the file. See the canonical
    /// [metrics telemetry position helper][telemetry_metrics_pos_file] for the
    /// shared runtime layout.
    ///
    /// [telemetry_metrics_pos_file]:
    ///     guest_contracts::runtime_paths::telemetry_metrics_pos_file
    pub fn telemetry_metrics_pos_file(&self) -> &str {
        &self.telemetry_metrics_pos_file
    }

    /// Return the `telemetry/sandbox-ops.pos` path.
    ///
    /// This file stores the decimal-text read/upload offset for
    /// [`Self::sandbox_ops_file`], separately from the log stream itself. This
    /// accessor returns a borrowed `&str` and only derives the path; it does
    /// not create, validate, or otherwise access the file. See the canonical
    /// [sandbox operations telemetry position helper][telemetry_sandbox_ops_pos_file]
    /// for the shared runtime layout.
    ///
    /// [telemetry_sandbox_ops_pos_file]:
    ///     guest_contracts::runtime_paths::telemetry_sandbox_ops_pos_file
    pub fn telemetry_sandbox_ops_pos_file(&self) -> &str {
        &self.telemetry_sandbox_ops_pos_file
    }
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guest_paths_derives_runtime_files_from_run_dir() {
        let runtime_dir = PathBuf::from("/tmp/vm0-run");
        let paths = GuestPaths::from_runtime_dir(runtime_dir.clone());

        assert_eq!(paths.runtime_dir(), runtime_dir.as_path());
        assert_eq!(
            paths.session_id_file(),
            guest_contracts::runtime_paths::session_id_file(&runtime_dir).to_string_lossy()
        );
        assert_eq!(
            paths.checkpoint_error_file(),
            guest_contracts::runtime_paths::checkpoint_error_file(&runtime_dir).to_string_lossy()
        );
        assert_eq!(
            paths.final_session_history_identity_file(),
            guest_contracts::runtime_paths::final_session_history_identity_file(&runtime_dir)
                .to_string_lossy()
        );
        assert_eq!(
            paths.failure_diagnostic_file(),
            guest_contracts::runtime_paths::failure_diagnostic_file(&runtime_dir).to_string_lossy()
        );
        assert_eq!(
            paths.pi_launch_payload_file(),
            guest_contracts::runtime_paths::pi_launch_payload_file(&runtime_dir).to_string_lossy()
        );
        assert_eq!(
            paths.pi_deferred_handoff_file(),
            guest_contracts::runtime_paths::pi_deferred_handoff_file(&runtime_dir)
                .to_string_lossy()
        );
        assert_eq!(
            paths.system_log_file(),
            guest_contracts::runtime_paths::system_log_file(&runtime_dir).to_string_lossy()
        );
        assert_eq!(
            paths.agent_log_file(),
            guest_contracts::runtime_paths::agent_log_file(&runtime_dir).to_string_lossy()
        );
        assert_eq!(
            paths.metrics_log_file(),
            guest_contracts::runtime_paths::metrics_log_file(&runtime_dir).to_string_lossy()
        );
        assert_eq!(
            paths.sandbox_ops_file(),
            guest_contracts::runtime_paths::sandbox_ops_log_file(&runtime_dir).to_string_lossy()
        );
        assert_eq!(
            paths.telemetry_system_log_pos_file(),
            guest_contracts::runtime_paths::telemetry_system_log_pos_file(&runtime_dir)
                .to_string_lossy()
        );
        assert_eq!(
            paths.telemetry_metrics_pos_file(),
            guest_contracts::runtime_paths::telemetry_metrics_pos_file(&runtime_dir)
                .to_string_lossy()
        );
        assert_eq!(
            paths.telemetry_sandbox_ops_pos_file(),
            guest_contracts::runtime_paths::telemetry_sandbox_ops_pos_file(&runtime_dir)
                .to_string_lossy()
        );
    }

    #[test]
    fn guest_paths_from_home_uses_default_runtime_layout() {
        let home = PathBuf::from("/home/vm0");
        let paths = GuestPaths::from_home(&home, "run-123").unwrap();
        let expected_runtime =
            guest_contracts::runtime_paths::run_dir_for_home(&home, "run-123").unwrap();

        assert_eq!(paths.runtime_dir(), expected_runtime.as_path());
        assert_eq!(
            paths.agent_log_file(),
            guest_contracts::runtime_paths::agent_log_file(&expected_runtime).to_string_lossy()
        );
    }

    #[test]
    fn guest_paths_from_captured_env_uses_absolute_runtime_dir() {
        let runtime_dir = PathBuf::from("/tmp/vm0-runtime");
        let paths = GuestPaths::from_captured_env("ignored/for-override", Some(&runtime_dir), None)
            .unwrap();

        assert_eq!(paths.runtime_dir(), runtime_dir.as_path());
    }

    #[test]
    fn guest_paths_from_captured_env_rejects_relative_runtime_dir() {
        let err = GuestPaths::from_captured_env(
            "run-123",
            Some(Path::new("relative-runtime")),
            Some(Path::new("/home/vm0")),
        )
        .unwrap_err();

        assert_eq!(
            err,
            guest_contracts::runtime_paths::RuntimePathError::InvalidRuntimeDir
        );
    }

    #[test]
    fn guest_paths_from_captured_env_falls_back_to_process_home() {
        let paths =
            GuestPaths::from_captured_env("run-123", None, Some(Path::new("/home/vm0"))).unwrap();
        let expected_runtime =
            guest_contracts::runtime_paths::run_dir_for_home("/home/vm0", "run-123").unwrap();

        assert_eq!(paths.runtime_dir(), expected_runtime.as_path());
    }

    #[test]
    fn guest_paths_from_captured_env_rejects_missing_process_home() {
        let err = GuestPaths::from_captured_env("run-123", None, Some(Path::new(""))).unwrap_err();

        assert_eq!(
            err,
            guest_contracts::runtime_paths::RuntimePathError::MissingHome
        );
    }
}
