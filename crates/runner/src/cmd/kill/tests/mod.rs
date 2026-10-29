use std::cell::{Cell, RefCell};
use std::path::Path;

use sandbox::{SandboxControlError, SandboxControlTarget};
use sandbox_mock::MockSandboxControl;

use super::test_support::{discovered_with_firecrackers, make_target};
use super::*;

fn empty_process_discovery(proc_scan_complete: bool) -> process::ProcessDiscovery {
    process::ProcessDiscovery {
        processes: discovered_with_firecrackers(vec![]),
        proc_scan_complete,
    }
}

fn make_target_at_base(pid: u32, sandbox_id: &str, base_dir: &Path) -> KillTarget {
    let mut target = make_target(pid, sandbox_id);
    target.base_dir = Some(base_dir.to_path_buf());
    target
}

fn orphan_already_exited(target: KillTarget) -> std::future::Ready<OrphanOutcome> {
    std::future::ready(OrphanOutcome::AlreadyExited(target))
}

#[tokio::test]
async fn owner_response_releases_unused_callbacks_and_preserves_cleanup_paths() {
    for (index, response) in [
        RemoteKillResult::Accepted,
        RemoteKillResult::AlreadyStopped,
        RemoteKillResult::RefusedIdle,
    ]
    .into_iter()
    .enumerate()
    {
        let workspace_base = tempfile::tempdir().unwrap();
        let socket_base = tempfile::tempdir().unwrap();
        let control = MockSandboxControl::new(socket_base.path());
        control.push_kill_remote_result(Ok(response));
        let target = make_target_at_base(200, "owner-response", workspace_base.path());
        let workspace = workspace_base.path().join("workspaces/owner-response");
        let socket_dir = control.runtime_dir("owner-response");
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        tokio::fs::create_dir_all(&socket_dir).await.unwrap();

        // Real sockets make release of the unused callback captures observable.
        let sockets: [std::net::TcpListener; 4] =
            std::array::from_fn(|_| std::net::TcpListener::bind("127.0.0.1:0").unwrap());
        let addresses = sockets
            .each_ref()
            .map(|socket| socket.local_addr().unwrap());
        let [
            rediscovery_socket,
            classification_socket,
            termination_socket,
            discovery_socket,
        ] = sockets;
        let called = &Cell::new(0_u8);
        let outcome = kill_current_target_with_orphan_fallback(
            target.clone(),
            false,
            &control,
            move || {
                called.set(called.get() | 1);
                drop(rediscovery_socket);
                std::future::ready(Err(RediscoverTargetError::Resolve("unused".into())))
            },
            move |_, _| {
                called.set(called.get() | 2);
                drop(classification_socket);
                std::future::ready(false)
            },
            move |target| {
                called.set(called.get() | 4);
                drop(termination_socket);
                std::future::ready(OrphanOutcome::SignalFailed(target))
            },
            move || {
                called.set(called.get() | 8);
                drop(discovery_socket);
                std::future::ready(empty_process_discovery(false))
            },
        )
        .await;

        assert!(matches!(
            (&outcome, index),
            (KillOutcome::OwnerAccepted(RemoteKillResult::Accepted), 0)
                | (
                    KillOutcome::OwnerAccepted(RemoteKillResult::AlreadyStopped),
                    1
                )
                | (KillOutcome::RefusedManagedIdle, 2)
        ));
        assert_eq!(called.get(), 0);
        let _rebound = addresses.map(|address| std::net::TcpListener::bind(address).unwrap());
        let exit_code = finish_kill_outcome(&target, &target, &outcome, &control).await;
        assert_eq!(
            exit_code,
            if index == 2 {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            }
        );
        assert!(workspace.exists());
        assert!(socket_dir.exists());
    }
}

#[test]
fn run_scoped_target_refuses_orphan_fallback() {
    assert!(should_refuse_orphan_fallback(Some("run-full-id")));
}

#[test]
fn sandbox_scoped_target_allows_orphan_fallback() {
    assert!(!should_refuse_orphan_fallback(None));
}

#[tokio::test]
async fn managed_target_requests_owner_control() {
    let control = MockSandboxControl::new("/tmp/test");
    let current = make_target(200, "sbox-123");

    let outcome = kill_current_target(current, false, &control).await;

    assert!(matches!(
        outcome,
        KillOutcome::OwnerAccepted(RemoteKillResult::Accepted)
    ));
    assert_eq!(
        control.recorded_kill_targets(),
        vec![SandboxControlTarget::sandbox("sbox-123")]
    );
}

