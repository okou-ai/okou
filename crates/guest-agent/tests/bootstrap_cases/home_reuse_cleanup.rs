#![cfg(target_os = "linux")]

use std::path::Path;
use std::process::Output;
use std::time::Duration;

use guest_contracts::reuse_preparation::{ReusePreparationReport, ReusePreparationRequest};
use tokio::process::Command;

use super::reuse_preparation_helper::ContainmentFixture;
use crate::common;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

// The private mount disappears when unshare exits. Assertions run while it is
// mounted; no host-global cache or filesystem capacity is changed by the test.
const PREPARE_ON_TMPFS: &str = r#"
set -eu
umask 077
/usr/bin/mount --bind /home/user "$OKOU_ORIGINAL_HOME"
/usr/bin/mount -t tmpfs -o size=128m,nr_inodes=512 tmpfs "$OKOU_FIXTURE_HOME"
/usr/bin/mount --bind "$OKOU_FIXTURE_HOME" "$OKOU_HOME"
mkdir -p "$OKOU_HOME/.vm0/guest-agent/runs/current" \
    "$OKOU_HOME/.vm0/guest-agent/runs/stale" \
    "$OKOU_HOME/.codex/sessions" \
    "$OKOU_HOME/.claude/projects/-home-user-workspace" \
    "$OKOU_HOME/.npm/_cacache" "$OKOU_HOME/.npm/_logs" \
    "$OKOU_HOME/.npm/_npx/tool" "$OKOU_HOME/.cache/ms-playwright" \
    "$OKOU_HOME/.cache/uv/archive-v0/package" "$OKOU_HOME/workspace"
printf current > "$OKOU_HOME/.vm0/guest-agent/runs/current/session-id"
printf history > "$OKOU_HOME/.claude/projects/-home-user-workspace/session-1.jsonl"
printf session > "$OKOU_HOME/.codex/sessions/keep.jsonl"
printf auth > "$OKOU_HOME/.codex/auth.json"
printf keep > "$OKOU_HOME/workspace/keep"
printf installed > "$OKOU_HOME/.npm/_npx/tool/index.js"
printf browser > "$OKOU_HOME/.cache/ms-playwright/browser"
printf package > "$OKOU_HOME/.cache/uv/archive-v0/package/module.py"
ln -s "$OKOU_HOME/.cache/uv/archive-v0/package" "$OKOU_HOME/workspace/installed"
printf cache > "$OKOU_HOME/.npm/_cacache/payload"
if [ "$OKOU_PRESSURE" = unsafe ]; then
    ln -s "$OKOU_HOME/workspace" "$OKOU_HOME/.cache/pip"
else
    mkdir -p "$OKOU_HOME/.cache/pip"
fi
case "$OKOU_PRESSURE" in
    bytes|both)
        if dd if=/dev/zero of="$OKOU_HOME/.npm/_cacache/payload" bs=1M count=128 2>/dev/null; then
            exit 1
        fi
        test "$(stat -f -c %a "$OKOU_HOME")" -eq 0
        ;;
    unsafe)
        dd if=/dev/zero of="$OKOU_HOME/.npm/_cacache/payload" bs=1M count=96 2>/dev/null
        ;;
    insufficient)
        dd if=/dev/zero of="$OKOU_HOME/workspace/large-output" bs=1M count=96 2>/dev/null
        dd if=/dev/zero of="$OKOU_HOME/.npm/_cacache/payload" bs=1M count=4 2>/dev/null
        ;;
    runtime)
        dd if=/dev/zero of="$OKOU_HOME/.vm0/guest-agent/runs/stale/output" bs=1M count=96 2>/dev/null
        ;;
esac
case "$OKOU_PRESSURE" in
    inodes|both)
        i=0
        while touch "$OKOU_HOME/.npm/_cacache/entry-$i" 2>/dev/null; do
            i=$((i+1))
        done
        test "$(stat -f -c %d "$OKOU_HOME")" -eq 0
        ;;
esac
set +e
"$OKOU_HELPER" "$OKOU_PREPARATION" > "$OKOU_REPORT"
status=$?
set -e
test "$(cat "$OKOU_HOME/workspace/keep")" = keep
test "$(cat "$OKOU_HOME/.codex/sessions/keep.jsonl")" = session
test "$(cat "$OKOU_HOME/.claude/projects/-home-user-workspace/session-1.jsonl")" = history
test "$(cat "$OKOU_HOME/.npm/_npx/tool/index.js")" = installed
test "$(cat "$OKOU_HOME/.cache/ms-playwright/browser")" = browser
test "$(cat "$OKOU_HOME/workspace/installed/module.py")" = package
if [ "$OKOU_PRESSURE" = unsafe ]; then
    test -L "$OKOU_HOME/.cache/pip"
