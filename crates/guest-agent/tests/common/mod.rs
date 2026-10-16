//! Shared setup for CLI integration tests.
//!
//! # Test executable boundaries
//!
//! Many CLI tests mutate process env, current directory, and guest runtime path
//! overrides as setup input. Keep those scenarios, process-global telemetry/log sinks and
//! signal/resource-limit fixtures in separate binaries: ordinary Cargo can run
//! cases concurrently within one executable. Nextest's per-case isolation does
//! not make an unsafe shared executable valid for ordinary Cargo.
//!
//! Domain targets share this module once for cases with explicit configuration
//! and independently owned resources, including parents that already isolate
//! their guarded children. Keep self-spawn filters fully module-qualified; see
//! `tests/README.md` for the target layout and selection commands.
//!
//! # Error handling
//!
//! Fallible helpers return `Result<_, String>` and let the test's
//! `#[tokio::test]` body propagate with `?` — clippy's
//! `allow-expect-in-tests` applies to test bodies but not to helpers
//! implemented here or in `cli-test-support`.

#![allow(dead_code)] // consumed across multiple test binaries

mod system_log;

// Every executable uses a different subset of this shared fixture facade.
#[allow(unused_imports)]
pub use cli_test_support::{
    command::{command_output_with_stdin_timeout, command_output_with_timeout},
    delivery_image,
    http::{
        ControlledHttpServer, ControlledRequest, RecordedHttpEvent, RecordedRequest,
        RecordingServer, event_request_sequences,
    },
    json_fixture::{self, contains_json_text},
    mock_build::{
        PostOpenMockGate, acquire_mock_build_lock, build_and_locate_mock_package_in_workspace,
        test_runner_build_session_id,
    },
    process_session,
    readiness::{unique_temp_path, wait_for_file_contains, wait_for_path},
};

use serde_json::{Value, json};
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::task::Poll;
use std::time::{Duration, Instant};

pub type SystemLogOverrideGuard = system_log::SystemLogOverrideGuard;

/// 128 + SIGTERM(15). Rust / glibc's default signal handler maps a
/// SIGTERM-terminated process to this exit code.
pub const SIGTERM_EXIT: i32 = 143;

/// 128 + SIGKILL(9). Un-catchable; the only way out for a process
/// that ignores SIGTERM.
pub const SIGKILL_EXIT: i32 = 137;

/// Normal clean exit. Reap should never fire on this path.
pub const CLEAN_EXIT: i32 = 0;

pub const MOCK_TERMINATION_READY_EVENT: &str = "claude_mock_termination_ready";
pub const MOCK_CODEX_TURN_START_READY_FILE: &str = ".codex-mock-turn-start-ready";
pub const MOCK_CODEX_TURN_START_READY_EVENT: &str = "codex_mock_turn_start_ready";
pub const MOCK_CODEX_TURN_COMPLETE_BEFORE_HEARTBEAT_READY_FILE: &str =
    ".codex-mock-turn-complete-before-heartbeat-ready";
pub const MOCK_CODEX_SESSION_HISTORY_READY_FILE: &str = ".codex-mock-session-history-ready";
pub const MOCK_CODEX_SESSION_HISTORY_READY_EVENT: &str = "codex_mock_session_history_ready";
pub const MOCK_CODEX_TURN_STEER_READY_FILE: &str = ".codex-mock-turn-steer-ready";
pub const MOCK_CODEX_TURN_STEER_READY_EVENT: &str = "codex_mock_turn_steer_ready";
pub const MOCK_CODEX_TURN_STEER_RELEASE_SOCKET: &str = ".codex-mock-turn-steer-release.sock";
pub const MOCK_CODEX_EVENT_DELIVERY_LARGE_RELEASE_SOCKET: &str =
    ".codex-mock-event-delivery-large-release.sock";
