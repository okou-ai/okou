use cli_test_support::child::KillAndWaitChild;
use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};

use super::*;

struct ProbeChild {
    child: KillAndWaitChild,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl ProbeChild {
    fn spawn(marker: Option<(&str, &Path)>) -> Self {
        let mut command = Command::new("cat");
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_remove(CANONICAL_RUNTIME_MARKER_ENV);
        if let Some((name, value)) = marker {
            command.env(name, value);
        }
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self {
            child: KillAndWaitChild(child),
            stdin,
            stdout,
        }
    }

    fn pid(&self) -> u32 {
        self.child.0.id()
    }

    fn assert_responds(&mut self) {
        writeln!(self.stdin, "probe").unwrap();
        self.stdin.flush().unwrap();
        let mut response = String::new();
        self.stdout.read_line(&mut response).unwrap();
        assert_eq!(response, "probe\n");
    }
}

fn marker_environment(canonical: Option<&[u8]>) -> Vec<u8> {
    let mut environ = b"UNRELATED=value\0".to_vec();
    if let Some(value) = canonical {
        environ.extend_from_slice(CANONICAL_RUNTIME_MARKER_PREFIX);
        environ.extend_from_slice(value);
        environ.push(0);
    }
    environ
}

#[tokio::test]
async fn acquisition_reconciles_canonical_process() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("runtime");
    let lock_path = dir.path().join("runtime.lock");
    runner_host::private_fs::ensure_private_dir(&root)
        .await
        .unwrap();
    let launch = root.join("launch-canonical");
    std::fs::create_dir(&launch).unwrap();
    let mut child = ProbeChild::spawn(Some((CANONICAL_RUNTIME_MARKER_ENV, &launch)));

    let runtime = MitmdumpRuntime::acquire(root, lock_path).await.unwrap();

    let status = child
        .child
        .0
        .try_wait()
        .unwrap()
        .expect("canonical-marked process is still running after reconciliation");
    assert!(
        !status.success(),
        "canonical-marked process was not signalled"
    );
    assert!(!launch.exists(), "stale canonical launch was not removed");
    drop(runtime);
}

#[test]
fn runtime_marker_resolver_reads_canonical_marker_as_raw_bytes() {
    let canonical = b"/runtime/launch-canonical";
    let non_unicode = b"/runtime/launch-\xff";

    assert!(resolve_runtime_marker(&marker_environment(None)).is_none());
    assert_eq!(
        resolve_runtime_marker(&marker_environment(Some(b""))),
        Some(b"".as_slice()),
    );
    assert_eq!(
        resolve_runtime_marker(&marker_environment(Some(non_unicode))),
        Some(non_unicode.as_slice()),
    );
    assert_eq!(
        resolve_runtime_marker(&marker_environment(Some(canonical))),
        Some(canonical.as_slice()),
    );
}

async fn process_identity(pid: u32) -> ProcessIdentity {
    let ProcessStatRead::Found(stat) = runner_host::process::read_process_stat_checked(pid).await
    else {
        panic!("probe child process stat is unavailable");
    };
    ProcessIdentity {
        pid,
        starttime: stat.starttime,
    }
}

async fn test_runtime(root: &Path) -> Arc<MitmdumpRuntime> {
    MitmdumpRuntime::acquire(root.to_path_buf(), root.join("runtime.lock"))
        .await
        .unwrap()
}

#[tokio::test]
async fn cleanup_observation_keeps_nonterminal_unavailable_pgid_live() {
    let root = tempfile::tempdir().unwrap();
    let runtime = test_runtime(root.path()).await;
    let mut child = ProbeChild::spawn(None);
    let identity = process_identity(child.pid()).await;
    let ProcessStatRead::Found(stat) =
        runner_host::process::read_process_stat_checked(identity.pid).await
    else {
        panic!("probe child stat must be readable");
    };
    let observation = ProcessObservation {
        identity,
        stat,
        command: "cat".to_string(),
    };
    let proc_root = root.path().join("proc");
    let pid_dir = proc_root.join(identity.pid.to_string());
    std::fs::create_dir_all(&pid_dir).unwrap();
    let fields = [
        "R", "0", "-1", "-1", "0", "-1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0",
        "0", "0",
    ];
    std::fs::write(
        pid_dir.join("stat"),
        format!(
            "{} (cat) {} {}\n",
            identity.pid,
            fields.join(" "),
            identity.starttime,
        ),
    )
    .unwrap();
    runtime.set_test_cleanup_stat_read(identity.pid, proc_root);

    let live = observe_stable_process(&runtime, &observation)
        .await
        .unwrap()
        .expect("negative PGID alone must not prove exit");

    assert_eq!(live.stat.pgid, -1);
    assert_eq!(live.identity.starttime, identity.starttime);
    child.assert_responds();
}

