#![cfg(target_os = "linux")]

use crate::common;

use std::fs::File;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;

use guest_contracts::process_containment::{
    AGENT_MEMORY_MIN_BYTES, WORKLOAD_MEMORY_RESERVE_BYTES, WorkloadResourcePolicy,
};
use guest_contracts::reuse_preparation::{
    REUSE_PREPARATION_EXIT_CLEANUP_FAILED, REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED,
    REUSE_PREPARATION_EXIT_INVALID_REQUEST, ReusePreparationReport, ReusePreparationRequest,
};
use tokio::process::Command;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const REUSE_PREPARATION_HELPER_TIMEOUT: Duration = Duration::from_secs(30);

#[tokio::test]
async fn prepare_for_reuse_rejects_a_symlinked_home_capacity_root() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    let home = tempfile::tempdir()?;
    let alias = home.path().join("home-alias");
    symlink(home.path(), &alias)?;
    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    command
        .env_clear()
        .env("OKOU_TEST_PROCESS_CONTAINMENT_ROOT", &containment.root)
        .env(
            "OKOU_TEST_PROCESS_CONTAINMENT_CURRENT_GROUP",
            "/vm0-exec/exec-current/workload",
        )
        .env("OKOU_TEST_CODEX_HOME_DIR", home.path().join(".codex"))
        .env("OKOU_TEST_HOME_CAPACITY_ROOT", alias)
        .arg("prepare-for-reuse");
    let output = common::command_output_with_stdin_timeout(
        &mut command,
        &serde_json::to_vec(&request)?,
        REUSE_PREPARATION_HELPER_TIMEOUT,
        "home capacity inspection exceeded its test budget",
    )
    .await?;
    assert_eq!(
        output.status.code(),
        Some(guest_contracts::reuse_preparation::REUSE_PREPARATION_EXIT_INSPECTION_FAILED)
    );
    assert!(output.stdout.is_empty());
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_removes_managed_codex_auth() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let home = tempfile::tempdir()?;
    let codex_home = home.path().join(".codex");
    let auth_path = codex_home.join("auth.json");
    std::fs::create_dir(&codex_home)?;
    std::fs::write(
        &auth_path,
        r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-managed"}"#,
    )?;

    let output = run_helper_with_codex_home(&request, &codex_home).await?;

    assert!(
        output.status.success(),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!auth_path.exists());
    let report: ReusePreparationReport = serde_json::from_slice(&output.stdout)?;
    assert!(report.home.available_bytes > 0);
    assert!(report.home.available_inodes > 0);
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_symlinked_managed_codex_auth() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let home = tempfile::tempdir()?;
    let codex_home = home.path().join(".codex");
    let auth_path = codex_home.join("auth.json");
    let target = home.path().join("target-auth.json");
    std::fs::create_dir(&codex_home)?;
    std::fs::write(&target, b"keep")?;
    symlink(&target, &auth_path)?;

    let output = run_helper_with_codex_home(&request, &codex_home).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED)
    );
    assert_eq!(std::fs::read(&target)?, b"keep");
    assert!(auth_path.symlink_metadata()?.file_type().is_symlink());
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_symlinked_managed_codex_home() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let home = tempfile::tempdir()?;
    let target = home.path().join("target-codex-home");
    let codex_home = home.path().join(".codex");
    let target_auth = target.join("auth.json");
    std::fs::create_dir(&target)?;
    std::fs::write(&target_auth, b"keep")?;
    symlink(&target, &codex_home)?;

    let output = run_helper_with_codex_home(&request, &codex_home).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED)
    );
    assert_eq!(std::fs::read(&target_auth)?, b"keep");
    assert!(codex_home.symlink_metadata()?.file_type().is_symlink());
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_non_regular_managed_codex_auth() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let home = tempfile::tempdir()?;
    let codex_home = home.path().join(".codex");
    let auth_path = codex_home.join("auth.json");
    std::fs::create_dir_all(&auth_path)?;

    let output = run_helper_with_codex_home(&request, &codex_home).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED)
    );
    assert!(auth_path.is_dir());
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_preserves_current_runtime_and_cleans_stale_entries() -> TestResult {
    let dir = tempfile::tempdir()?;
    let runs = dir.path().join("runtime/runs");
    let current = runs.join("generation");
    let unstarted_candidate = runs.join("candidate");
    let stale = runs.join("stale/nested");
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(current.join("logs"))?;
    std::fs::create_dir_all(&stale)?;
    std::fs::create_dir_all(&outside)?;
    std::fs::write(current.join("session-id"), b"current")?;
    std::fs::write(stale.join("agent.jsonl"), b"stale")?;
    std::fs::write(runs.join("stale-file"), b"stale")?;
    std::fs::write(outside.join("keep"), b"outside")?;
    symlink(&outside, runs.join("stale-link"))?;
    assert!(!unstarted_candidate.exists());

    let output = run_helper(&ReusePreparationRequest {
        current_runtime_dir: path_string(&current),
    })
    .await?;

    assert!(
        output.status.success(),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report = serde_json::from_slice::<ReusePreparationReport>(&output.stdout)?;
    assert_eq!(report.removed_entries, 3);
    assert!(report.before.available_bytes > 0);
    assert!(report.after.available_bytes > 0);
    assert_eq!(std::fs::read(current.join("session-id"))?, b"current");
    assert!(!runs.join("stale").exists());
    assert!(!runs.join("stale-file").exists());
    assert!(!runs.join("stale-link").exists());
    assert!(!unstarted_candidate.exists());
    assert_eq!(std::fs::read(outside.join("keep"))?, b"outside");
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_removes_multiple_wide_parent_chunks() -> TestResult {
    let dir = tempfile::tempdir()?;
    let runs = dir.path().join("runtime/runs");
    let current = runs.join("current");
    std::fs::create_dir_all(&current)?;
    for index in 0..300 {
        std::fs::write(runs.join(format!("stale-{index:04}")), b"stale")?;
    }

    let output = run_helper(&ReusePreparationRequest {
        current_runtime_dir: path_string(&current),
    })
    .await?;

    assert!(
        output.status.success(),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report = serde_json::from_slice::<ReusePreparationReport>(&output.stdout)?;
    assert_eq!(report.removed_entries, 300);
    assert!(current.exists());
    assert_eq!(std::fs::read_dir(&runs)?.count(), 1);
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_removes_nested_wide_chunks() -> TestResult {
    let dir = tempfile::tempdir()?;
    let runs = dir.path().join("runtime/runs");
    let current = runs.join("current");
    let stale = runs.join("stale");
    let nested = stale.join("nested");
    std::fs::create_dir_all(&current)?;
    std::fs::create_dir_all(&nested)?;
    for index in 0..300 {
        std::fs::write(stale.join(format!("outer-{index:04}")), b"stale")?;
        std::fs::write(nested.join(format!("inner-{index:04}")), b"stale")?;
    }

    let output = run_helper(&ReusePreparationRequest {
        current_runtime_dir: path_string(&current),
    })
    .await?;

    assert!(
        output.status.success(),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report = serde_json::from_slice::<ReusePreparationReport>(&output.stdout)?;
    assert_eq!(report.removed_entries, 1);
    assert!(current.exists());
    assert!(!stale.exists());
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_removes_tree_at_cleanup_depth_limit() -> TestResult {
    let dir = tempfile::tempdir()?;
    let runs = dir.path().join("runtime/runs");
    let current = runs.join("current");
    let stale = runs.join("stale");
    std::fs::create_dir_all(&current)?;
    std::fs::create_dir_all(&stale)?;
    let mut deepest = stale.clone();
    for _ in 1..256 {
        deepest.push("nested");
        std::fs::create_dir(&deepest)?;
    }
    std::fs::write(deepest.join("stale"), b"stale")?;

    let output = run_helper(&ReusePreparationRequest {
        current_runtime_dir: path_string(&current),
    })
    .await?;

    assert!(
        output.status.success(),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report = serde_json::from_slice::<ReusePreparationReport>(&output.stdout)?;
    assert_eq!(report.removed_entries, 1);
    assert!(current.exists());
    assert!(!stale.exists());
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_tree_beyond_cleanup_depth_limit() -> TestResult {
    let dir = tempfile::tempdir()?;
    let runs = dir.path().join("runtime/runs");
    let current = runs.join("current");
    let stale = runs.join("stale");
    std::fs::create_dir_all(&current)?;
    std::fs::create_dir_all(&stale)?;
    let mut deepest = stale.clone();
    for _ in 0..256 {
        deepest.push("nested");
        std::fs::create_dir(&deepest)?;
    }
    std::fs::write(deepest.join("keep"), b"stale")?;

    let output = run_helper(&ReusePreparationRequest {
        current_runtime_dir: path_string(&current),
    })
    .await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED)
    );
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("runtime cleanup directory depth exceeds limit")
    );
    assert!(current.exists());
    assert_eq!(std::fs::read(deepest.join("keep"))?, b"stale");
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_missing_protected_generation_before_cleanup() -> TestResult {
    let dir = tempfile::tempdir()?;
    let runs = dir.path().join("runtime/runs");
    let missing_generation = runs.join("missing-generation");
    let stale = runs.join("stale");
    std::fs::create_dir_all(&stale)?;
    std::fs::write(stale.join("agent.jsonl"), b"stale")?;

    let output = run_helper(&ReusePreparationRequest {
        current_runtime_dir: path_string(&missing_generation),
    })
    .await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED)
    );
    assert!(!missing_generation.exists());
    assert_eq!(std::fs::read(stale.join("agent.jsonl"))?, b"stale");
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_symlinked_runtime_parent_without_touching_target() -> TestResult
{
    let dir = tempfile::tempdir()?;
    let real_parent = dir.path().join("real/runs");
    let current = real_parent.join("current");
    let stale = real_parent.join("stale");
    std::fs::create_dir_all(&current)?;
    std::fs::create_dir_all(&stale)?;
    std::fs::create_dir_all(dir.path().join("linked"))?;
    symlink(&real_parent, dir.path().join("linked/runs"))?;

    let output = run_helper(&ReusePreparationRequest {
        current_runtime_dir: path_string(&dir.path().join("linked/runs/current")),
    })
    .await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED)
    );
    assert!(current.exists());
    assert!(stale.exists());
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_fails_closed_when_runtime_parent_is_not_a_directory() -> TestResult {
    let dir = tempfile::tempdir()?;
    let runs = dir.path().join("runs");
    let current = runs.join("current");
    let outside = dir.path().join("outside");
    std::fs::write(&runs, b"not-a-directory")?;
    std::fs::create_dir_all(&outside)?;
    std::fs::write(outside.join("keep"), b"outside")?;

    let output = run_helper(&ReusePreparationRequest {
        current_runtime_dir: path_string(&current),
    })
    .await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED)
    );
    assert_eq!(std::fs::read(&runs)?, b"not-a-directory");
    assert_eq!(std::fs::read(outside.join("keep"))?, b"outside");
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_nested_filesystem_without_touching_it() -> TestResult {
    let mounted_data = tempfile::tempdir_in("/dev/shm")?;
    std::fs::write(mounted_data.path().join("keep"), b"mounted-data")?;

    let output = run_helper(&ReusePreparationRequest {
        current_runtime_dir: "/dev/shm".into(),
    })
    .await?;

    assert_mount_boundary_failure(&output);
    assert_eq!(
        std::fs::read(mounted_data.path().join("keep"))?,
        b"mounted-data"
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_same_filesystem_bind_mount() -> TestResult {
    if let Some(mount_path) = find_existing_same_filesystem_nested_mount()? {
        let output = run_helper(&ReusePreparationRequest {
            current_runtime_dir: path_string(&mount_path),
        })
        .await?;

        assert_mount_boundary_failure(&output);
        assert!(mount_path.exists());
        return Ok(());
    }

    let dir = tempfile::tempdir()?;
    let mounted_source = dir.path().join("outside");
    let runs = dir.path().join("runs");
    let current = runs.join("current");
    let stale_mount = runs.join("stale/nested-mount");
    std::fs::create_dir_all(&current)?;
    std::fs::create_dir_all(&stale_mount)?;
    std::fs::create_dir_all(&mounted_source)?;
    std::fs::write(mounted_source.join("keep"), b"mounted-data")?;
    let request = ReusePreparationRequest {
        current_runtime_dir: path_string(&current),
    };

    let output = run_helper_with_bind_mount(&request, &mounted_source, &stale_mount).await?;

    assert_mount_boundary_failure(&output);
    assert!(current.exists());
    assert!(runs.join("stale").exists());
    assert_eq!(std::fs::read(mounted_source.join("keep"))?, b"mounted-data");
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_missing_containment_capability() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::remove_file(containment.base.join("cgroup.kill"))?;

    let output = run_helper_with_containment(&request, &containment).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_stale_operation_cgroup() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::create_dir(containment.base.join("exec-stale"))?;

    let output = run_helper_with_containment(&request, &containment).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_missing_current_operation_cgroup() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::remove_dir_all(containment.base.join("exec-current"))?;

    let output = run_helper_with_containment(&request, &containment).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_unpopulated_exec_cgroup() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::write(containment.base.join("cgroup.events"), b"populated 0\n")?;

    let output = run_helper_with_containment(&request, &containment).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_direct_processes_in_exec_base() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::write(containment.base.join("cgroup.procs"), b"42\n")?;

    let output = run_helper_with_containment(&request, &containment).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_current_process_outside_exec_base() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;

    let output =
        run_helper_with_current_group(&request, &containment, "/outside/exec-current/workload")
            .await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_missing_controller() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::write(
        containment.base.join("cgroup.subtree_control"),
        b"cpu memory\n",
    )?;

    let output = run_helper_with_containment(&request, &containment).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_missing_ancestor_memory_protection() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::write(containment.base.join("memory.min"), b"0\n")?;

    let output = run_helper_with_containment(&request, &containment).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_direct_processes_in_operation_parent() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::write(containment.base.join("exec-current/cgroup.procs"), b"42\n")?;

    let output = run_helper_with_containment(&request, &containment).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_previous_control_only_protection() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::write(
        containment.base.join("memory.min"),
        (384 * 1024 * 1024).to_string(),
    )?;

    let output = run_helper_with_containment(&request, &containment).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_populated_control_leaf() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::write(
        containment.base.join("exec-current/control/cgroup.events"),
        b"populated 1\n",
    )?;

    let output = run_helper_with_containment(&request, &containment).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_nested_workload_cgroup() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::create_dir(containment.base.join("exec-current/workload/unexpected"))?;

    let output = run_helper_with_containment(&request, &containment).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_stale_workload_pid_limit() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::write(
        containment.base.join("exec-current/workload/pids.max"),
        b"2048\n",
    )?;

    let output = run_helper_with_containment(&request, &containment).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_stale_workload_memory_high() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    let policy =
        WorkloadResourcePolicy::for_current_guest_capacity(false).map_err(std::io::Error::other)?;
    let legacy_memory_high = policy
        .memory_max_bytes
        .checked_sub(256 * 1024 * 1024)
        .ok_or_else(|| {
            std::io::Error::other("test Guest is below the retired memory.high policy")
        })?;
    std::fs::write(
        containment.base.join("exec-current/workload/memory.high"),
        legacy_memory_high.to_string(),
    )?;

    let output = run_helper_with_containment(&request, &containment).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_stale_workload_memory_max() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    let policy =
        WorkloadResourcePolicy::for_current_guest_capacity(false).map_err(std::io::Error::other)?;
    // The retired policy reserved 384 MiB regardless of today's control floor.
    let retired_reserve_delta = 384 * 1024 * 1024 - WORKLOAD_MEMORY_RESERVE_BYTES;
    let legacy_memory_max = policy
        .memory_max_bytes
        .checked_sub(retired_reserve_delta)
        .ok_or_else(|| {
            std::io::Error::other("test Guest is below the retired memory.max policy")
        })?;
    std::fs::write(
        containment.base.join("exec-current/workload/memory.max"),
        legacy_memory_max.to_string(),
    )?;

    let output = run_helper_with_containment(&request, &containment).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_stale_workload_oom_group() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::write(
        containment
            .base
            .join("exec-current/workload/memory.oom.group"),
        b"1\n",
    )?;

    let output = run_helper_with_containment(&request, &containment).await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[tokio::test]
async fn prepare_for_reuse_rejects_helper_in_control_leaf() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;

    let output =
        run_helper_with_current_group(&request, &containment, "/vm0-exec/exec-current/control")
            .await?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

pub(super) struct ContainmentFixture {
    _directory: tempfile::TempDir,
    pub(super) root: PathBuf,
    pub(super) base: PathBuf,
}

impl ContainmentFixture {
    pub(super) fn new() -> TestResult<Self> {
        let directory = tempfile::tempdir()?;
        let root = directory.path().join("cgroup");
        let base = root.join("vm0-exec");
        std::fs::create_dir_all(&base)?;
        for (filename, content) in [
            ("cgroup.controllers", "cpu memory pids\n"),
            ("cgroup.procs", ""),
            ("cgroup.events", "populated 1\nfrozen 0\n"),
            ("cgroup.kill", ""),
            ("cgroup.subtree_control", "cpu memory pids\n"),
        ] {
            std::fs::write(base.join(filename), content)?;
        }
        std::fs::write(base.join("memory.min"), AGENT_MEMORY_MIN_BYTES.to_string())?;
        let operation = base.join("exec-current");
        std::fs::create_dir(&operation)?;
        for (filename, content) in [
            ("cgroup.controllers", "cpu memory pids\n"),
            ("cgroup.procs", ""),
            ("cgroup.events", "populated 1\nfrozen 0\n"),
            ("cgroup.kill", ""),
            ("cgroup.subtree_control", "cpu memory pids\n"),
        ] {
            std::fs::write(operation.join(filename), content)?;
        }
        for (leaf, populated) in [("control", "0"), ("workload", "1")] {
            let leaf = operation.join(leaf);
            std::fs::create_dir(&leaf)?;
            for (filename, content) in [
                ("cgroup.procs", ""),
                (
                    "cgroup.events",
                    if populated == "1" {
                        "populated 1\nfrozen 0\n"
                    } else {
                        "populated 0\nfrozen 0\n"
                    },
                ),
                ("cgroup.kill", ""),
                ("cgroup.subtree_control", ""),
            ] {
                std::fs::write(leaf.join(filename), content)?;
            }
        }
        let policy = WorkloadResourcePolicy::for_current_guest_capacity(false)
            .map_err(std::io::Error::other)?;
        let workload = operation.join("workload");
        for (filename, value) in [
            (
                "cpu.max",
                format!("{} {}", policy.cpu_quota_us, policy.cpu_period_us),
            ),
            ("memory.high", policy.memory_high.to_string()),
            ("memory.max", policy.memory_max_bytes.to_string()),
            ("memory.oom.group", policy.memory_oom_group.to_string()),
            ("pids.max", policy.pids_max.to_string()),
        ] {
            std::fs::write(workload.join(filename), value)?;
        }
        Ok(Self {
            _directory: directory,
            root,
            base,
        })
    }
}

#[tokio::test]
async fn prepare_for_cache_removes_completed_private_state_and_preserves_user_history() -> TestResult
{
    let home = tempfile::tempdir()?;
    let runs = guest_contracts::runtime_paths::runtime_parent_for_home(home.path());
    let current = runs.join("current");
    let stale = runs.join("stale");
    for runtime in [&current, &stale] {
        for name in [
            "user-env/env.json",
            "run-payload/payload.json",
            "connector-account-context/context.json",
            "pi-launch-payload/payload.json",
            "logs/agent.jsonl",
            "telemetry/system-log.pos",
            "claude-append-system-prompt",
            "failure-diagnostic.json",
        ] {
            let path = runtime.join(name);
            std::fs::create_dir_all(path.parent().unwrap())?;
            std::fs::write(path, b"synthetic private input")?;
        }
    }
    let codex_home = home.path().join(".codex");
    std::fs::create_dir_all(codex_home.join("sessions"))?;
    std::fs::write(codex_home.join("auth.json"), b"synthetic managed auth")?;
    std::fs::write(codex_home.join("sessions/keep.jsonl"), b"history")?;
    let outside = home.path().join("workspace/user-file");
    std::fs::create_dir_all(outside.parent().unwrap())?;
    std::fs::write(&outside, b"user file")?;
    symlink(&outside, runs.join("stale-link"))?;
    let output = run_cache_helper(
        &ReusePreparationRequest {
            current_runtime_dir: path_string(&current),
        },
        &runs,
        &codex_home,
        None,
    )
    .await?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: ReusePreparationReport = serde_json::from_slice(&output.stdout)?;
    assert_eq!(report.removed_entries, 3);
    assert_eq!(std::fs::read_dir(&runs)?.count(), 0);
    assert!(!codex_home.join("auth.json").exists());
    assert_eq!(
        std::fs::read(codex_home.join("sessions/keep.jsonl"))?,
        b"history"
    );
    assert_eq!(std::fs::read(&outside)?, b"user file");
    Ok(())
}

#[tokio::test]
async fn prepare_for_cache_scrubs_private_state_when_current_runtime_was_never_created()
-> TestResult {
    for existing_runtime_parent in [true, false] {
        let home = tempfile::tempdir()?;
        let runs = guest_contracts::runtime_paths::runtime_parent_for_home(home.path());
        let current = runs.join("unstarted");
        if existing_runtime_parent {
            let stale = runs.join("previous/user-env/env.json");
            std::fs::create_dir_all(stale.parent().ok_or("missing stale parent")?)?;
            std::fs::write(stale, b"old private environment")?;
        }
        let codex_home = home.path().join(".codex");
        std::fs::create_dir_all(codex_home.join("sessions"))?;
        std::fs::write(codex_home.join("auth.json"), b"managed synthetic auth")?;
        std::fs::write(codex_home.join("sessions/keep.jsonl"), b"native history")?;
        let user_file = home.path().join("workspace/user-file");
        std::fs::create_dir_all(user_file.parent().ok_or("missing workspace parent")?)?;
        std::fs::write(&user_file, b"ordinary user bytes")?;
        assert!(!current.exists());

        let output = run_cache_helper(
            &ReusePreparationRequest {
                current_runtime_dir: path_string(&current),
            },
            &runs,
            &codex_home,
            None,
        )
        .await?;
        assert!(
            output.status.success(),
            "existing runtime parent: {existing_runtime_parent}; {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: ReusePreparationReport = serde_json::from_slice(&output.stdout)?;
        assert_eq!(report.removed_entries, u64::from(existing_runtime_parent));
        assert!(report.home.available_bytes > 0);
        assert!(report.home.available_inodes > 0);
        assert!(!current.exists());
        if existing_runtime_parent {
            assert_eq!(std::fs::read_dir(&runs)?.count(), 0);
        } else {
            assert!(!runs.exists());
        }
        assert!(!codex_home.join("auth.json").exists());
        assert_eq!(
            std::fs::read(codex_home.join("sessions/keep.jsonl"))?,
            b"native history"
        );
        assert_eq!(std::fs::read(&user_file)?, b"ordinary user bytes");
    }
    Ok(())
}

#[tokio::test]
async fn prepare_for_cache_rejects_arbitrary_parent_and_unsafe_current_before_mutation()
-> TestResult {
    let home = tempfile::tempdir()?;
    let runs = guest_contracts::runtime_paths::runtime_parent_for_home(home.path());
    let current = runs.join("current");
    let codex_home = home.path().join(".codex");
    std::fs::create_dir_all(&current)?;
    std::fs::create_dir_all(&codex_home)?;
    std::fs::write(current.join("keep"), b"private")?;
    std::fs::write(codex_home.join("auth.json"), b"auth")?;
    let unsafe_current = runs.join("unsafe-current");
    symlink(home.path().join("missing-target"), &unsafe_current)?;
    for (request, code) in [
        (
            ReusePreparationRequest {
                current_runtime_dir: path_string(&home.path().join("workspace")),
            },
            REUSE_PREPARATION_EXIT_INVALID_REQUEST,
        ),
        (
            ReusePreparationRequest {
                current_runtime_dir: path_string(&unsafe_current),
            },
            REUSE_PREPARATION_EXIT_CLEANUP_FAILED,
        ),
    ] {
        let output = run_cache_helper(&request, &runs, &codex_home, None).await?;
        assert_eq!(output.status.code(), Some(code));
        assert_eq!(std::fs::read(current.join("keep"))?, b"private");
        assert_eq!(std::fs::read(codex_home.join("auth.json"))?, b"auth");
    }
    Ok(())
}

#[tokio::test]
async fn prepare_for_cache_rejects_live_writers_and_unsafe_auth() -> TestResult {
    let home = tempfile::tempdir()?;
    let runs = guest_contracts::runtime_paths::runtime_parent_for_home(home.path());
    let current = runs.join("current");
    let codex_home = home.path().join(".codex");
    std::fs::create_dir_all(&current)?;
    std::fs::create_dir_all(&codex_home)?;
    std::fs::write(current.join("keep"), b"private")?;
    let target = home.path().join("user-auth");
    std::fs::write(&target, b"user auth")?;
    symlink(&target, codex_home.join("auth.json"))?;
    let request = ReusePreparationRequest {
        current_runtime_dir: path_string(&current),
    };
    let containment = ContainmentFixture::new()?;
    std::fs::create_dir(containment.base.join("exec-live"))?;
    let output = run_cache_helper(&request, &runs, &codex_home, Some(&containment)).await?;
    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    let output = run_cache_helper(&request, &runs, &codex_home, None).await?;
    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED)
    );
    assert_eq!(std::fs::read(current.join("keep"))?, b"private");
    assert_eq!(std::fs::read(&target)?, b"user auth");
    Ok(())
}

async fn run_cache_helper(
    request: &ReusePreparationRequest,
    runtime_parent: &Path,
    codex_home: &Path,
    containment: Option<&ContainmentFixture>,
) -> TestResult<Output> {
    let owned;
    let containment = if let Some(containment) = containment {
        containment
    } else {
        owned = ContainmentFixture::new()?;
        &owned
    };
    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    command
        .env_clear()
        .env("OKOU_TEST_PROCESS_CONTAINMENT_ROOT", &containment.root)
        .env(
            "OKOU_TEST_PROCESS_CONTAINMENT_CURRENT_GROUP",
            "/vm0-exec/exec-current/workload",
        )
        .env("OKOU_TEST_CODEX_HOME_DIR", codex_home)
        .env("OKOU_TEST_CACHE_RUNTIME_PARENT", runtime_parent)
        .env(
            "OKOU_TEST_HOME_CAPACITY_ROOT",
            codex_home
                .parent()
                .ok_or("fixture Codex home has no parent")?,
        )
        .arg("prepare-for-cache");
    Ok(common::command_output_with_stdin_timeout(
        &mut command,
        &serde_json::to_vec(request)?,
        REUSE_PREPARATION_HELPER_TIMEOUT,
        "terminal cache helper exceeded its test budget",
    )
    .await?)
}

fn reusable_request() -> TestResult<(ReusePreparationRequest, tempfile::TempDir)> {
    let runtime = tempfile::tempdir()?;
    let current = runtime.path().join("runs/current");
    std::fs::create_dir_all(&current)?;
    Ok((
        ReusePreparationRequest {
            current_runtime_dir: path_string(&current),
        },
        runtime,
    ))
}

async fn run_helper(
    request: &ReusePreparationRequest,
) -> Result<Output, Box<dyn std::error::Error>> {
    let containment = ContainmentFixture::new()?;
    run_helper_with_containment(request, &containment).await
}

async fn run_helper_with_containment(
    request: &ReusePreparationRequest,
    containment: &ContainmentFixture,
) -> Result<Output, Box<dyn std::error::Error>> {
    run_helper_with_current_group(request, containment, "/vm0-exec/exec-current/workload").await
}

async fn run_helper_with_current_group(
    request: &ReusePreparationRequest,
    containment: &ContainmentFixture,
    current_group: &str,
) -> Result<Output, Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    run_helper_with_current_group_and_codex_home(
        request,
        containment,
        current_group,
        &home.path().join(".codex"),
    )
    .await
}

async fn run_helper_with_codex_home(
    request: &ReusePreparationRequest,
    codex_home: &Path,
) -> Result<Output, Box<dyn std::error::Error>> {
    let containment = ContainmentFixture::new()?;
    run_helper_with_current_group_and_codex_home(
        request,
        &containment,
        "/vm0-exec/exec-current/workload",
        codex_home,
    )
    .await
}

async fn run_helper_with_current_group_and_codex_home(
    request: &ReusePreparationRequest,
    containment: &ContainmentFixture,
    current_group: &str,
    codex_home: &Path,
) -> Result<Output, Box<dyn std::error::Error>> {
    let home_capacity_root = codex_home
        .parent()
        .ok_or_else(|| std::io::Error::other("fixture Codex home has no parent"))?;
    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    command
        .env_clear()
        .env("OKOU_TEST_PROCESS_CONTAINMENT_ROOT", &containment.root)
        .env("OKOU_TEST_PROCESS_CONTAINMENT_CURRENT_GROUP", current_group)
        .env("OKOU_TEST_CODEX_HOME_DIR", codex_home)
        .env("OKOU_TEST_HOME_CAPACITY_ROOT", home_capacity_root)
        .arg("prepare-for-reuse");
    let request = serde_json::to_vec(request)?;
    Ok(common::command_output_with_stdin_timeout(
        &mut command,
        &request,
        REUSE_PREPARATION_HELPER_TIMEOUT,
        "guest-agent prepare-for-reuse exceeded its test budget",
    )
    .await?)
}

async fn run_helper_with_bind_mount(
    request: &ReusePreparationRequest,
    mount_source: &Path,
    mount_target: &Path,
) -> Result<Output, Box<dyn std::error::Error>> {
    let containment = ContainmentFixture::new()?;
    let home = tempfile::tempdir()?;
    let mut command = Command::new("/usr/bin/unshare");
    command
        .env_clear()
        .env("OKOU_TEST_PROCESS_CONTAINMENT_ROOT", &containment.root)
        .env(
            "OKOU_TEST_PROCESS_CONTAINMENT_CURRENT_GROUP",
            "/vm0-exec/exec-current/workload",
        )
        .env("OKOU_TEST_CODEX_HOME_DIR", home.path().join(".codex"))
        .env("OKOU_TEST_HOME_CAPACITY_ROOT", home.path())
        .env("OKOU_MOUNT_SOURCE", mount_source)
        .env("OKOU_MOUNT_TARGET", mount_target)
        .env("OKOU_HELPER", env!("CARGO_BIN_EXE_guest-agent"))
        .args([
            "--user",
            "--map-root-user",
            "--mount",
            "/bin/sh",
            "-c",
            "/usr/bin/mount --bind \"$OKOU_MOUNT_SOURCE\" \"$OKOU_MOUNT_TARGET\" && exec \"$OKOU_HELPER\" prepare-for-reuse",
        ]);
    let request = serde_json::to_vec(request)?;
    Ok(common::command_output_with_stdin_timeout(
        &mut command,
        &request,
        REUSE_PREPARATION_HELPER_TIMEOUT,
        "bind-mounted guest-agent prepare-for-reuse exceeded its test budget",
    )
    .await?)
}

fn find_existing_same_filesystem_nested_mount() -> TestResult<Option<PathBuf>> {
    for candidate in ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys"] {
        let path = Path::new(candidate);
        let Some(parent) = path.parent() else {
            continue;
        };
        if !path.is_dir() {
            continue;
        }
        let parent_identity = path_mount_identity(parent)?;
        let candidate_identity = path_mount_identity(path)?;
        if parent_identity.0 == candidate_identity.0 && parent_identity.1 != candidate_identity.1 {
            return Ok(Some(path.to_path_buf()));
        }
    }
    Ok(None)
}

fn path_mount_identity(path: &Path) -> TestResult<(u64, u64)> {
    let file = File::open(path)?;
    let device = file.metadata()?.dev();
    let fdinfo = std::fs::read_to_string(format!("/proc/self/fdinfo/{}", file.as_raw_fd()))?;
    let mount_id = fdinfo
        .lines()
        .find_map(|line| line.strip_prefix("mnt_id:"))
        .ok_or_else(|| std::io::Error::other("mount identity is unavailable"))?
        .trim()
        .parse()?;
    Ok((device, mount_id))
}

fn assert_mount_boundary_failure(output: &Output) {
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED),
        "stdout={}, stderr={stderr}",
        String::from_utf8_lossy(&output.stdout),
    );
    assert!(
        stderr.contains("mount or filesystem boundary"),
        "unexpected stderr: {stderr}"
    );
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