pub const MOCK_CODEX_ACTIVE_TURN_READY_FILE: &str = ".codex-mock-active-turn-ready";
pub const MOCK_CODEX_ACTIVE_TURN_READY_EVENT: &str = "codex_mock_active_turn_ready";
pub const MOCK_CODEX_TURN_INTERRUPT_READY_FILE: &str = ".codex-mock-turn-interrupt-ready";
pub const MOCK_CODEX_TURN_INTERRUPT_READY_EVENT: &str = "codex_mock_turn_interrupt_ready";
pub const MOCK_POST_RESULT_READY_EVENT: &str = "claude_mock_post_result_ready";
pub const MOCK_POST_RESULT_ACTIVITY_ONE_EVENT: &str = "claude_mock_post_result_activity_1_ready";
pub const MOCK_POST_RESULT_ACTIVITY_TWO_EVENT: &str = "claude_mock_post_result_activity_2_ready";
pub const MOCK_POST_RESULT_LIVENESS_EVENT: &str = "claude_mock_post_result_stale_deadline_survived";
pub const MOCK_POST_RESULT_RELEASE_ONE_SOCKET: &str = ".vm0-post-result-release-1.sock";
pub const MOCK_POST_RESULT_RELEASE_TWO_SOCKET: &str = ".vm0-post-result-release-2.sock";

#[derive(Debug)]
pub struct RunFilesGuard {
    paths: guest_agent::paths::GuestPaths,
}

impl RunFilesGuard {
    pub fn new_for_paths(paths: &guest_agent::paths::GuestPaths) -> Self {
        cleanup_run_files_for_paths(paths);
        Self {
            paths: paths.clone(),
        }
    }

    pub fn sandbox_ops_file(&self) -> &str {
        self.paths.sandbox_ops_file()
    }
}

impl Drop for RunFilesGuard {
    fn drop(&mut self) {
        cleanup_run_files_for_paths(&self.paths);
    }
}

fn cleanup_run_files_for_paths(paths: &guest_agent::paths::GuestPaths) {
    let _ = std::fs::remove_file(paths.agent_log_file());
    let _ = std::fs::remove_file(paths.session_id_file());
    let _ = std::fs::remove_file(paths.sandbox_ops_file());
}

/// Integration tests call `execute_cli` directly, bypassing the runner-side
/// home-drive mount. Create the canonical mountpoint once at the host-test
/// boundary so tests exercise the same cwd contract as production.
pub fn ensure_canonical_workspace_for_test() -> Result<(), String> {
    let path = Path::new(guest_agent::paths::CANONICAL_WORKING_DIR);
    if path.is_dir() {
        return Ok(());
    }

    match std::fs::create_dir_all(path) {
        Ok(()) => return Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {}
        Err(e) => {
            return Err(format!(
                "create canonical workspace {}: {e}",
                path.display()
            ));
        }
    }

    let status = std::process::Command::new("sudo")
        .args(["-n", "mkdir", "-p"])
        .arg(path)
        .status()
        .map_err(|e| format!("invoke sudo mkdir for {}: {e}", path.display()))?;
    if !status.success() {
        return Err(format!(
            "sudo mkdir failed for canonical workspace {} with status {status}",
            path.display()
        ));
    }
    if !path.is_dir() {
        return Err(format!(
            "canonical workspace was not created as a directory: {}",
            path.display()
        ));
    }
    Ok(())
}

/// Build the mock binary once per verified Cargo or nextest invocation and resolve
/// its filesystem path.
///
/// The subprocess `cargo build` must land the artifact in the same
/// `target/` directory + profile that the enclosing `cargo test` uses,
/// otherwise the mock goes to a different spot than where we look for
/// it — which happens under `cargo llvm-cov` (custom `--target-dir`)
/// and under `cargo test --release`. We infer both from the currently-
/// running test binary's path and forward them to the subprocess.
pub fn build_and_locate_mock() -> Result<PathBuf, String> {
    build_and_locate_mock_package("claude-mock", "claude-mock")
}