#[tokio::test]
async fn pidfd_signal_rejects_replacement_process_generation() {
    let root = tempfile::tempdir().unwrap();
    let runtime = test_runtime(root.path()).await;
    let launch = root.path().join("launch-stale-generation");
    std::fs::create_dir(&launch).unwrap();
    let mut replacement = ProbeChild::spawn(Some((CANONICAL_RUNTIME_MARKER_ENV, &launch)));
    let current = process_identity(replacement.pid()).await;
    let stale = ProcessIdentity {
        starttime: current.starttime.checked_add(1).unwrap(),
        ..current
    };

    signal_stable_process(
        &runtime,
        Some(&launch),
        stale,
        Instant::now() + PROCESS_EXIT_TIMEOUT,
    )
    .await
    .unwrap();

    replacement.assert_responds();
}

#[tokio::test]
async fn pidfd_signal_rechecks_runtime_marker() {
    let root = tempfile::tempdir().unwrap();
    let runtime = test_runtime(root.path()).await;
    let launch = root.path().join("launch-removed-marker");
    std::fs::create_dir(&launch).unwrap();
    let mut replacement = ProbeChild::spawn(None);
    let current = process_identity(replacement.pid()).await;

    signal_stable_process(
        &runtime,
        Some(&launch),
        current,
        Instant::now() + PROCESS_EXIT_TIMEOUT,
    )
    .await
    .unwrap();

    replacement.assert_responds();
}