#[tokio::test]
async fn managed_run_target_preserves_full_run_identity() {
    let control = MockSandboxControl::new("/tmp/test");
    let mut current = make_target(200, "sbox-123");
    current.run_id = Some("run-full-id".into());

    let outcome = kill_current_target(current, false, &control).await;

    assert!(matches!(
        outcome,
        KillOutcome::OwnerAccepted(RemoteKillResult::Accepted)
    ));
    assert_eq!(
        control.recorded_kill_targets(),
        vec![SandboxControlTarget::run("run-full-id", "sbox-123")]
    );
}

#[tokio::test]
async fn managed_idle_target_is_refused() {
    let control = MockSandboxControl::new("/tmp/test");
    control.push_kill_remote_result(Ok(RemoteKillResult::RefusedIdle));
    let current = make_target(200, "sbox-123");

    let outcome = kill_current_target(current, false, &control).await;

    assert!(matches!(outcome, KillOutcome::RefusedManagedIdle));
    assert_eq!(
        control.recorded_kill_targets(),
        vec![SandboxControlTarget::sandbox("sbox-123")]
    );
}

#[tokio::test]
async fn apparent_orphan_prefers_owner_control_when_available() {
    let control = MockSandboxControl::new("/tmp/test");
    let current = make_target(200, "sbox-123");

    let outcome = kill_current_target(current, true, &control).await;

    assert!(matches!(
        outcome,
        KillOutcome::OwnerAccepted(RemoteKillResult::Accepted)
    ));
    assert_eq!(
        control.recorded_kill_targets(),
        vec![SandboxControlTarget::sandbox("sbox-123")]
    );
}

// A CLI test cannot safely construct this post-control race without a real
// Firecracker process and owning runner, so inject only those OS boundaries.
#[tokio::test]
async fn managed_target_refuses_orphan_fallback_after_owner_control_failure() {
    let workspace_base = tempfile::tempdir().unwrap();
    let socket_base = tempfile::tempdir().unwrap();
    let control = MockSandboxControl::new(socket_base.path());
    control.push_kill_remote_result(Err(SandboxControlError::Connection(
        "owner unavailable".into(),
    )));
    let target = make_target_at_base(
        i32::MAX as u32 - 2_000,
        "sandbox-managed-full-id",
        workspace_base.path(),
    );
    let workspace = workspace_base
        .path()
        .join("workspaces/sandbox-managed-full-id");
    let socket_dir = control.runtime_dir("sandbox-managed-full-id");
    tokio::fs::create_dir_all(&workspace).await.unwrap();
    tokio::fs::create_dir_all(&socket_dir).await.unwrap();
    let runner_pids = vec![101, 202];
    let refreshed = ResolvedKillTarget {
        target: target.clone(),
        runner_pids: runner_pids.clone(),
    };
    let classifier_input = RefCell::new(None);
    let termination_called = Cell::new(false);
    let discovery_called = Cell::new(false);

    let outcome = kill_current_target_with_orphan_fallback(
        target.clone(),
        false,
        &control,
        || std::future::ready(Ok(refreshed)),
        |pid, runner_pids| {
            classifier_input.replace(Some((pid, runner_pids)));
            std::future::ready(false)
        },
        |target| {
            termination_called.set(true);
            orphan_already_exited(target)
        },
        || {
            discovery_called.set(true);
            std::future::ready(empty_process_discovery(true))
        },
    )
    .await;

    match &outcome {
        KillOutcome::RefusedManagedControlFailed(error) => {
            assert_eq!(error, "connection failed: owner unavailable")
        }
        other => panic!("expected managed control refusal, got {other:?}"),
    }
    assert_eq!(
        classifier_input.into_inner(),
        Some((target.pid, runner_pids))
    );
    assert!(!termination_called.get());
    assert!(!discovery_called.get());
    assert_eq!(
        control.recorded_kill_targets(),
        vec![SandboxControlTarget::sandbox("sandbox-managed-full-id")]
    );

    let exit_code = finish_kill_outcome(&target, &target, &outcome, &control).await;

    assert_eq!(exit_code, ExitCode::FAILURE);
    assert!(workspace.exists());
    assert!(socket_dir.exists());
}