/// Build the mock Codex binary and resolve its filesystem path beside the
/// current test profile.
pub fn build_and_locate_mock_codex() -> Result<PathBuf, String> {
    build_and_locate_mock_package("codex-mock", "codex-mock")
}

pub struct SoftFileSizeLimitGuard {
    original_limit: Option<libc::rlimit>,
    original_sigxfsz: libc::sighandler_t,
}

impl SoftFileSizeLimitGuard {
    pub fn restore(mut self) -> Result<(), String> {
        self.restore_inner()
    }

    fn restore_inner(&mut self) -> Result<(), String> {
        let Some(original_limit) = self.original_limit else {
            return Ok(());
        };
        // SAFETY: original_limit was returned by getrlimit for this process.
        if unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &original_limit) } != 0 {
            return Err(format!(
                "restore RLIMIT_FSIZE: {}",
                io::Error::last_os_error()
            ));
        }
        // SAFETY: original_sigxfsz was returned by signal for SIGXFSZ.
        if unsafe { libc::signal(libc::SIGXFSZ, self.original_sigxfsz) } == libc::SIG_ERR {
            return Err(format!(
                "restore SIGXFSZ disposition: {}",
                io::Error::last_os_error()
            ));
        }
        self.original_limit = None;
        Ok(())
    }
}

impl Drop for SoftFileSizeLimitGuard {
    fn drop(&mut self) {
        if let Err(error) = self.restore_inner() {
            eprintln!("{error}");
        }
    }
}

pub fn set_soft_file_size_limit(limit: u64) -> Result<SoftFileSizeLimitGuard, String> {
    let mut current = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    // SAFETY: current points to writable storage for one rlimit value.
    if unsafe { libc::getrlimit(libc::RLIMIT_FSIZE, current.as_mut_ptr()) } != 0 {
        return Err(format!("read RLIMIT_FSIZE: {}", io::Error::last_os_error()));
    }
    // SAFETY: successful getrlimit initialized current.
    let current = unsafe { current.assume_init() };
    let target: libc::rlim_t = limit;
    if target > current.rlim_max {
        return Err(format!(
            "requested RLIMIT_FSIZE {target} exceeds hard limit {}",
            current.rlim_max
        ));
    }

    // SAFETY: installing SIG_IGN for SIGXFSZ is process-local and restored by
    // SoftFileSizeLimitGuard after the isolated integration execution.
    let original_sigxfsz = unsafe { libc::signal(libc::SIGXFSZ, libc::SIG_IGN) };
    if original_sigxfsz == libc::SIG_ERR {
        return Err(format!("ignore SIGXFSZ: {}", io::Error::last_os_error()));
    }

    let next = libc::rlimit {
        rlim_cur: target,
        rlim_max: current.rlim_max,
    };
    // SAFETY: next preserves the current hard limit and uses a checked soft limit.
    if unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &next) } != 0 {
        let limit_error = io::Error::last_os_error();
        // SAFETY: original_sigxfsz came from the successful signal call above.
        let restore_result = unsafe { libc::signal(libc::SIGXFSZ, original_sigxfsz) };
        if restore_result == libc::SIG_ERR {
            return Err(format!(
                "set RLIMIT_FSIZE: {limit_error}; restore SIGXFSZ disposition: {}",
                io::Error::last_os_error()
            ));
        }
        return Err(format!("set RLIMIT_FSIZE: {limit_error}"));
    }

    Ok(SoftFileSizeLimitGuard {
        original_limit: Some(current),
        original_sigxfsz,
    })
}

