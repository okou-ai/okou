use super::*;
#[cfg(target_os = "linux")]
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::Arc;

#[test]
fn fast_exit_wait_does_not_pay_cancel_poll_interval_per_child() {
    let iterations = 20u32;
    let mut baseline_total = Duration::default();
    let mut timed_total = Duration::default();

    fn wait_for_fast_child(timeout_ms: u32) -> Duration {
        let mut child = Command::new("true")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let start = Instant::now();
        let outcome = if timeout_ms == 0 {
            match child.wait() {
                Ok(status) => WaitOutcome::Exited(status),
                Err(e) => WaitOutcome::WaitFailed(e.to_string()),
            }
        } else {
            let connection_cancel = AtomicBool::new(false);
            wait_with_kill_timeout_or_connection_cancelled(
                child,
                timeout_ms,
                &connection_cancel,
                || false,
            )
        };
        let elapsed = start.elapsed();
        assert!(
            matches!(outcome, WaitOutcome::Exited(status) if status.success()),
            "unexpected wait outcome"
        );
        elapsed
    }

    for i in 0..iterations {
        if i % 2 == 0 {
            baseline_total += wait_for_fast_child(0);
            timed_total += wait_for_fast_child(30_000);
        } else {
            timed_total += wait_for_fast_child(30_000);
            baseline_total += wait_for_fast_child(0);
        }
    }

    let overhead = timed_total.saturating_sub(baseline_total);
    let allowed_overhead =
        Duration::from_millis(WAIT_CANCEL_POLL_INTERVAL_MS * u64::from(iterations) / 2);
    assert!(
        overhead < allowed_overhead,
        "timed waits should not accumulate the {WAIT_CANCEL_POLL_INTERVAL_MS}ms cancel \
             poll interval per child; {iterations} timed waits took {timed_total:?}, baseline \
             waits took {baseline_total:?}, overhead was {overhead:?}",
    );
}

#[test]
fn timeout_zero_child_is_cancelled_by_external_cancel() {
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_for_thread = Arc::clone(&cancel);
    let other_cancel = AtomicBool::new(false);
    let mut command = Command::new("sleep");
    command
        .arg("60")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let child = command.spawn().unwrap();
    let cancel_thread = thread::spawn(move || {
        cancel_for_thread.store(true, Ordering::Release);
    });

    let outcome =
        wait_with_kill_timeout_or_cancelled_either(child, 0, &cancel, &other_cancel, || false);
    cancel_thread.join().unwrap();

    assert!(matches!(outcome, WaitOutcome::Cancelled));
}

#[test]
fn nonzero_timeout_child_is_cancelled_by_pre_signalled_cancel() {
    let cancel = AtomicBool::new(true);
    let other_cancel = AtomicBool::new(false);
    let mut command = Command::new("sleep");
    command
        .arg("60")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let child = command.spawn().unwrap();
    let outcome =
        wait_with_kill_timeout_or_cancelled_either(child, 30_000, &cancel, &other_cancel, || false);

    assert!(matches!(outcome, WaitOutcome::Cancelled));
}

#[test]
fn observed_exit_wins_over_elapsed_deadline() {
    let cancel = AtomicBool::new(false);
    let (observed_tx, observed_rx) = mpsc::channel::<()>();
    observed_tx.send(()).unwrap();

    let decision = wait_for_exit_timeout_or_cancelled(&observed_rx, Some(Instant::now()), || {
        cancel.load(Ordering::Acquire)
    });

    assert!(matches!(decision, WaitDecision::Exited));
}

#[test]
fn observed_exit_wins_over_pre_signalled_cancel() {
    let cancel = AtomicBool::new(true);
    let (observed_tx, observed_rx) = mpsc::channel::<()>();
    observed_tx.send(()).unwrap();

    let decision =
        wait_for_exit_timeout_or_cancelled(&observed_rx, None, || cancel.load(Ordering::Acquire));

    assert!(matches!(decision, WaitDecision::Exited));
}

#[test]
fn final_observed_exit_wins_over_pending_kill_decision() {
    let (observed_tx, observed_rx) = mpsc::channel::<()>();
    observed_tx.send(()).unwrap();

    let decision = apply_final_exit_priority(WaitDecision::Kill(KillReason::Timeout), &observed_rx);

    assert!(matches!(decision, WaitDecision::Exited));
}

#[cfg(target_os = "linux")]
#[test]
fn natural_exit_cleanup_runs_before_direct_child_is_reaped() {
    let mut command = Command::new("true");
    command.stdout(Stdio::null()).stderr(Stdio::null());
    command.process_group(0);
    let child = command.spawn().unwrap();
    let child_id = child.id();
    let mut cleanup_called = false;

    let connection_cancel = AtomicBool::new(false);
    let outcome =
        wait_with_kill_timeout_or_connection_cancelled(child, 30_000, &connection_cancel, || {
            cleanup_called = true;
            let stat = std::fs::read_to_string(format!("/proc/{child_id}/stat"))
                .expect("unreaped direct child should remain visible in procfs");
            let state = stat
                .rsplit_once(") ")
                .and_then(|(_, fields)| fields.chars().next());
            assert_eq!(state, Some('Z'), "observed child should be waitable");
            false
        });

    assert!(cleanup_called);
    assert!(matches!(outcome, WaitOutcome::Exited(status) if status.success()));
}

#[test]
fn readiness_exit_probe_keeps_child_owned_until_terminal_cleanup() {
    let mut command = Command::new("sh");
    command.arg("-c").arg("exit 23").process_group(0);
    let child = crate::contained_command::ContainedChild::from(command.spawn().unwrap());
    let pid = child.id();
    wait_for_child_exit_without_reap(pid).unwrap();

    // Repeated readiness probes must not consume the waitable child.
    assert!(child_has_exited_without_reap(pid).unwrap());
    assert!(child_has_exited_without_reap(pid).unwrap());
    let mut cleaned = false;
    let outcome = wait_with_kill_timeout_or_connection_cancelled(
        child,
        5_000,
        &AtomicBool::new(false),
        || {
            cleaned = true;
            assert!(child_has_exited_without_reap(pid).unwrap());
            true
        },
    );
    assert!(cleaned);
    assert!(matches!(outcome, WaitOutcome::Exited(status) if status.code() == Some(23)));
    assert_eq!(
        child_has_exited_without_reap(pid)
            .unwrap_err()
            .raw_os_error(),
        Some(libc::ECHILD)
    );
}
