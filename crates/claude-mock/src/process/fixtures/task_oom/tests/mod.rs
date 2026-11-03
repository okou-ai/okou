use std::io::{Seek, SeekFrom, Write};
use std::process::Command;
use std::time::Instant;

use super::{
    CONTROLLER_PROGRAM, DIAGNOSTIC_TAIL_BYTES, LAUNCH_SUPPORT, diagnostics_tail, monotonic_deadline,
};

fn run_protocol(program: &str) -> Result<(), Box<dyn std::error::Error>> {
    let output = Command::new("python3")
        .args(["-c", program])
        .env("VM0_TEST_TASK_SUPPORT", LAUNCH_SUPPORT)
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
    let deadline = monotonic_deadline(Instant::now())?;
    let output = Command::new("python3")
        .args(["-c", CONTROLLER_PROGRAM])
        .env("VM0_TEST_TASK_SUPPORT", LAUNCH_SUPPORT)
        .env("VM0_TEST_TASK_DEADLINE", deadline)
        .output()?;
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("controller start: task fixture deadline expired"),
        "controller did not reject its expired inherited budget: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
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
