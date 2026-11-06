use std::error::Error;
use std::io;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::panic::catch_unwind;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use claude_mock::process_group_child::terminate_process_group;

use super::super::support::parse_jsonl;
use super::BatchChild;

const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy)]
enum Failure {
    Spawn,
    Parse,
    Assertion,
}

#[test]
fn partial_spawn_failure_cleans_up_collected_children() -> Result<(), Box<dyn Error>> {
    check_failure_cleanup(Failure::Spawn)
}

#[test]
fn validation_error_cleans_up_unconsumed_children() -> Result<(), Box<dyn Error>> {
    check_failure_cleanup(Failure::Parse)
}

#[test]
fn assertion_unwind_cleans_up_unconsumed_children() -> Result<(), Box<dyn Error>> {
    check_failure_cleanup(Failure::Assertion)
}

fn check_failure_cleanup(failure: Failure) -> Result<(), Box<dyn Error>> {
    let home = tempfile::tempdir()?;
    let missing_program = home.path().join("missing-program");
    let (probe_tx, probe_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let outcome = catch_unwind(|| -> Result<(), Box<dyn Error>> {
            let children = (0..3)
                .map(|index| {
                    if matches!(failure, Failure::Spawn) && index == 2 {
                        return BatchChild::spawn(&mut Command::new(&missing_program));
                    }
                    if !matches!(failure, Failure::Spawn) && index == 0 {
                        // The first output goes through the real waiter before validation fails.
                        let mut command = Command::new("sh");
                        command
                            .args(["-c", "printf 'invalid-json\\n'; exit 7"])
                            .stdout(Stdio::piped())
                            .stderr(Stdio::piped());
                        return BatchChild::spawn(&mut command);
                    }
                    let child = BatchChild::spawn(Command::new("sleep").arg("30"))?;
                    let probe = CleanupProbe::new(&child)?;
                    // Transfer backup ownership out of the failing scope before validation.
                    probe_tx
                        .send(probe)
                        .map_err(|_| io::Error::other("cleanup probe receiver dropped"))?;
                    Ok(child)
                })
                .collect::<io::Result<Vec<_>>>()?;

            for child in children {
                let output = child.wait_output()?;
                if matches!(failure, Failure::Assertion) {
                    assert!(output.status.success(), "injected validation assertion");
                }
                parse_jsonl(&output.stdout)?;
            }
            Ok(())
        });
        let expected_failure = match (failure, outcome) {
            (Failure::Spawn, Ok(Err(error))) => error
                .downcast_ref::<io::Error>()
                .is_some_and(|error| error.kind() == io::ErrorKind::NotFound),
            (Failure::Parse, Ok(Err(error))) => error.is::<serde_json::Error>(),
            (Failure::Assertion, Err(payload)) => payload
                .downcast_ref::<&str>()
                .is_some_and(|message| *message == "injected validation assertion"),
            _ => false,
        };
        let _ = done_tx.send(expected_failure);
    });

    let completed = done_rx.recv_timeout(CLEANUP_TIMEOUT);
    // These probes also clean up if completion, joining or a verification assertion fails.
    let mut probes: Vec<_> = probe_rx.try_iter().collect();
    assert!(completed?, "did not reach the intended failure path");
    if let Err(payload) = worker.join() {
        std::panic::resume_unwind(payload);
    }
    assert_eq!(probes.len(), 2, "expected two live pending batch members");
    for probe in &mut probes {
        probe.verify_cleanup()?;
    }
    Ok(())
}

struct CleanupProbe {
    leader: Option<libc::pid_t>,
    group_member: Option<Child>,
}

impl CleanupProbe {
    fn new(child: &BatchChild) -> io::Result<Self> {
        let leader = child
            .0
            .as_ref()
            .ok_or_else(|| io::Error::other("batch child already consumed"))?
            .id() as libc::pid_t;
        // A separately owned group member observes group-wide killing without orphaning
        // a grandchild. Its unreaped identity also keeps the group reserved for backup cleanup.
        // If member setup fails, the original BatchChild still owns leader cleanup.
        let group_member = Command::new("sleep")
            .arg("30")
            .process_group(leader)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        Ok(Self {
            leader: Some(leader),
            group_member: Some(group_member),
        })
    }

    fn verify_cleanup(&mut self) -> Result<(), Box<dyn Error>> {
        let leader = self
            .leader
            .ok_or_else(|| io::Error::other("cleanup probe already disarmed"))?;
        let mut status = 0;
        // SAFETY: this is a fixture-owned direct child. WNOHANG never waits for a live
        // child; only ECHILD proves the batch owner already reaped it.
        let result = unsafe { libc::waitpid(leader, &mut status, libc::WNOHANG) };
        let error = io::Error::last_os_error();
        assert_eq!(result, -1, "pending child {leader} was not reaped");
        assert_eq!(error.raw_os_error(), Some(libc::ECHILD));

        let member = self
            .group_member
            .as_mut()
            .ok_or_else(|| io::Error::other("cleanup probe missing group member"))?;
        let deadline = Instant::now() + CLEANUP_TIMEOUT;
        let status = loop {
            if let Some(status) = member.try_wait()? {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "batch process group survived cleanup"
            );
            std::thread::sleep(Duration::from_millis(1));
        };
        // Both processes are reaped now; disarm before inspecting the exit status.
        self.leader = None;
        self.group_member = None;
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        Ok(())
    }
}

impl Drop for CleanupProbe {
    fn drop(&mut self) {
        if let Some(leader) = self.leader.take() {
            // The unreaped group member retains the
            // original group identity until this independent backup cleanup is done.
            terminate_process_group(leader as u32);
            let mut status = 0;
            // SAFETY: reap only the known direct fixture child, never any other child.
            unsafe { libc::waitpid(leader, &mut status, 0) };
        }
        if let Some(mut member) = self.group_member.take() {
            let _ = member.kill();
            let _ = member.wait();
        }
    }
}
