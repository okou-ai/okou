#![cfg(target_os = "linux")]

use std::path::Path;
use std::process::Output;
use std::time::Duration;

use guest_contracts::home_cache_history::TerminalHomeCachePreparationReport;
use guest_contracts::reuse_preparation::{
    REUSE_PREPARATION_EXIT_CLEANUP_FAILED, ReusePreparationReport, ReusePreparationRequest,
};
use guest_contracts::session_history_identity::{
    SessionHistoryFramework, SessionHistoryIdentity, SessionHistoryRefKind, SessionHistorySourceRef,
};
use sha2::{Digest, Sha256};
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
    "$OKOU_HOME/.vm0/guest-agent/runs/retained" \
    "$OKOU_HOME/.vm0/guest-agent/runs/stale" \
    "$OKOU_HOME/.vm0/home-cache" "$OKOU_HOME/.codex/sessions" \
    "$OKOU_HOME/.claude/projects/-home-user-workspace" \
    "$OKOU_HOME/.npm/_cacache" "$OKOU_HOME/.npm/_logs" \
    "$OKOU_HOME/.npm/_npx/tool" "$OKOU_HOME/.cache/ms-playwright" \
    "$OKOU_HOME/.cache/uv/archive-v0/package" "$OKOU_HOME/workspace"
printf '%s' "$OKOU_METADATA" > "$OKOU_HOME/.vm0/guest-agent/runs/current/final-session-history-identity.json"
printf reader > "$OKOU_HOME/.vm0/guest-agent/runs/retained/reader"
printf history > "$OKOU_HOME/.claude/projects/-home-user-workspace/session-1.jsonl"
printf session > "$OKOU_HOME/.codex/sessions/keep.jsonl"
printf auth > "$OKOU_HOME/.codex/auth.json"
printf keep > "$OKOU_HOME/workspace/keep"
printf installed > "$OKOU_HOME/.npm/_npx/tool/index.js"
printf browser > "$OKOU_HOME/.cache/ms-playwright/browser"
printf package > "$OKOU_HOME/.cache/uv/archive-v0/package/module.py"
ln -s "$OKOU_HOME/.cache/uv/archive-v0/package" "$OKOU_HOME/workspace/installed"
printf cache > "$OKOU_HOME/.npm/_cacache/payload"
"$OKOU_HELPER" verify-session-history-identity "$OKOU_HOME/.vm0/guest-agent/runs/current/final-session-history-identity.json"
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
        printf stale > "$OKOU_HOME/.vm0/home-cache/session-history-proof.json"
        dd if=/dev/zero of="$OKOU_HOME/workspace/large-output" bs=1M count=96 2>/dev/null
        dd if=/dev/zero of="$OKOU_HOME/.npm/_cacache/payload" bs=1M count=4 2>/dev/null
        ;;
    runtime)
        dd if=/dev/zero of="$OKOU_HOME/.vm0/guest-agent/runs/stale/output" bs=1M count=96 2>/dev/null
        ;;
    proof-boundary)
        available=$(stat -f -c %a "$OKOU_HOME")
        auth=$(stat -c %b "$OKOU_HOME/.codex/auth.json")
        current=$(stat -c %b "$OKOU_HOME/.vm0/guest-agent/runs/current/final-session-history-identity.json")
        retained=$(stat -c %b "$OKOU_HOME/.vm0/guest-agent/runs/retained/reader")
        # Managed cleanup leaves exactly 64 MiB. Proof persistence then uses
        # one block, so the final capacity check must still reclaim the cache.
        released=$(((auth+current+retained)*512/4096))
        count=$((available-16384+released))
        dd if=/dev/zero of="$OKOU_HOME/workspace/large-output" bs=4096 count="$count" 2>/dev/null
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
    test "$status" -eq 4
    test -s "$OKOU_HOME/.npm/_cacache/payload"
    exit "$status"
fi
test "$status" -eq 0
case "$OKOU_PRESSURE" in
    healthy|runtime) test -f "$OKOU_HOME/.npm/_cacache/payload" ;;
    *) test ! -e "$OKOU_HOME/.npm/_cacache/payload" ;;
esac
if [ "$OKOU_PREPARATION" = prepare-for-reuse ]; then
    test -f "$OKOU_HOME/.vm0/guest-agent/runs/current/final-session-history-identity.json"
    test "$(cat "$OKOU_HOME/.vm0/guest-agent/runs/retained/reader")" = reader
else
    test ! -e "$OKOU_HOME/.vm0/guest-agent/runs/current"
    test ! -e "$OKOU_HOME/.vm0/guest-agent/runs/retained"