fn build_and_locate_mock_package(package: &str, binary: &str) -> Result<PathBuf, String> {
    // Test binary:   <target_dir>/<profile>/deps/<name>-<hash>
    //   parent():    <target_dir>/<profile>/deps
    //   parent().parent():  <target_dir>/<profile>   ← target_profile_dir
    //   parent().parent().parent():  <target_dir>
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let target_profile_dir = exe
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| "target/<profile> dir".to_string())?;
    let workspace_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "guest-agent workspace directory".to_string())?;

    let build_session = test_runner_build_session_id();
    build_and_locate_mock_package_in_workspace(
        workspace_dir,
        target_profile_dir,
        package,
        binary,
        build_session.as_deref(),
    )
}

/// Test-specific values for Codex app-server execution env.
pub struct CodexAppServerEnvConfig<'a> {
    pub run_id: &'a str,
    pub prompt: &'a str,
    pub scenario: Option<&'a str>,
    pub resume_session_id: Option<&'a str>,
}

/// Clear runner/bootstrap environment that could be inherited from a parent
/// runner process. Test setup helpers then write the exact env snapshot they
/// want `GuestRuntime::from_process_env` to capture.
///
/// # Safety
/// Call before any other test thread reads process environment.
pub unsafe fn clear_guest_agent_bootstrap_env_for_test() {
    for key in [
        guest_contracts::env::CANONICAL_API_URL_ENV,
        guest_contracts::env::RUN_ID_ENV,
        guest_contracts::env::CANONICAL_API_TOKEN_ENV,
        guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
        guest_contracts::env::VERCEL_PROTECTION_BYPASS_ENV,
        guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
        guest_contracts::env::CANONICAL_API_START_TIME_ENV,
        guest_contracts::env::CANONICAL_AGENT_EXECUTION_TIMEOUT_SECS_ENV,
        guest_contracts::env::CLI_AGENT_TYPE_ENV,
        guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
        guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
        guest_contracts::env::CANONICAL_STUCK_TOOL_TIMEOUT_SECS_ENV,
        guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
        guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
        guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
        guest_contracts::env::USE_MOCK_CLAUDE_ENV,
        guest_contracts::env::USE_MOCK_CODEX_ENV,
        guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV,
        guest_contracts::env::CANONICAL_MOCK_CODEX_PATH_ENV,
        guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
        process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
        guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
        guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV,
        "OKOU_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL",
        "OKOU_TEST_CLAUDE_CONFIG_DIR",
        "OKOU_TEST_CODEX_HOME_DIR",
        "OKOU_TEST_PI_CLI_PATH",
        "MOCK_CODEX_APP_SERVER_SCENARIO",
    ] {
        unsafe {
            std::env::remove_var(key);
        }
    }
}

pub fn write_run_payload_file_for_test(
    runtime_dir: &Path,
    payload: &guest_contracts::env::RunPayload,
) -> Result<std::path::PathBuf, String> {
    let dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|error| format!("create run payload dir: {error}"))?;
    let path = dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    let bytes =
        serde_json::to_vec(payload).map_err(|error| format!("serialize run payload: {error}"))?;
    std::fs::write(&path, bytes).map_err(|error| format!("write run payload: {error}"))?;
    Ok(path)
}

/// Write the runner-owned run payload file and expose it through process env.
///
/// # Safety
/// Call before any other test thread reads process environment.
pub unsafe fn set_run_payload_file_env_for_test(
    runtime_dir: &Path,
    payload: &guest_contracts::env::RunPayload,
) -> Result<(), String> {
    let path = write_run_payload_file_for_test(runtime_dir, payload)?;
    unsafe {
        std::env::set_var(guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV, path);
    }
    Ok(())
}

/// Write model-provider/user environment and expose it through process env.
///
/// # Safety
/// Call before any other test thread reads process environment.
pub unsafe fn set_user_env_file_env_for_test(
    runtime_dir: &Path,
    user_env: &HashMap<String, String>,
) -> Result<(), String> {
    let dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|error| format!("create user env dir: {error}"))?;
    let path = dir.join(guest_contracts::env::USER_ENV_FILENAME);
    let bytes =
        serde_json::to_vec(user_env).map_err(|error| format!("serialize user env: {error}"))?;
    std::fs::write(&path, bytes).map_err(|error| format!("write user env: {error}"))?;
    unsafe {
        std::env::set_var(guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV, path);
    }
    Ok(())
}

