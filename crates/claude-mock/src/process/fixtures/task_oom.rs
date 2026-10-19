//! Disposable-Guest task pressure programs used by the registered OOM fixture.

use std::fs::{File, OpenOptions};
use std::os::unix::fs::{FileExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use guest_contracts::managed_task::{TaskHandle, TaskStartup, is_task_runtime_path};

use super::{read_trimmed, validate_tool_cgroup};

pub(super) const STARTUP: &str = "/tmp/vm0-task-oom.startup";
pub(super) const RELEASE: &str = "/tmp/vm0-task-oom.release";
pub(super) const READY: &str = "/tmp/vm0-task-oom.ready";
pub(super) const DIAGNOSTICS: &str = "/tmp/vm0-task-oom.stderr";
const DIAGNOSTIC_TAIL_BYTES: u64 = 8192;

pub(super) const OFFENDER_SCRIPT: &str = r#"
set -eu
test "$(cat /proc/self/oom_score_adj)" = 1000
exec python3 -u -c "$VM0_TEST_TASK_CONTROLLER"
"#;

pub(super) const LAUNCH_SUPPORT: &str = r#"
import json, math, os, select, subprocess, sys, time

def task_stage(stage):
    print("task OOM stage: " + stage, file=sys.stderr, flush=True)

def task_remaining(stage, cap=None):
    deadline = float(os.environ["VM0_TEST_TASK_DEADLINE"])
    remaining = deadline - time.monotonic()
    if not math.isfinite(deadline) or remaining <= 0:
        raise TimeoutError(stage + ": task fixture deadline expired")
    return min(remaining, cap) if cap is not None else remaining

def wait_for_allocators(fd, count):
    task_stage("await all resident allocators")
    with os.fdopen(fd, "rb", buffering=0) as reports:
        pending = count
        while pending:
            if not select.select([reports], [], [], task_remaining("allocator readiness", 5))[0]:
                raise TimeoutError("allocator readiness: missing worker report")
            ready = os.read(reports.fileno(), pending)
            if not ready:
                raise RuntimeError("allocator readiness: pipe closed with " + str(pending) + " missing reports")
            if ready != b"R" * len(ready):
                raise RuntimeError("allocator readiness: invalid worker report")
            pending -= len(ready)

def launch(program, stdin=subprocess.DEVNULL):
    read_fd, report_fd = os.pipe()
    child = subprocess.Popen(
        ["/usr/local/bin/guest-task-exec", "--report-fd", str(report_fd),
         "--", "python3", "-u", "-c", program],
        pass_fds=(report_fd,), stdin=stdin,
        stdout=subprocess.DEVNULL)
    os.close(report_fd)
    try:
        with os.fdopen(read_fd) as report:
            assert select.select([report], [], [], task_remaining("task admission", 5))[0], "task admission timed out"
            startup = json.loads(report.readline(4097))
        assert startup["pid"] == child.pid
        return child, startup
    except BaseException:
        child.kill()
        child.wait(timeout=5)
        raise
"#;

pub(super) const CONTROLLER_PROGRAM: &str = r#"
import os, pathlib, time
os.environ["VM0_TEST_TASK_DEADLINE"] = str(time.monotonic() + float(os.environ["VM0_TEST_TASK_TIMEOUT_SECONDS"]))
exec(os.environ["VM0_TEST_TASK_SUPPORT"])
assert pathlib.Path("/proc/self/oom_score_adj").read_text().strip() == "1000"
task_stage("controller launch")
child, startup = launch(os.environ["VM0_TEST_TASK_RUNTIME"], stdin=subprocess.PIPE)
pathlib.Path("/tmp/vm0-task-oom.startup").write_text(json.dumps(startup))
# Publish identity before permitting the runtime to expose its nested marker.
child.stdin.write(b"ready\n")
child.stdin.close()
task_stage("controller await task runtime exit")
status = child.wait(timeout=task_remaining("task runtime exit"))
assert status == 0, "task did not recover from its nested OOM: " + str(status)
task_stage("controller completed")
"#;

pub(super) const RUNTIME_PROGRAM: &str = r#"
import os, pathlib, signal, sys
exec(os.environ["VM0_TEST_TASK_SUPPORT"])
assert pathlib.Path("/proc/self/oom_score_adj").read_text().strip() == "1000"
assert sys.stdin.readline() == "ready\n", "task identity was not published"
child, startup = launch(os.environ["VM0_TEST_TASK_ALLOCATOR"])
task_stage("runtime await nested allocator OOM")
status = child.wait(timeout=task_remaining("nested allocator OOM exit"))
assert status == -signal.SIGKILL, "nested task was not OOM-killed: " + str(status)
task_stage("nested allocator group exited")
"#;

pub(super) const ALLOCATOR_PROGRAM: &str = r#"
import os, pathlib, signal, subprocess, time
exec(os.environ["VM0_TEST_TASK_SUPPORT"])

assert pathlib.Path("/proc/self/oom_score_adj").read_text().strip() == "1000"
relative = pathlib.Path("/proc/self/cgroup").read_text().strip().removeprefix("0::")
assert relative.endswith("/runtime") and relative.count("/tools/task-") == 2
subprocess.Popen(["setsid", "python3", "-c",
                  "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(3600)"],
                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
pathlib.Path("/tmp/vm0-tool-oom-offender.cgroup").write_text(relative)
limit = int(os.environ["VM0_TEST_OOM_ALLOCATOR_BYTES"])
injected = os.environ["VM0_TEST_TASK_INJECTED"] == "1"
if injected:
    ready_read, ready_write = os.pipe()
for _ in range(4):
    if os.fork() == 0:
        if injected:
            os.close(ready_read)
        assert pathlib.Path("/proc/self/oom_score_adj").read_text().strip() == "1000"
        while not pathlib.Path("/tmp/vm0-task-oom.release").exists():
            task_remaining("allocator release")
            time.sleep(0.01)
        chunks = []
        allocated = 0
        while allocated < limit:
            chunk = bytearray(min(4 * 1024 * 1024, limit - allocated))
            chunk[::4096] = b"\x01" * ((len(chunk) + 4095) // 4096)
            allocated += len(chunk)
            chunks.append(chunk)
            if not injected:
                time.sleep(0.01)
        if injected:
            os.write(ready_write, b"R")
            os.close(ready_write)
        while True:
            time.sleep(1)
if injected:
    os.close(ready_write)
    wait_for_allocators(ready_read, 4)
    task_stage("all four allocators resident; awaiting Guest OOM injection")
    pathlib.Path("/tmp/vm0-task-oom.ready").write_text(relative)
while True:
    os.wait()
"#;

pub(super) fn diagnostics_file() -> Result<File, String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(DIAGNOSTICS)
        .map_err(|error| format!("create private task diagnostics: {error}"))
}

pub(super) fn diagnostics_tail(file: &File) -> Result<String, String> {
    let length = file
        .metadata()
        .map_err(|error| format!("stat task diagnostics: {error}"))?
        .len();
    let start = length.saturating_sub(DIAGNOSTIC_TAIL_BYTES);
    let mut bytes = vec![0; (length - start) as usize];
    // Cleanup can fail while a descendant still owns stderr. A positional read
    // must not move the shared writer's offset or overwrite its later error.
    file.read_exact_at(&mut bytes, start)
        .map_err(|error| format!("read task diagnostics: {error}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn startup() -> Result<TaskStartup, String> {
    let raw = read_trimmed(Path::new(STARTUP))?;
    let startup: TaskStartup =
        serde_json::from_str(&raw).map_err(|error| format!("task startup metadata: {error}"))?;
    TaskHandle::parse(startup.handle.as_str().to_string())
        .map_err(|error| format!("task startup handle: {error}"))?;
    Ok(startup)
}

pub(super) fn root_path(tools_relative: &str) -> Result<PathBuf, String> {
    let handle = startup()?.handle;
    Ok(Path::new("/sys/fs/cgroup")
        .join(tools_relative.trim_start_matches('/'))
        .join(format!("task-{}", handle.as_str())))
}

pub(super) fn validate_runtime(relative: &str, tools_relative: &str) -> Result<(), String> {
    let handle = startup()?.handle;
    let prefix = format!("{tools_relative}/task-{}/tools/task-", handle.as_str());
    if !relative.starts_with(&prefix)
        || !is_task_runtime_path(relative)
        || relative.matches("/tools/task-").count() != 2
    {
        return Err(format!("unexpected nested task runtime: {relative}"));
    }
    let path = Path::new("/sys/fs/cgroup").join(relative.trim_start_matches('/'));
    if read_trimmed(&path.join("memory.oom.group"))? != "1"
        || read_trimmed(&path.join("memory.max"))? != "max"
    {
        return Err("task runtime changed group OOM policy or received a private limit".into());
    }
    Ok(())
}

pub(super) fn stop_family() {
    if let Ok(startup) = startup() {
        // The opaque handle is operation-owned; never stop by a recyclable PID.
        let _ = Command::new("/usr/local/bin/guest-task-exec")
            .args(["stop", startup.handle.as_str()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

pub(super) fn validate_controller(child_pid: u32, tools_relative: &str) -> Result<(), String> {
    let relative = super::unified_cgroup_path(child_pid)?;
    validate_tool_cgroup(&relative, tools_relative)
}

#[cfg(test)]
mod tests;