fi
test ! -e "$OKOU_HOME/.codex/auth.json"
if [ "$OKOU_PRESSURE" = insufficient ]; then
    test "$(stat -c %s "$OKOU_HOME/workspace/large-output")" -eq 100663296
    if [ "$OKOU_PREPARATION" = prepare-for-cache ]; then
        test ! -e "$OKOU_HOME/.vm0/home-cache/session-history-proof.json"
    fi
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
    let retained = home.join(".vm0/guest-agent/runs/retained");
    let request = ReusePreparationRequest {
        current_runtime_dir: current.to_string_lossy().into_owned(),
        retained_runtime_dir: Some(retained.to_string_lossy().into_owned()),
    };
    let identity = history_identity(home)?;
    let request = if terminal {
        serde_json::to_vec(
            &guest_contracts::home_cache_history::TerminalHomeCachePreparationRequest {
                current_runtime_dir: request.current_runtime_dir,
                retained_runtime_dir: request.retained_runtime_dir,
                generation: "74b68da0-6e0a-4adc-a68e-65a04c4885c4".into(),
            },
        )?
    } else {
        serde_json::to_vec(&request)?
    };
    let mut command = Command::new("/usr/bin/unshare");
    command
        .env_clear()
        .current_dir(root.path())
        .env("PATH", "/usr/bin:/bin")
        .env("OKOU_HOME", home)
        .env("OKOU_FIXTURE_HOME", &mounted_home)
        .env("OKOU_ORIGINAL_HOME", &original_home)
        .env("OKOU_METADATA", String::from_utf8(identity.to_json_vec()?)?)
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
        .env(
            "OKOU_TEST_HOME_CACHE_HISTORY_PROOF_PATH",
            home.join(".vm0/home-cache/session-history-proof.json"),
        )
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

fn history_identity(home: &Path) -> TestResult<SessionHistoryIdentity> {
    Ok(SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(b"session-1")),
        SessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(b"history")),
        7,
        SessionHistorySourceRef::ClaudeCode {
            config_dir: home.join(".claude").to_string_lossy().into_owned(),
            working_dir: "/home/user/workspace".into(),
            session_id: "session-1".into(),
        },
    )?)
}

fn report(output: &Output, terminal: bool, usable: bool) -> TestResult<ReusePreparationReport> {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    if terminal {
        let report: TerminalHomeCachePreparationReport = serde_json::from_slice(&output.stdout)?;
        assert_eq!(report.history_proof.is_some(), usable);
        if let Some(proof) = report.history_proof {
            proof.validate()?;
            assert_eq!(
                proof.proof.generation,
                "74b68da0-6e0a-4adc-a68e-65a04c4885c4"
            );
        }
        Ok(report.cleanup)
    } else {
        Ok(serde_json::from_slice(&output.stdout)?)
    }
}

#[tokio::test]
#[ignore = "requires mount namespaces; selected by guest-home-cleanup-test CI"]
async fn exhausted_home_recovers_bytes_inodes_and_terminal_proof() -> TestResult {
    for terminal in [false, true] {
        for pressure in ["bytes", "inodes", "both"] {
            let output = run_preparation(pressure, terminal).await?;
            let report = report(&output, terminal, true)?;
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
            assert_eq!(
                report(&output, terminal, true)?
                    .home
                    .home_rejection_reason(),
                None
            );
        }
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires mount namespaces; selected by guest-home-cleanup-test CI"]
async fn terminal_proof_writes_are_included_in_the_final_capacity_check() -> TestResult {
    let output = run_preparation("proof-boundary", true).await?;
    assert_eq!(
        report(&output, true, true)?.home.home_rejection_reason(),
        None
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires mount namespaces; selected by guest-home-cleanup-test CI"]
async fn insufficient_reclamation_reports_unusable_home_and_retains_outputs() -> TestResult {
    for terminal in [false, true] {
        let output = run_preparation("insufficient", terminal).await?;
        assert_eq!(
            report(&output, terminal, false)?
                .home
                .home_rejection_reason(),
            Some("home_low_bytes")
        );
    }
    Ok(())
}

#[tokio::test]
#[ignore = "requires mount namespaces; selected by guest-home-cleanup-test CI"]
async fn unsafe_pressure_cleanup_rejects_preparation_without_widening_deletion() -> TestResult {
    for terminal in [false, true] {
        let output = run_preparation("unsafe", terminal).await?;
        assert_eq!(
            output.status.code(),
            Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.is_empty());
    }
    Ok(())
}
