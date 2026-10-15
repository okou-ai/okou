//! Disposable-Guest task pressure programs used by the registered OOM fixture.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use guest_contracts::managed_task::{TaskHandle, TaskStartup, is_task_runtime_path};

use super::{read_trimmed, validate_tool_cgroup};

pub(super) const STARTUP: &str = "/tmp/vm0-task-oom.startup";
pub(super) const RELEASE: &str = "/tmp/vm0-task-oom.release";

pub(super) const OFFENDER_SCRIPT: &str = r#"
set -eu
test "$(cat /proc/self/oom_score_adj)" = 1000
exec python3 -u -c "$VM0_TEST_TASK_CONTROLLER"
"#;

pub(super) const LAUNCH_SUPPORT: &str = r#"
import json, os, select, subprocess

def launch(program, stdin=subprocess.DEVNULL):
    read_fd, report_fd = os.pipe()
    child = subprocess.Popen(
        ["/usr/local/bin/guest-task-exec", "--report-fd", str(report_fd),
         "--", "python3", "-u", "-c", program],
        pass_fds=(report_fd,), stdin=stdin,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.close(report_fd)
    try:
        with os.fdopen(read_fd) as report:
            assert select.select([report], [], [], 5)[0], "task admission timed out"
            startup = json.loads(report.readline(4097))
        assert startup["pid"] == child.pid
        return child, startup
    except BaseException:
        child.kill()
        child.wait(timeout=5)
        raise
"#;

pub(super) const CONTROLLER_PROGRAM: &str = r#"
import os, pathlib
exec(os.environ["VM0_TEST_TASK_SUPPORT"])
assert pathlib.Path("/proc/self/oom_score_adj").read_text().strip() == "1000"
child, startup = launch(os.environ["VM0_TEST_TASK_RUNTIME"], stdin=subprocess.PIPE)
pathlib.Path("/tmp/vm0-task-oom.startup").write_text(json.dumps(startup))
# Publish identity before permitting the runtime to expose its nested marker.
child.stdin.write(b"ready\n")
child.stdin.close()
assert child.wait(timeout=20) == 0, "task did not recover from its nested OOM"
"#;

pub(super) const RUNTIME_PROGRAM: &str = r#"
import os, pathlib, signal, sys
exec(os.environ["VM0_TEST_TASK_SUPPORT"])
assert pathlib.Path("/proc/self/oom_score_adj").read_text().strip() == "1000"
assert sys.stdin.readline() == "ready\n", "task identity was not published"
child, startup = launch(os.environ["VM0_TEST_TASK_ALLOCATOR"])
assert child.wait(timeout=20) == -signal.SIGKILL, "nested task was not OOM-killed"
"#;

pub(super) const ALLOCATOR_PROGRAM: &str = r#"
import os, pathlib, signal, subprocess, time

assert pathlib.Path("/proc/self/oom_score_adj").read_text().strip() == "1000"
relative = pathlib.Path("/proc/self/cgroup").read_text().strip().removeprefix("0::")
assert relative.endswith("/runtime") and relative.count("/tools/task-") == 2
subprocess.Popen(["setsid", "python3", "-c",
                  "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(3600)"],
                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
pathlib.Path("/tmp/vm0-tool-oom-offender.cgroup").write_text(relative)
limit = int(os.environ["VM0_TEST_OOM_ALLOCATOR_BYTES"])
for _ in range(4):
    if os.fork() == 0:
        assert pathlib.Path("/proc/self/oom_score_adj").read_text().strip() == "1000"
        deadline = time.monotonic() + 10
        while not pathlib.Path("/tmp/vm0-task-oom.release").exists():
            assert time.monotonic() < deadline, "task pressure was not released"
            time.sleep(0.01)
        chunks = []
        allocated = 0
        while allocated < limit:
            chunk = bytearray(min(4 * 1024 * 1024, limit - allocated))
            chunk[::4096] = b"\x01" * ((len(chunk) + 4095) // 4096)
            allocated += len(chunk)
            chunks.append(chunk)
            time.sleep(0.01)
        while True:
            time.sleep(1)
while True:
    os.wait()
"#;

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