/// Configure one test binary for Codex app-server execution.
///
/// Must be called before building a `GuestRuntime` because runtime bootstrap
/// captures the process env snapshot.
///
/// # Safety
/// Callers must use this from a single-test integration binary before any other
/// thread reads the process environment.
pub unsafe fn setup_codex_app_server_env(
    mock_path: &Path,
    home: &Path,
    config: CodexAppServerEnvConfig<'_>,
) -> Result<(), String> {
    unsafe {
        clear_guest_agent_bootstrap_env_for_test();
        std::env::set_var("CLI_AGENT_TYPE", "codex");
        std::env::set_var(
            guest_contracts::env::CANONICAL_MOCK_CODEX_PATH_ENV,
            mock_path,
        );
        std::env::set_var("USE_MOCK_CODEX", "true");
        if let Some(scenario) = config.scenario {
            std::env::set_var("MOCK_CODEX_APP_SERVER_SCENARIO", scenario);
        } else {
            std::env::remove_var("MOCK_CODEX_APP_SERVER_SCENARIO");
        }
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, config.run_id);
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            "http://127.0.0.1:1",
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "");
        std::env::set_var(
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        );
        std::env::set_var("HOME", home);
        std::env::set_var("OKOU_TEST_CODEX_HOME_DIR", home.join("codex-home"));
        let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(home, config.run_id)
            .map_err(|error| format!("resolve runtime dir: {error}"))?;
        set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: config.prompt.to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
        if let Some(resume_session_id) = config.resume_session_id {
            std::env::set_var(
                guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV,
                resume_session_id,
            );
        } else {
            std::env::remove_var(guest_contracts::env::CANONICAL_RESUME_SESSION_ID_ENV);
        }
    }
    std::fs::create_dir_all(home).map_err(|error| format!("create home: {error}"))?;
    ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(home).map_err(|error| format!("set_current_dir: {error}"))?;
    Ok(())
}

pub fn active_input_payload(text: &str) -> Result<Vec<u8>, serde_json::Error> {
    guest_contracts::active_input::encode_active_input("223f8797-a456-4eea-98f7-f7ab88c43c00", text)
}

pub fn active_input_runtime(
    runtime: &guest_agent::run_context::GuestRuntime,
) -> Result<guest_agent::active_input::ActiveInputRuntime, guest_agent::error::AgentError> {
    Ok(guest_agent::active_input::ActiveInputRuntime::new_enabled(
        &runtime.config.run_id,
        &runtime.config.prompt,
        guest_agent::http::HttpClient::new()?,
    ))
}

pub fn read_codex_session_history_events_for_runtime(
    runtime: &guest_agent::run_context::GuestRuntime,
) -> Result<Vec<Value>, Box<dyn std::error::Error>> {
    let thread_id = std::fs::read_to_string(runtime.paths.session_id_file())?;
    let filename_key =
        guest_contracts::codex_thread_id::codex_thread_id_filename_key(thread_id.trim())
            .ok_or("invalid captured Codex thread ID")?;
    let sessions_dir = Path::new(&runtime.config.codex_home_dir).join("sessions");
    let mut matches = Vec::new();
    let mut pending = vec![sessions_dir];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.replace('-', "").contains(&filename_key))
            {
                matches.push(path);
            }
        }
    }
    let [history_path] = matches.as_slice() else {
        return Err(format!(
            "expected one Codex session history for captured thread, found {}",
            matches.len()
        )
        .into());
    };
    let history = std::fs::read_to_string(history_path)?;
    history
        .lines()
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

pub fn expected_codex_turn_usage() -> Value {
    json!({
        "input_tokens": 12,
        "cached_input_tokens": 3,
        "cache_write_input_tokens": 3,
        "output_tokens": 24,
        "reasoning_output_tokens": 7,
        "total_tokens": 36
    })
}