#[tokio::test]
async fn close_launch_accepts_environment_error_after_process_becomes_zombie() {
    let root = tempfile::tempdir().unwrap();
    let runtime = test_runtime(root.path()).await;
    let launch = root.path().join("launch-zombie-environment");
    std::fs::create_dir(&launch).unwrap();
    let child = ProbeChild::spawn(Some((CANONICAL_RUNTIME_MARKER_ENV, &launch)));
    let pid = child.pid();

    runtime.set_test_environment_read_error(pid, move || {
        let pid = nix::unistd::Pid::from_raw(i32::try_from(pid).unwrap());
        nix::sys::signal::kill(pid, nix::sys::signal::Signal::SIGKILL).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        loop {
            match runner_host::process::read_process_stat_checked_blocking(pid.as_raw() as u32) {
                ProcessStatRead::Found(stat) if !process_stat_is_live(&stat) => break,
                ProcessStatRead::Found(_) => {}
                ProcessStatRead::Missing => panic!("probe child disappeared before reaping"),
                ProcessStatRead::Unreadable(error) => {
                    panic!("probe child stat became unreadable: {error}")
                }
                ProcessStatRead::Invalid => panic!("probe child stat became invalid"),
            }
            assert!(
                std::time::Instant::now() < deadline,
                "probe child did not become a zombie"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        std::io::Error::from_raw_os_error(nix::libc::EACCES)
    });

    runtime.close_launch_path(launch.clone()).await.unwrap();

    assert!(!launch.exists());
    drop(child);
}

#[tokio::test]
async fn close_launch_accepts_environment_error_while_process_finishes_exit() {
    let root = tempfile::tempdir().unwrap();
    let runtime = test_runtime(root.path()).await;
    let launch = root.path().join("launch-exiting-environment");
    std::fs::create_dir(&launch).unwrap();
    let mut child = ProbeChild::spawn(Some((CANONICAL_RUNTIME_MARKER_ENV, &launch)));
    let pid = child.pid();
    let gate = gate_live_environment_error(&runtime, pid);
    let close = runtime.close_launch_path(launch.clone());
    tokio::pin!(close);
    tokio::select! {
        result = &mut close => panic!("cleanup completed before the live recheck gate: {result:?}"),
        entered = tokio::time::timeout(Duration::from_secs(2), gate.entered.notified()) => entered.unwrap(),
    }

    // Both stat observations found this real child live. Let it finish only
    // after that snapshot, reproducing the pre-zombie permission-error window.
    child.assert_responds();
    assert!(launch.exists());
    child.child.0.kill().unwrap();
    gate.release.add_permits(1);

    close.await.unwrap();

    assert!(!launch.exists());
    assert!(child.child.0.try_wait().unwrap().is_some());
}

fn gate_live_environment_error(
    runtime: &MitmdumpRuntime,
    pid: u32,
) -> crate::test_fixtures::ReapGate {
    runtime.set_test_environment_read_error(pid, || {
        std::io::Error::from_raw_os_error(nix::libc::EACCES)
    });
    let gate = crate::test_fixtures::ReapGate::new();
    runtime.set_test_environment_error_recheck_gate(pid, gate.clone());
    gate
}

#[tokio::test]
async fn close_launch_does_not_restart_exit_budget_after_environment_error() {
    let root = tempfile::tempdir().unwrap();
    let runtime = test_runtime(root.path()).await;
    let launch = root.path().join("launch-expired-environment");
    std::fs::create_dir(&launch).unwrap();
    let mut child = ProbeChild::spawn(Some((CANONICAL_RUNTIME_MARKER_ENV, &launch)));
    let gate = gate_live_environment_error(&runtime, child.pid());
    let close = runtime.close_launch_path(launch.clone());
    tokio::pin!(close);
    tokio::select! {
        result = &mut close => panic!("cleanup completed before the live recheck gate: {result:?}"),
        entered = tokio::time::timeout(Duration::from_secs(2), gate.entered.notified()) => entered.unwrap(),
    }

    // Spend the existing snapshot budget before the exceptional wait starts.
    // A fresh allowance in that wait would advance paused time a second time.
    tokio::time::pause();
    tokio::time::advance(PROCESS_EXIT_TIMEOUT).await;
    let expired_at = Instant::now();
    gate.release.add_permits(1);

    let error = close.await.unwrap_err().to_string();

    assert_eq!(Instant::now(), expired_at);
    assert!(error.contains("Permission denied"));
    assert!(error.contains("mitmdump exit budget elapsed"));
    assert!(launch.exists());
    child.assert_responds();
}

#[tokio::test]
async fn cancelled_environment_exit_wait_preserves_launch_and_live_process() {
    let root = tempfile::tempdir().unwrap();
    let runtime = test_runtime(root.path()).await;
    let launch = root.path().join("launch-cancelled-environment");
    std::fs::create_dir(&launch).unwrap();
    let mut child = ProbeChild::spawn(Some((CANONICAL_RUNTIME_MARKER_ENV, &launch)));
    let gate = gate_live_environment_error(&runtime, child.pid());
    {
        let close = runtime.close_launch_path(launch.clone());
        tokio::pin!(close);
        tokio::select! {
            result = &mut close => panic!("cleanup completed before the live recheck gate: {result:?}"),
            entered = tokio::time::timeout(Duration::from_secs(2), gate.entered.notified()) => entered.unwrap(),
        }
        gate.release.add_permits(1);
        // After the gate, the only suspension is the real pidfd exit wait.
        assert!(futures_util::poll!(close.as_mut()).is_pending());
    }

    assert!(launch.exists());
    child.assert_responds();
    runtime.close_launch_path(launch.clone()).await.unwrap();
    assert!(!launch.exists());
    assert!(child.child.0.try_wait().unwrap().is_some());
}

#[tokio::test]
async fn close_launch_rejects_environment_error_for_live_process() {
    let root = tempfile::tempdir().unwrap();
    let runtime = test_runtime(root.path()).await;
    let launch = root.path().join("launch-live-environment-error");
    std::fs::create_dir(&launch).unwrap();
    let mut child = ProbeChild::spawn(Some((CANONICAL_RUNTIME_MARKER_ENV, &launch)));
    let pid = child.pid();
    runtime.set_test_environment_read_error(pid, || {
        std::io::Error::from_raw_os_error(nix::libc::EACCES)
    });

    let error = runtime
        .close_launch_path(launch.clone())
        .await
        .unwrap_err()
        .to_string();

    assert!(error.contains("recheck /proc/"));
    assert!(error.contains("/environ after opening mitmdump cleanup pidfd"));
    assert!(error.contains("Permission denied"));
    assert!(launch.exists());
    child.assert_responds();
}
