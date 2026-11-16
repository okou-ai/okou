use std::io::{Seek, SeekFrom, Write};
use std::process::Command;
use std::time::Instant;

use super::{
    CONTROLLER_PROGRAM, DIAGNOSTIC_TAIL_BYTES, INJECTED_TOOL_PROGRAM, LAUNCH_SUPPORT,
    diagnostics_tail, monotonic_deadline,
};

fn run_protocol(program: &str) -> Result<(), Box<dyn std::error::Error>> {
    let output = Command::new("python3")
        .args(["-c", program])
        .env("VM0_TEST_TASK_SUPPORT", LAUNCH_SUPPORT)
        .env("VM0_TEST_TOOL_OOM_PROGRAM", INJECTED_TOOL_PROGRAM)
        .output()?;
    assert!(
        output.status.success(),
        "embedded task protocol failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

#[test]
fn allocator_readiness_requires_every_report() -> Result<(), Box<dyn std::error::Error>> {
    run_protocol(
        r#"
import os, time
exec(os.environ["VM0_TEST_TASK_SUPPORT"])
os.environ["VM0_TEST_TASK_DEADLINE"] = str(time.monotonic() + 15)
for count in range(5):
    read_fd, write_fd = os.pipe()
    os.write(write_fd, b"R" * count)
    os.close(write_fd)
    try:
        wait_for_allocators(read_fd, 4)
    except RuntimeError as error:
        assert count < 4 and "missing reports" in str(error), str(error)
    else:
        assert count == 4, "partial worker readiness was accepted"
"#,
    )
}

#[test]
fn allocator_readiness_rejects_invalid_reports() -> Result<(), Box<dyn std::error::Error>> {
    run_protocol(
        r#"
import os, time
exec(os.environ["VM0_TEST_TASK_SUPPORT"])
os.environ["VM0_TEST_TASK_DEADLINE"] = str(time.monotonic() + 15)
read_fd, write_fd = os.pipe()
os.write(write_fd, b"RRXR")
os.close(write_fd)
try:
    wait_for_allocators(read_fd, 4)
except RuntimeError as error:
    assert "invalid worker report" in str(error), str(error)
else:
    raise AssertionError("invalid worker readiness was accepted")
"#,
    )
}

#[test]
fn allocator_readiness_consumes_the_operation_budget() -> Result<(), Box<dyn std::error::Error>> {
    run_protocol(
        r#"
import os, time
exec(os.environ["VM0_TEST_TASK_SUPPORT"])
# Observe the actual select budget while retaining real pipe I/O. No clock
# advancement or real-time wait is needed to catch a per-stage timeout cap.
native_select = select.select
observed = []
def observe_select(readers, writers, errors, timeout):
    observed.append((timeout, task_remaining("select observation")))
    return native_select(readers, writers, errors, timeout)
select.select = observe_select
for budget in [15, 2]:
    os.environ["VM0_TEST_TASK_DEADLINE"] = str(time.monotonic() + budget)
    read_fd, write_fd = os.pipe()
    os.write(write_fd, b"RRRR")
    os.close(write_fd)
    wait_for_allocators(read_fd, 4)
    timeout, remaining = observed[-1]
    assert remaining <= timeout <= budget, observed
"#,
    )
}

#[test]
fn task_deadline_fails_with_stage_without_resetting_budget()
-> Result<(), Box<dyn std::error::Error>> {
    run_protocol(
        r#"
import os, time
exec(os.environ["VM0_TEST_TASK_SUPPORT"])
for deadline in [str(time.monotonic() - 1), "inf", "nan"]:
    os.environ["VM0_TEST_TASK_DEADLINE"] = deadline
    for stage in ["task admission", "allocator readiness", "nested allocator OOM exit"]:
        try:
            task_remaining(stage)
        except TimeoutError as error:
            assert stage in str(error), str(error)
        else:
            raise AssertionError("expired or invalid deadline received a new budget")
"#,
    )
}

#[test]
fn controller_start_does_not_renew_an_expired_budget() -> Result<(), Box<dyn std::error::Error>> {
    for (program, stage) in [
        (CONTROLLER_PROGRAM, "controller start"),
        (INJECTED_TOOL_PROGRAM, "tool controller start"),
    ] {
        let deadline = monotonic_deadline(Instant::now())?;
        let output = Command::new("python3")
            .args(["-c", program])
            .env("VM0_TEST_TASK_SUPPORT", LAUNCH_SUPPORT)
            .env("VM0_TEST_TASK_DEADLINE", deadline)
            .output()?;
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains(&format!("{stage}: task fixture deadline expired")),
            "controller did not reject its expired inherited budget: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn injected_tool_workers_remain_resident_and_are_reaped_on_failure()
-> Result<(), Box<dyn std::error::Error>> {
    run_protocol(
        r#"
import os, pathlib, re, select, signal, subprocess, tempfile, time

def bounded_wait(signum, frame):
    raise TimeoutError("tool controller process regression did not complete")

signal.signal(signal.SIGALRM, bounded_wait)
signal.alarm(15)

def signal_and_observe_exit(pid, signum):
    pidfd = os.pidfd_open(pid)
    try:
        os.kill(pid, signum)
        assert select.select([pidfd], [], [], 5)[0], (pid, signum)
    finally:
        os.close(pidfd)

for outcome in ["interrupt", "worker-exit", "sentinel-exit", "victim-before-group"]:
    with tempfile.TemporaryDirectory() as directory:
        marker = pathlib.Path(directory) / "resident.cgroup"
        armed = pathlib.Path(directory) / "armed.cgroup"
        environment = dict(os.environ,
            VM0_TEST_TASK_DEADLINE=str(time.monotonic() + 15),
            VM0_TEST_OOM_ALLOCATOR_BYTES=str(4 * 1024 * 1024),
            VM0_TEST_TOOL_OOM_CGROUP_MARKER=str(marker),
            VM0_TEST_TOOL_OOM_ARMED_MARKER=str(armed))
        if outcome == "sentinel-exit":
            environment["VM0_TEST_SENTINEL_PID"] = str(pathlib.Path(directory) / "sentinel.pid")
        # Increase only this disposable child's OOM score, as the real launcher
        # does. The full native lane owns managed placement and kernel OOM.
        wrapper = '''
import os, pathlib, subprocess
pathlib.Path('/proc/self/oom_score_adj').write_text('1000')
if "VM0_TEST_SENTINEL_PID" in os.environ:
    sentinel = subprocess.Popen(["sleep", "3600"], stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    pathlib.Path(os.environ["VM0_TEST_SENTINEL_PID"]).write_text(str(sentinel.pid))
exec(os.environ['VM0_TEST_TOOL_OOM_PROGRAM'])
'''
        controller = subprocess.Popen(["python3", "-u", "-c", wrapper], env=environment,
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE, start_new_session=True)
        try:
            worker_pids = set()
            evidence = []
            for raw in controller.stderr:
                line = raw.decode()
                evidence.append(line)
                match = re.search(r"tool worker resident pid=(\d+) bytes=(\d+)", line)
                if match:
                    assert int(match[2]) == 1024 * 1024, line
                    worker_pids.add(int(match[1]))
                if "all four tool allocators resident" in line:
                    break
            assert len(worker_pids) == 4, evidence
            expected_group = pathlib.Path(f"/proc/{controller.pid}/cgroup").read_text().strip().removeprefix("0::")
            assert marker.read_text() == expected_group
            identities = {}
            for pid in worker_pids:
                proc = pathlib.Path(f"/proc/{pid}")
                identities[pid] = (proc / "stat").read_text().split()[21]
                assert (proc / "cgroup").read_text().strip().removeprefix("0::") == expected_group
                private_dirty = next(int(line.split()[1]) * 1024
                    for line in (proc / "smaps_rollup").read_text().splitlines()
                    if line.startswith("Private_Dirty:"))
                assert private_dirty >= 1024 * 1024, private_dirty
            handoff = None
            if outcome == "interrupt":
                signal_and_observe_exit(controller.pid, signal.SIGINT)
            elif outcome == "victim-before-group":
                controller.stdin.write(b"I")
                controller.stdin.flush()
                for raw in controller.stderr:
                    evidence.append(raw.decode())
                    if b"tool controller armed for Guest OOM injection" in raw:
                        break
                assert armed.read_text() == expected_group, evidence
                signal_and_observe_exit(next(iter(worker_pids)), signal.SIGKILL)
                # Linux terminates the first victim before sweeping its group.
                # Closing our control pipe now must reach the owner's EOF path,
                # rather than misclassify that expected victim as a prep failure.
            elif outcome == "worker-exit":
                signal_and_observe_exit(next(iter(worker_pids)), signal.SIGKILL)
                handoff = b"I"
            else:
                sentinel_pid = int(pathlib.Path(environment["VM0_TEST_SENTINEL_PID"]).read_text())
                identities[sentinel_pid] = pathlib.Path(f"/proc/{sentinel_pid}/stat").read_text().split()[21]
                signal_and_observe_exit(sentinel_pid, signal.SIGKILL)
                handoff = b"I"
            _, remaining = controller.communicate(input=handoff, timeout=5)
            assert controller.returncode != 0
            if outcome == "victim-before-group":
                assert b"OOM control pipe closed before group termination" in remaining, remaining
            else:
                assert not armed.exists(), outcome
            if outcome in ["worker-exit", "sentinel-exit"]:
                assert b"tool child exited before OOM" in remaining, remaining
            for pid, start_time in identities.items():
                stat = pathlib.Path(f"/proc/{pid}/stat")
                try:
                    actual = stat.read_text().split()[21]
                except FileNotFoundError:
                    continue
                assert actual != start_time, (pid, outcome)
        finally:
            # An unreaped controller pins its process-group identity. Never use
            # that numeric identity after communicate/wait has reaped it.
            if controller.returncode is None:
                os.killpg(controller.pid, signal.SIGKILL)
                controller.wait(timeout=5)
signal.alarm(0)
"#,
    )
}

#[test]
fn task_diagnostics_include_only_the_bounded_tail() -> Result<(), Box<dyn std::error::Error>> {
    let mut file = tempfile::tempfile()?;
    file.write_all(&vec![b'x'; DIAGNOSTIC_TAIL_BYTES as usize + 100])?;
    file.write_all(b"nested allocator OOM exit: first failure")?;
    file.seek(SeekFrom::Start(5))?;
    let tail = diagnostics_tail(&file)?;
    assert_eq!(tail.len(), DIAGNOSTIC_TAIL_BYTES as usize);
    assert!(tail.ends_with("nested allocator OOM exit: first failure"));
    assert_eq!(file.stream_position()?, 5);
    Ok(())
}