fi
test "$status" -eq 0
case "$OKOU_PRESSURE" in
    healthy|runtime) test -f "$OKOU_HOME/.npm/_cacache/payload" ;;
    inodes) : ;; # Enough free inodes need not empty the entire cache.
    *) test ! -e "$OKOU_HOME/.npm/_cacache/payload" ;;
esac
if [ "$OKOU_PREPARATION" = prepare-for-reuse ]; then
    test -f "$OKOU_HOME/.vm0/guest-agent/runs/current/session-id"
else
    test ! -e "$OKOU_HOME/.vm0/guest-agent/runs/current"
fi
test ! -e "$OKOU_HOME/.codex/auth.json"
if [ "$OKOU_PRESSURE" = insufficient ]; then
    test "$(stat -c %s "$OKOU_HOME/workspace/large-output")" -eq 100663296
fi
cat "$OKOU_REPORT"
"#;

async fn run_preparation(pressure: &str, terminal: bool) -> TestResult<Output> {
    let root = tempfile::tempdir()?;
    let home = Path::new("/home/user");
    std::fs::create_dir_all(home)?;
    let mounted_home = root.path().join("home/user");
    let original_home = root.path().join("original-home");
    std::fs::create_dir_all(&mounted_home)?;
    std::fs::create_dir_all(&original_home)?;
    let binary = Path::new(env!("CARGO_BIN_EXE_guest-agent"));
    let helper = match binary.strip_prefix(home) {
        Ok(relative) => original_home.join(relative),
        Err(_) => binary.to_owned(),
    };
    let containment = ContainmentFixture::new()?;
    let current = home.join(".vm0/guest-agent/runs/current");
    let request = serde_json::to_vec(&ReusePreparationRequest {
        current_runtime_dir: current.to_string_lossy().into_owned(),
    })?;
    let mut command = Command::new("/usr/bin/unshare");
    command
        .env_clear()
        .current_dir(root.path())
        .env("PATH", "/usr/bin:/bin")
        .env("OKOU_HOME", home)
        .env("OKOU_FIXTURE_HOME", &mounted_home)
        .env("OKOU_ORIGINAL_HOME", &original_home)
        .env("OKOU_PRESSURE", pressure)
        .env("OKOU_REPORT", root.path().join("report.json"))
        .env("OKOU_HELPER", helper)
        .env(
            "OKOU_PREPARATION",
            if terminal {
                "prepare-for-cache"
            } else {
                "prepare-for-reuse"
            },
        )
        .env("OKOU_TEST_PROCESS_CONTAINMENT_ROOT", &containment.root)
        .env(
            "OKOU_TEST_PROCESS_CONTAINMENT_CURRENT_GROUP",
            "/vm0-exec/exec-current/workload",
        )
        .env("OKOU_TEST_CODEX_HOME_DIR", home.join(".codex"))
        .env(
            "OKOU_TEST_CACHE_RUNTIME_PARENT",
            home.join(".vm0/guest-agent/runs"),
        )
        .env("OKOU_TEST_HOME_CAPACITY_ROOT", home)
        .env("OKOU_TEST_DISK_CLEANUP_ROOT", root.path())
        .args([
            "--user",
            "--map-root-user",
            "--mount",
            "/bin/sh",
            "-c",
            PREPARE_ON_TMPFS,
        ]);
    Ok(common::command_output_with_stdin_timeout(
        &mut command,
        &request,
        Duration::from_secs(30),
        "constrained-home preparation exceeded its test budget",
    )
    .await?)
}

fn report(output: &Output) -> TestResult<ReusePreparationReport> {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(serde_json::from_slice(&output.stdout)?)
}

