use crate::process;
use crate::support::unique_run_id;
use serde_json::Value;
use std::ffi::OsStr;
use std::io;
use std::path::PathBuf;
use std::process::{Command, Output};
use tempfile::TempDir;

mod attribution;
mod connection_observation;
mod empty_artifact;
mod http_failure;
mod manifest_input;
mod redaction;
mod runtime_paths;

pub(super) struct RuntimeLogPaths {
    pub(super) runtime_dir: PathBuf,
    pub(super) system_log: PathBuf,
    pub(super) ops_log: PathBuf,
}

impl RuntimeLogPaths {
    pub(super) fn new(dir: &TempDir) -> Self {
        let runtime_dir = dir.path().join("guest-runtime");
        Self {
            system_log: guest_contracts::runtime_paths::system_log_file(&runtime_dir),
            ops_log: guest_contracts::runtime_paths::sandbox_ops_log_file(&runtime_dir),
            runtime_dir,
        }
    }
}

pub(super) struct BinaryLoggingFixture {
    pub(super) dir: TempDir,
    pub(super) logs: RuntimeLogPaths,
    run_id: String,
}

impl BinaryLoggingFixture {
    pub(super) fn new(test_name: &str) -> io::Result<Self> {
        let dir = tempfile::tempdir()?;
        let logs = RuntimeLogPaths::new(&dir);
        Ok(Self {
            dir,
            logs,
            run_id: unique_run_id(test_name),
        })
    }

    pub(super) fn command(&self) -> Command {
        let mut command = guest_storage_apply_command();
        command
            .env(guest_contracts::env::RUN_ID_ENV, &self.run_id)
            .env(
                guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
                &self.logs.runtime_dir,
            );
        command
    }

    pub(super) fn run_manifest_path(&self, manifest_path: impl AsRef<OsStr>) -> io::Result<Output> {
        self.spawn_manifest_path(manifest_path)?.wait()
    }

    pub(in crate::binary_logging) fn spawn_manifest_path(
        &self,
        manifest_path: impl AsRef<OsStr>,
    ) -> io::Result<process::CommandExecution> {
        process::CommandExecution::spawn(self.command().arg(manifest_path), None)
    }

    pub(super) fn run_manifest_stdin(&self, manifest_json: &[u8]) -> io::Result<Output> {
        process::CommandExecution::spawn(
            self.command().arg("--manifest-stdin"),
            Some(manifest_json),
        )?
        .wait()
    }

    pub(super) fn read_system_log(&self) -> io::Result<String> {
        std::fs::read_to_string(&self.logs.system_log)
    }

    pub(super) fn read_ops_log(&self) -> io::Result<String> {
        std::fs::read_to_string(&self.logs.ops_log)
    }

    pub(super) fn ops_entries(&self) -> Result<Vec<Value>, String> {
        let content = self
            .read_ops_log()
            .map_err(|error| format!("failed to read sandbox ops log: {error}"))?;
        sandbox_ops(&content)
    }

    pub(super) fn action_types(&self) -> Result<Vec<String>, String> {
        let content = self
            .read_ops_log()
            .map_err(|error| format!("failed to read sandbox ops log: {error}"))?;
        sandbox_op_action_types(&content)
    }
}

pub(super) fn guest_storage_apply_command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-storage-apply"));
    command.env_remove(guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV);
    command
}

pub(super) fn sandbox_ops(content: &str) -> Result<Vec<Value>, String> {
    content
        .lines()
        .map(|line| {
            serde_json::from_str::<Value>(line)
                .map_err(|error| format!("invalid sandbox op JSON {line:?}: {error}"))
        })
        .collect()
}

pub(super) fn sandbox_op_action_types(content: &str) -> Result<Vec<String>, String> {
    sandbox_ops(content)?
        .into_iter()
        .map(|entry| {
            entry
                .get("action_type")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| format!("missing action_type in sandbox op JSON {entry:?}"))
        })
        .collect()
}

pub(super) fn assert_action_types_present(actions: &[String], expected_actions: &[&str]) {
    for expected in expected_actions {
        assert!(
            actions.iter().any(|action| action.as_str() == *expected),
            "missing {expected} in {actions:?}"
        );
    }
}

pub(super) fn assert_default_zero_task_attribution(actions: &[String]) {
    assert_action_types_present(
        actions,
        &[
            "guest_storage_apply_task_count_0",
            "guest_storage_apply_remote_url_count_0",
            "guest_storage_apply_file_url_count_0",
            "guest_storage_apply_skill_child_task_count_0",
            "guest_storage_apply_framework_home_instructions_task_absent",
            "guest_storage_apply_potential_parent_child_overlap_count_0",
            "guest_storage_apply_mount_conflict_deferral_count_0",
            "guest_storage_apply_instructions_skill_conflict_deferral_count_0",
            "guest_storage_apply_exact_path_conflict_deferral_count_0",
            "guest_storage_apply_other_parent_child_conflict_deferral_count_0",
        ],
    );
}

pub(super) fn assert_single_download_total_success(ops: &[Value], expected_success: bool) {
    let totals = download_total_entries(ops);
    assert_eq!(totals.len(), 1, "unexpected sandbox ops: {ops:?}");
    if let Some(total) = totals.first() {
        assert_eq!(
            total.get("success").and_then(Value::as_bool),
            Some(expected_success),
            "unexpected download_total entry: {total:?}"
        );
    }
}

pub(super) fn assert_download_total_success_present(ops: &[Value], expected_success: bool) {
    assert!(
        download_total_entries(ops).iter().any(|entry| {
            entry
                .get("success")
                .and_then(Value::as_bool)
                .is_some_and(|success| success == expected_success)
        }),
        "missing download_total success={expected_success} entry: {ops:?}"
    );
}

fn download_total_entries(ops: &[Value]) -> Vec<&Value> {
    ops.iter()
        .filter(|entry| {
            entry
                .get("action_type")
                .and_then(Value::as_str)
                .is_some_and(|action| action == "download_total")
        })
        .collect()
}