#[tokio::test]
async fn run_target_refuses_orphan_fallback_when_rediscovery_fails() {
    let control = MockSandboxControl::new("/tmp/test");
    control.push_kill_remote_result(Err(SandboxControlError::NotFound("missing".into())));
    let mut current = make_target(i32::MAX as u32 - 2_000, "sbox-123");
    current.run_id = Some("run-full-id".into());
    let classification_called = Cell::new(false);
    let discovery_called = Cell::new(false);

    let outcome = kill_current_target_with_orphan_fallback(
        current,
        false,
        &control,
        || {
            std::future::ready(Err(RediscoverTargetError::Resolve(
                "sandbox disappeared".into(),
            )))
        },
        |_, _| {
            classification_called.set(true);
            std::future::ready(true)
        },
        orphan_already_exited,
        || {
            discovery_called.set(true);
            std::future::ready(empty_process_discovery(true))
        },
    )
    .await;

    match outcome {
        KillOutcome::RefusedTargetChanged(reason) => {
            assert_eq!(reason, RUN_ORPHAN_FALLBACK_REFUSAL)
        }
        other => panic!("expected run-scoped fallback refusal, got {other:?}"),
    }
    assert!(!classification_called.get());
    assert!(!discovery_called.get());
    assert_eq!(
        control.recorded_kill_targets(),
        vec![SandboxControlTarget::run("run-full-id", "sbox-123")]
    );
}

#[tokio::test]
async fn run_target_refuses_orphan_fallback_after_orphan_rediscovery() {
    let control = MockSandboxControl::new("/tmp/test");
    control.push_kill_remote_result(Err(SandboxControlError::NotFound("missing".into())));
    let mut current = make_target(i32::MAX as u32 - 2_000, "sbox-123");
    current.run_id = Some("run-full-id".into());
    let refreshed = ResolvedKillTarget {
        target: current.clone(),
        runner_pids: vec![],
    };

    let outcome = kill_current_target_with_orphan_fallback(
        current,
        false,
        &control,
        || std::future::ready(Ok(refreshed)),
        |_, _| std::future::ready(true),
        orphan_already_exited,
        || std::future::ready(empty_process_discovery(true)),
    )
    .await;

    match outcome {
        KillOutcome::RefusedTargetChanged(reason) => {
            assert_eq!(reason, RUN_ORPHAN_FALLBACK_REFUSAL)
        }
        other => panic!("expected run-scoped fallback refusal, got {other:?}"),
    }
    assert_eq!(
        control.recorded_kill_targets(),
        vec![SandboxControlTarget::run("run-full-id", "sbox-123")]
    );
}

#[tokio::test]
async fn orphan_target_uses_current_reresolved_identity() {
    let control = MockSandboxControl::new("/tmp/test");
    control.push_kill_remote_result(Err(SandboxControlError::NotFound("missing".into())));
    let current = make_target(i32::MAX as u32 - 2_000, "sbox-123");

    let outcome = kill_current_target_with_orphan_fallback(
        current.clone(),
        true,
        &control,
        || {
            std::future::ready(Err(RediscoverTargetError::Resolve(
                "sandbox disappeared".into(),
            )))
        },
        |_, _| std::future::ready(true),
        orphan_already_exited,
        || std::future::ready(empty_process_discovery(true)),
    )
    .await;

    match outcome {
        KillOutcome::OrphanAlreadyExited(target) => assert_eq!(target, current),
        other => panic!("expected current target to be reported gone, got {other:?}"),
    }
}

#[tokio::test]
async fn orphan_target_refuses_incomplete_discovery() {
    let control = MockSandboxControl::new("/tmp/test");
    control.push_kill_remote_result(Err(SandboxControlError::NotFound("missing".into())));
    let current = make_target(i32::MAX as u32 - 2_000, "sbox-123");

    let outcome = kill_current_target_with_orphan_fallback(
        current.clone(),
        true,
        &control,
        || {
            std::future::ready(Err(RediscoverTargetError::Resolve(
                "sandbox disappeared".into(),
            )))
        },
        |_, _| std::future::ready(true),
        orphan_already_exited,
        || std::future::ready(empty_process_discovery(false)),
    )
    .await;

    match outcome {
        KillOutcome::AlreadyExitedOrChanged(target) => assert_eq!(target, current),
        other => panic!("expected incomplete discovery to be refused, got {other:?}"),
    }
}

// -----------------------------------------------------------------------
// Orphan cleanup tests (using sandbox-mock)
// -----------------------------------------------------------------------

#[tokio::test]
async fn failed_or_unconfirmed_orphan_termination_preserves_cleanup_paths() {
    let workspace_base = tempfile::tempdir().unwrap();
    let socket_base = tempfile::tempdir().unwrap();
    let control = MockSandboxControl::new(socket_base.path());
    let target = make_target_at_base(200, "sbox-123", workspace_base.path());
    let workspace = workspace_base.path().join("workspaces/sbox-123");
    let socket_dir = control.runtime_dir("sbox-123");
    tokio::fs::create_dir_all(&workspace).await.unwrap();
    tokio::fs::create_dir_all(&socket_dir).await.unwrap();
    for outcome in [
        KillOutcome::OrphanTerminationUnconfirmed {
            target: target.clone(),
            failure: OrphanExitFailure::TimedOut,
        },
        KillOutcome::SignalFailed(target.clone()),
        KillOutcome::AlreadyExitedOrChanged(target.clone()),
    ] {
        let exit_code = finish_kill_outcome(&target, &target, &outcome, &control).await;

        assert_eq!(exit_code, ExitCode::FAILURE);
        assert!(workspace.exists());
        assert!(socket_dir.exists());
    }
}