/// Configure the process environment for one mock-Claude CLI integration-test
/// binary. Must be called before building a `GuestRuntime` because runtime
/// bootstrap captures the process env snapshot.
///
/// `prompt` is interpreted by `claude-mock`. See the module documentation
/// in `crates/claude-mock/src/main.rs` for the complete special-prefix
/// catalog and `SCENARIO_RULES` in
/// `crates/claude-mock/src/scenario.rs` for authoritative matching
/// behavior. Prompts that match no special rule use ordinary shell behavior.
///
/// `sigterm_grace_secs` / `sigkill_grace_secs` control how long the
/// FSM waits before each signal escalation. Signal-exit tests want
/// them small (~1s) for fast convergence; the happy-path test can use
/// a sigterm grace larger than its outer timeout so post-result reap
/// cannot mask the natural clean-exit assertion.
///
/// # Side effects
///
/// - Mutates the process-wide environment (`set_var`).
/// - Mutates the process-wide working directory (`set_current_dir`).
///
/// Call AT MOST ONCE per process, and only when that process executes no other
/// test concurrently. Supported callers use either a one-test integration
/// binary or one exact-filtered isolated child-test process.
///
/// SAFETY: no other thread can read the process environment while this setup
/// mutates environment and CWD state.
pub unsafe fn setup_env(
    mock_path: &Path,
    workdir: &Path,
    prompt: &str,
    sigterm_grace_secs: u64,
    sigkill_grace_secs: u64,
) -> Result<(), String> {
    unsafe {
        clear_guest_agent_bootstrap_env_for_test();
        // Route the CLI binary resolution to the cargo-built mock.
        std::env::set_var("CLI_AGENT_TYPE", "claude-code");
        std::env::set_var(
            guest_contracts::env::CANONICAL_MOCK_CLAUDE_PATH_ENV,
            mock_path,
        );
        std::env::set_var("USE_MOCK_CLAUDE", "true");
        std::env::set_var(
            guest_contracts::env::CANONICAL_POST_RESULT_SIGTERM_GRACE_SECS_ENV,
            sigterm_grace_secs.to_string(),
        );
        std::env::set_var(
            guest_contracts::env::CANONICAL_POST_RESULT_SIGKILL_GRACE_SECS_ENV,
            sigkill_grace_secs.to_string(),
        );
        std::env::set_var(
            guest_contracts::env::CANONICAL_POST_RESULT_TOTAL_CAP_SECS_ENV,
            "60",
        );
        // Derive run_id from the test binary's filename (which cargo
        // hashes per target) so concurrently running integration-test
        // binaries don't collide on the run-scoped files that paths.rs
        // creates.
        let run_id = std::env::current_exe()
            .ok()
            .as_deref()
            .and_then(Path::file_name)
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "post-result-reap-test".to_string());
        std::env::set_var(guest_contracts::env::RUN_ID_ENV, &run_id);
        let runtime_dir = guest_contracts::runtime_paths::run_dir_for_home(workdir, &run_id)
            .map_err(|error| format!("resolve runtime dir: {error}"))?;
        set_run_payload_file_env_for_test(
            &runtime_dir,
            &guest_contracts::env::RunPayload {
                prompt: prompt.to_string(),
                ..guest_contracts::env::RunPayload::default()
            },
        )?;
        // Empty API token → has_api() false → no network calls.
        std::env::set_var(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            "http://127.0.0.1:1",
        );
        std::env::set_var(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "");
        std::env::set_var(
            guest_contracts::env::CANONICAL_SANDBOX_ID_ENV,
            "00000000-0000-4000-8000-000000000abc",
        );
        // Redirect HOME so the mock's session-history write
        // (`$CLAUDE_CONFIG_DIR/projects/.../<session>.jsonl`) stays inside
        // the tempdir and gets cleaned up with it, instead of
        // accumulating in the dev's real ~/.claude on every run.
        std::env::set_var("HOME", workdir);
        std::env::set_var("OKOU_TEST_CLAUDE_CONFIG_DIR", workdir.join(".claude"));
    }
    std::fs::create_dir_all(workdir).map_err(|e| format!("create workdir: {e}"))?;
    ensure_canonical_workspace_for_test()?;
    std::env::set_current_dir(workdir).map_err(|e| format!("set_current_dir: {e}"))?;
    Ok(())
}

