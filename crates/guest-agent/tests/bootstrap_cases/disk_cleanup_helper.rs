#![cfg(target_os = "linux")]

use std::os::unix::fs::symlink;
use std::path::Path;
use std::process::Output;
use std::time::Duration;

use guest_contracts::disk_cleanup::{DiskCleanupFilesystem, DiskCleanupReport};
use tokio::process::Command;

use super::reuse_preparation_helper::ContainmentFixture;
use crate::common;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

fn put(root: &Path, relative: &str, content: &[u8]) -> TestResult {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().ok_or("fixture file must have a parent")?)?;
    std::fs::write(path, content)?;
    Ok(())
}

async fn run_helper(
    root: &Path,
    filesystem: DiskCleanupFilesystem,
    containment: &ContainmentFixture,
) -> TestResult<Output> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    command
        .env_clear()
        .env("OKOU_TEST_DISK_CLEANUP_ROOT", root)
        .env("OKOU_TEST_PROCESS_CONTAINMENT_ROOT", &containment.root)
        .env(
            "OKOU_TEST_PROCESS_CONTAINMENT_CURRENT_GROUP",
            "/vm0-exec/exec-current/workload",
        )
        .args(["recover-disk-space", filesystem.as_str()]);
    Ok(common::command_output_with_stdin_timeout(
        &mut command,
        &[],
        Duration::from_secs(30),
        "disk cleanup helper exceeded its test budget",
    )
    .await?)
}

#[tokio::test]
async fn home_cleanup_preserves_work_installed_tools_and_session_state() -> TestResult {
    let root = tempfile::tempdir()?;
    let containment = ContainmentFixture::new()?;
    let caches = [
        "home/user/.npm/_cacache",
        "home/user/.npm/_logs",
        "home/user/.cache/pip",
    ];
    for cache in caches {
        put(
            root.path(),
            &format!("{cache}/nested/download"),
            &[42; 1024 * 1024],
        )?;
    }
    let preserved = [
        "home/user/workspace/generated/result.zip",
        "home/user/.npm/_npx/tool/index.js",
        "home/user/.cache/ms-playwright/browser",
        "home/user/.cache/uv/archive-v0/package/module.py",
        "home/user/.codex/sessions/history.jsonl",
        "home/user/.codex/auth.json",
        "var/cache/apt/archives/package.deb",
    ];
    for path in preserved {
        put(root.path(), path, b"keep")?;
    }
    symlink(
        root.path().join("home/user/workspace"),
        root.path().join("home/user/.npm/_cacache/work-link"),
    )?;
    symlink(
        root.path().join("home/user/.cache/uv/archive-v0/package"),
        root.path().join("home/user/workspace/installed-package"),
    )?;

    let output = run_helper(root.path(), DiskCleanupFilesystem::Home, &containment).await?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: DiskCleanupReport = serde_json::from_slice(&output.stdout)?;
    assert_eq!(report.filesystem, DiskCleanupFilesystem::Home);
    assert_eq!(report.removed_entries, 4);
    for cache in caches {
        assert!(root.path().join(cache).is_dir());
        assert_eq!(std::fs::read_dir(root.path().join(cache))?.count(), 0);
    }
    for path in preserved {
        assert_eq!(std::fs::read(root.path().join(path))?, b"keep");
    }
    assert_eq!(
        std::fs::read(
            root.path()
                .join("home/user/workspace/installed-package/module.py")
        )?,
        b"keep"
    );
    Ok(())
}

#[tokio::test]
async fn rootfs_cleanup_keeps_apt_lock_and_home_caches() -> TestResult {
    let root = tempfile::tempdir()?;
    let containment = ContainmentFixture::new()?;
    for path in [
        "var/cache/apt/archives/package.deb",
        "var/cache/apt/archives/partial/download",
        "root/.cache/pip/download",
    ] {
        put(root.path(), path, b"discard")?;
    }
    for path in [
        "var/cache/apt/archives/lock",
        "home/user/.npm/_cacache/keep",
        "root/.cache/uv/archive-v0/package/module.py",
    ] {
        put(root.path(), path, b"keep")?;
    }

    let output = run_helper(root.path(), DiskCleanupFilesystem::Rootfs, &containment).await?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: DiskCleanupReport = serde_json::from_slice(&output.stdout)?;
    assert_eq!(report.filesystem, DiskCleanupFilesystem::Rootfs);
    assert_eq!(report.removed_entries, 3);
    assert_eq!(
        std::fs::read_dir(root.path().join("var/cache/apt/archives"))?.count(),
        1
    );
    assert_eq!(
        std::fs::read(root.path().join("var/cache/apt/archives/lock"))?,
        b"keep"
    );
    assert_eq!(
        std::fs::read(root.path().join("home/user/.npm/_cacache/keep"))?,
        b"keep"
    );
    assert_eq!(
        std::fs::read(
            root.path()
                .join("root/.cache/uv/archive-v0/package/module.py")
        )?,
        b"keep"
    );
    Ok(())
}

#[tokio::test]
async fn symlinked_cache_parent_rejects_cleanup_before_deletion() -> TestResult {
    let root = tempfile::tempdir()?;
    let containment = ContainmentFixture::new()?;
    put(root.path(), "home/user/.npm/_cacache/keep", b"keep")?;
    put(root.path(), "outside/pip/keep", b"keep")?;
    symlink(
        root.path().join("outside"),
        root.path().join("home/user/.cache"),
    )?;

    let output = run_helper(root.path(), DiskCleanupFilesystem::Home, &containment).await?;
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        std::fs::read(root.path().join("outside/pip/keep"))?,
        b"keep"
    );
    assert_eq!(
        std::fs::read(root.path().join("home/user/.npm/_cacache/keep"))?,
        b"keep"
    );
    Ok(())
}

#[tokio::test]
async fn concurrent_supervised_workload_preserves_caches() -> TestResult {
    let root = tempfile::tempdir()?;
    let containment = ContainmentFixture::new()?;
    put(root.path(), "home/user/.npm/_cacache/keep", b"keep")?;
    std::fs::create_dir(containment.base.join("exec-other"))?;

    let output = run_helper(root.path(), DiskCleanupFilesystem::Home, &containment).await?;
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        std::fs::read(root.path().join("home/user/.npm/_cacache/keep"))?,
        b"keep"
    );
    Ok(())
}