#[tokio::test]
#[ignore = "requires mount namespaces; selected by guest-home-cleanup-test CI"]
async fn exhausted_home_recovers_bytes_and_inodes() -> TestResult {
    for terminal in [false, true] {
        for pressure in ["bytes", "inodes", "both"] {
            let output = run_preparation(pressure, terminal).await?;
            let report = report(&output)?;
            assert_eq!(
                report.home.home_rejection_reason(),
                None,
                "{pressure}, terminal={terminal}"
            );
        }
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires mount namespaces; selected by guest-home-cleanup-test CI"]
async fn healthy_or_privately_recovered_home_retains_package_caches() -> TestResult {
    for terminal in [false, true] {
        for pressure in ["healthy", "runtime"] {
            let output = run_preparation(pressure, terminal).await?;
            assert_eq!(report(&output)?.home.home_rejection_reason(), None);
        }
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires mount namespaces; selected by guest-home-cleanup-test CI"]
async fn insufficient_reclamation_reports_unusable_home_and_retains_outputs() -> TestResult {
    for terminal in [false, true] {
        let output = run_preparation("insufficient", terminal).await?;
        assert_eq!(
            report(&output)?.home.home_rejection_reason(),
            Some("home_low_bytes")
        );
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires mount namespaces; selected by guest-home-cleanup-test CI"]
async fn sufficient_cache_reclamation_does_not_visit_an_unsafe_later_candidate() -> TestResult {
    for terminal in [false, true] {
        let output = run_preparation("unsafe", terminal).await?;
        assert_eq!(report(&output)?.home.home_rejection_reason(), None);
    }
    Ok(())
}

const RECOVER_ROOTFS_ON_TMPFS: &str = r#"
set -eu
mount -t tmpfs -o size=128m,nr_inodes=4096 tmpfs "$OKOU_FIXTURE_ROOT"
root="$OKOU_FIXTURE_ROOT"
mkdir -p "$root/home/user/workspace" "$root/tmp/nested"
chmod 1777 "$root/tmp"
printf keep > "$root/home/user/workspace/keep"
printf hidden > "$root/tmp/.hidden"
ln -s "$root/home/user" "$root/tmp/home-link"
case "$OKOU_CASE" in
    caches)
        mkdir -p "$root/var/cache/apt/archives"
        dd if=/dev/zero of="$root/var/cache/apt/archives/payload" bs=1M count=96 2>/dev/null
        ;;
    unsafe-tmp)
        rm "$root/tmp/home-link" "$root/tmp/.hidden"
        rmdir "$root/tmp/nested" "$root/tmp"
        ln -s "$root/home/user/workspace" "$root/tmp"
        dd if=/dev/zero of="$root/home/user/workspace/payload" bs=1M count=96 2>/dev/null
        ;;
    *)
        dd if=/dev/zero of="$root/tmp/nested/payload" bs=1M count=96 2>/dev/null
        if [ "$OKOU_CASE" = unsafe-cache ]; then
            mkdir "$root/var"
            ln -s "$root/home/user" "$root/var/cache"
        fi
        ;;
esac
before=$(stat -c '%d:%i:%a' "$root/tmp")
"$OKOU_HELPER" recover-disk-space rootfs
test "$(stat -c '%d:%i:%a' "$root/tmp")" = "$before"
test "$(cat "$root/home/user/workspace/keep")" = keep
case "$OKOU_CASE" in
    caches)
        test ! -e "$root/var/cache/apt/archives/payload"
        test "$(cat "$root/tmp/.hidden")" = hidden
        test -L "$root/tmp/home-link"
        ;;
    unsafe-tmp) test -s "$root/tmp/payload" ;;
    *) test ! -e "$root/tmp/nested/payload" ;;
esac
"#;

#[tokio::test]
#[ignore = "requires mount namespaces; selected by guest-home-cleanup-test CI"]
async fn rootfs_recovery_stops_at_reserve_and_isolates_unsafe_candidates() -> TestResult {
    use guest_contracts::disk_cleanup::{DiskCleanupFilesystem, DiskCleanupReport};

    for case in ["tmp", "caches", "unsafe-cache", "unsafe-tmp"] {
        let root = tempfile::tempdir()?;
        let mounted = root.path().join("fs");
        std::fs::create_dir(&mounted)?;
        let containment = ContainmentFixture::new()?;
        let mut command = Command::new("/usr/bin/unshare");
        command
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("OKOU_FIXTURE_ROOT", &mounted)
            .env("OKOU_TEST_DISK_CLEANUP_ROOT", &mounted)
            .env("OKOU_HELPER", env!("CARGO_BIN_EXE_guest-agent"))
            .env("OKOU_CASE", case)
            .env("OKOU_TEST_PROCESS_CONTAINMENT_ROOT", &containment.root)
            .env(
                "OKOU_TEST_PROCESS_CONTAINMENT_CURRENT_GROUP",
                "/vm0-exec/exec-current/workload",
            )
            .args([
                "--user",
                "--map-root-user",
                "--mount",
                "/bin/sh",
                "-c",
                RECOVER_ROOTFS_ON_TMPFS,
            ]);
        let output = common::command_output_with_stdin_timeout(
            &mut command,
            &[],
            Duration::from_secs(30),
            "private rootfs recovery exceeded its budget",
        )
        .await?;
        assert!(
            output.status.success(),
            "{case}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: DiskCleanupReport = serde_json::from_slice(&output.stdout)?;
        assert_eq!(report.filesystem, DiskCleanupFilesystem::Rootfs);
        assert!(report.available_bytes_before < 64 * 1024 * 1024, "{case}");
        assert_eq!(
            report.permits_retry(),
            case != "unsafe-tmp",
            "{case}: {report:?}"
        );
    }
    Ok(())
}