pub fn claude_history_path_for_home(home: &Path, session_id: &str) -> PathBuf {
    home.join(".claude")
        .join("projects")
        .join("-home-user-workspace")
        .join(format!("{session_id}.jsonl"))
}

pub fn spawn_heartbeat_monitor<F>(future: F) -> guest_agent::cli::HeartbeatMonitor
where
    F: std::future::Future<Output = Result<(), guest_agent::error::AgentError>> + Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let task = tokio::spawn(future);
        let status = match task.await {
            Ok(Ok(())) => guest_agent::cli::HeartbeatStatus::Stopped,
            Ok(Err(error)) => guest_agent::cli::HeartbeatStatus::Failed(
                guest_agent::heartbeat::HeartbeatFailure {
                    error,
                    diagnostic: test_heartbeat_failure_diagnostic(),
                },
            ),
            Err(error) => guest_agent::cli::HeartbeatStatus::TaskFailed(error.to_string()),
        };
        let _ = tx.send(status);
    });
    Some(rx)
}

pub fn test_heartbeat_failure_diagnostic()
-> guest_contracts::diagnostics::HeartbeatFailureDiagnostic {
    use guest_contracts::diagnostics::{
        HeartbeatFailedCycleDiagnostic, HeartbeatFailureDiagnostic, HttpAttemptFailureKind,
        HttpCompletedAttemptDiagnostic,
    };

    HeartbeatFailureDiagnostic {
        failed_cycles: vec![HeartbeatFailedCycleDiagnostic {
            scheduled_lag_ms: 17,
            attempts: vec![HttpCompletedAttemptDiagnostic {
                attempt: 3,
                client_request_id: "11111111-1111-4111-8111-111111111111".to_string(),
                elapsed_ms: 30_001,
                failure_kind: HttpAttemptFailureKind::Timeout,
                http_status: None,
                timeout_observed: Some(true),
                connect_observed: Some(false),
            }],
        }],
    }
}

/// Dummy heartbeat that never completes. The CLI-wait / reap-deadline
/// branches of `execute_cli`'s select! loop are the intended exit paths
/// for these tests; a heartbeat failure would go through a different
/// code path entirely.
pub fn spawn_dummy_heartbeat() -> guest_agent::cli::HeartbeatMonitor {
    None
}

pub fn guest_runtime_from_process_env() -> Result<guest_agent::run_context::GuestRuntime, String> {
    guest_agent::run_context::GuestRuntime::from_process_env()
}

pub async fn execute_cli_for_runtime(
    runtime: &guest_agent::run_context::GuestRuntime,
    masker: &guest_agent::masker::SecretMasker,
    heartbeat: guest_agent::cli::HeartbeatMonitor,
) -> Result<guest_agent::cli::CliExecutionResult, guest_agent::error::AgentError> {
    let active_input = guest_agent::active_input::ActiveInputRuntime::new_disabled(
        &runtime.config.run_id,
        &runtime.config.prompt,
    );
    execute_cli_with_active_input_for_runtime(
        runtime,
        masker,
        heartbeat,
        active_input.into_writer(),
    )
    .await
}