#[tokio::test]
async fn confirmed_orphan_termination_cleans_paths_and_succeeds() {
    let workspace_base = tempfile::tempdir().unwrap();
    let socket_base = tempfile::tempdir().unwrap();
    let control = MockSandboxControl::new(socket_base.path());
    let target = make_target_at_base(200, "sbox-123", workspace_base.path());
    let workspace = workspace_base.path().join("workspaces/sbox-123");
    let socket_dir = control.runtime_dir("sbox-123");
    tokio::fs::create_dir_all(&workspace).await.unwrap();
    tokio::fs::create_dir_all(&socket_dir).await.unwrap();
    let outcome = KillOutcome::OrphanKilled(target.clone());

    let exit_code = finish_kill_outcome(&target, &target, &outcome, &control).await;

    assert_eq!(exit_code, ExitCode::SUCCESS);
    assert!(!workspace.exists());
    assert!(!socket_dir.exists());
}

#[tokio::test]
async fn cleanup_failure_fails_command_and_attempts_remaining_steps() {
    let workspace_base = tempfile::tempdir().unwrap();
    let socket_base = tempfile::tempdir().unwrap();
    let control = MockSandboxControl::new(socket_base.path());
    let target = make_target_at_base(200, "sbox-123", workspace_base.path());
    let workspace = workspace_base.path().join("workspaces/sbox-123");
    let socket_dir = control.runtime_dir("sbox-123");
    tokio::fs::create_dir_all(workspace.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&workspace, "not a directory")
        .await
        .unwrap();
    tokio::fs::create_dir_all(&socket_dir).await.unwrap();
    let outcome = KillOutcome::OrphanKilled(target.clone());

    let exit_code = finish_kill_outcome(&target, &target, &outcome, &control).await;

    assert_eq!(exit_code, ExitCode::FAILURE);
    assert!(workspace.exists());
    assert!(
        !socket_dir.exists(),
        "socket cleanup should still run after workspace cleanup fails"
    );
}

#[tokio::test]
async fn already_exited_orphan_with_missing_paths_succeeds() {
    let workspace_base = tempfile::tempdir().unwrap();
    let socket_base = tempfile::tempdir().unwrap();
    let control = MockSandboxControl::new(socket_base.path());
    let target = make_target_at_base(200, "sbox-123", workspace_base.path());
    let outcome = KillOutcome::OrphanAlreadyExited(target.clone());

    let exit_code = finish_kill_outcome(&target, &target, &outcome, &control).await;

    assert_eq!(exit_code, ExitCode::SUCCESS);
}

#[tokio::test]
async fn cleanup_orphan_removes_workspace_and_socket_dir() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path();

    // Create workspace dir that should be cleaned up
    let workspace = base.join("workspaces").join("sbox-123");
    tokio::fs::create_dir_all(&workspace).await.unwrap();
    tokio::fs::write(workspace.join("file.txt"), "data")
        .await
        .unwrap();

    // Create socket dir via MockSandboxControl base path
    let sock_base = tempfile::tempdir().unwrap();
    let control = MockSandboxControl::new(sock_base.path());
    let sock_dir = control.runtime_dir("sbox-123");
    tokio::fs::create_dir_all(&sock_dir).await.unwrap();

    let results = cleanup_orphan("sbox-123", base, &control).await;

    assert_eq!(results.len(), 2);
    assert!(results[0].1, "workspace cleanup should succeed");
    assert!(results[1].1, "socket cleanup should succeed");
    assert!(!workspace.exists());
    assert!(!sock_dir.exists());
}

#[tokio::test]
async fn cleanup_orphan_succeeds_when_dirs_missing() {
    let workspace_base = tempfile::tempdir().unwrap();
    let sock_base = tempfile::tempdir().unwrap();
    let control = MockSandboxControl::new(sock_base.path());
    let workspace = workspace_base.path().join("workspaces").join("sbox-456");
    let sock_dir = control.runtime_dir("sbox-456");

    assert!(!workspace.exists(), "workspace should start missing");
    assert!(!sock_dir.exists(), "socket directory should start missing");

    let results = cleanup_orphan("sbox-456", workspace_base.path(), &control).await;

    // Both should "succeed" — NotFound is treated as success
    assert_eq!(results.len(), 2);
    assert!(results[0].1, "workspace cleanup should succeed");
    assert!(results[1].1, "socket cleanup should succeed");
}