pub async fn execute_cli_with_active_input_for_runtime(
    runtime: &guest_agent::run_context::GuestRuntime,
    masker: &guest_agent::masker::SecretMasker,
    heartbeat: guest_agent::cli::HeartbeatMonitor,
    active_input: guest_agent::active_input::ActiveInputWriter,
) -> Result<guest_agent::cli::CliExecutionResult, guest_agent::error::AgentError> {
    guest_agent::cli::execute_cli_with_active_input_for_config(
        masker,
        heartbeat,
        runtime.http.clone(),
        active_input,
        &runtime.config,
        &runtime.paths,
    )
    .await
}

pub async fn execute_cli_with_cancellation_for_runtime(
    runtime: &guest_agent::run_context::GuestRuntime,
    masker: &guest_agent::masker::SecretMasker,
    heartbeat: guest_agent::cli::HeartbeatMonitor,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<guest_agent::cli::CliExecutionResult, guest_agent::error::AgentError> {
    let active_input = guest_agent::active_input::ActiveInputRuntime::new_disabled(
        &runtime.config.run_id,
        &runtime.config.prompt,
    );
    guest_agent::cli::execute_cli_with_controls_for_config_started_at(
        masker,
        heartbeat,
        runtime.http.clone(),
        guest_agent::cli::CliExecutionControls::new(active_input.into_writer(), cancellation, None),
        &runtime.config,
        &runtime.paths,
        Instant::now(),
    )
    .await
}

pub struct VirtualTimeCheckpoint<'a> {
    file: &'a str,
    needle: &'a str,
    advance: Duration,
    release_socket: Option<&'a Path>,
}

impl<'a> VirtualTimeCheckpoint<'a> {
    pub fn new(file: &'a str, needle: &'a str, advance: Duration) -> Self {
        Self {
            file,
            needle,
            advance,
            release_socket: None,
        }
    }

    pub fn release_after_advance(mut self, release_socket: &'a Path) -> Self {
        self.release_socket = Some(release_socket);
        self
    }
}

pub async fn execute_with_virtual_time_checkpoints<F>(
    future: F,
    checkpoints: &[VirtualTimeCheckpoint<'_>],
) -> Result<F::Output, String>
where
    F: Future,
{
    for checkpoint in checkpoints {
        guest_agent::paths::ensure_parent_dir(checkpoint.file).map_err(|error| {
            format!(
                "prepare parent directory for virtual-time checkpoint {}: {error}",
                checkpoint.file
            )
        })?;
    }

    tokio::pin!(future);
    for (index, checkpoint) in checkpoints.iter().enumerate() {
        tokio::select! {
            _ = &mut future => {
                return Err(format!(
                    "CLI execution completed before {:?} appeared in {}",
                    checkpoint.needle, checkpoint.file
                ));
            }
            ready = wait_for_file_contains(
                Path::new(checkpoint.file),
                checkpoint.needle,
                Duration::from_secs(5),
            ) => {
                ready.map_err(|error| {
                    format!(
                        "wait for {:?} in {} before advancing time: {error}",
                        checkpoint.needle, checkpoint.file
                    )
                })?;
            }
        }

        tokio::time::pause();
        tokio::time::advance(checkpoint.advance).await;

        let execution_poll =
            std::future::poll_fn(|context| Poll::Ready(future.as_mut().poll(context))).await;
        let release_result = if matches!(&execution_poll, Poll::Pending)
            && let Some(release_socket) = checkpoint.release_socket
        {
            UnixStream::connect(release_socket)
                .map(|_| ())
                .map_err(|error| {
                    format!(
                        "release virtual-time checkpoint through {}: {error}",
                        release_socket.display()
                    )
                })
        } else {
            Ok(())
        };
        tokio::time::resume();
        release_result?;

        if let Poll::Ready(output) = execution_poll {
            if index + 1 == checkpoints.len() && checkpoint.release_socket.is_none() {
                return Ok(output);
            }
            return Err(format!(
                "CLI execution completed after advancing time for {:?} before all checkpoint stages finished",
                checkpoint.needle
            ));
        }
    }

    Ok(future.await)
}
