//! Operation-owned task lifetime and scoped tool admission, independent of Pi.

use std::collections::HashMap;
use std::os::unix::net::{UnixListener, UnixStream};

use guest_contracts::managed_task::{TASK_CGROUP_PREFIX, TaskHandle, TaskStartup};
use process_control_ipc::managed_task::{self as ipc, TaskReply, TaskRequest};

use super::*;

pub(super) struct ManagedTasks {
    uid: libc::uid_t,
    runtime: PathBuf,
    tools: PathBuf,
    scopes: Mutex<HashMap<TaskHandle, Arc<TaskScope>>>,
}

struct TaskScope {
    path: PathBuf,
    pidfd: OwnedFd,
    admitted: AtomicBool,
    closing: AtomicBool,
    // Serializes all descriptor handoffs against kill/prove-empty/remove.
    admission: Mutex<()>,
}

impl ManagedTasks {
    pub(super) fn new(uid: libc::uid_t, runtime: PathBuf, tools: PathBuf) -> Self {
        Self {
            uid,
            runtime,
            tools,
            scopes: Mutex::new(HashMap::new()),
        }
    }

    fn scopes(&self) -> io::Result<std::sync::MutexGuard<'_, HashMap<TaskHandle, Arc<TaskScope>>>> {
        self.scopes
            .lock()
            .map_err(|_| io::Error::other("managed task registry unavailable"))
    }

    fn caller_is_main(&self, stream: &UnixStream) -> io::Result<bool> {
        let credentials = peer_credentials(stream)?;
        if credentials.uid != self.uid {
            return Ok(false);
        }
        if peer_matches(stream, self.uid, &self.runtime)? {
            return Ok(true);
        }
        let cgroup = fs::read_to_string(format!("/proc/{}/cgroup", credentials.pid))?;
        let Some(relative) = cgroup.lines().find_map(|line| line.strip_prefix("0::/")) else {
            return Ok(false);
        };
        let path = Path::new(CGROUP_V2_MOUNT_PATH).join(relative);
        Ok(main_tool_source(&path, &self.tools))
    }

    pub(super) fn place_tool(&self, stream: &UnixStream, tool_id: u64) -> io::Result<()> {
        if peer_matches(stream, self.uid, &self.runtime)? {
            return place_tool_peer(stream, self.uid, &self.runtime, &self.tools, tool_id);
        }
        let scopes: Vec<_> = self.scopes()?.values().cloned().collect();
        for scope in scopes {
            let runtime = scope.path.join(RUNTIME_CGROUP_NAME);
            if !peer_matches(stream, self.uid, &runtime)? {
                continue;
            }
            let _admission = scope
                .admission
                .lock()
                .map_err(|_| io::Error::other("task admission gate unavailable"))?;
            if !scope.admitted.load(Ordering::Acquire)
                || scope.closing.load(Ordering::Acquire)
                || pidfd_exited(&scope.pidfd)?
            {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "task runtime is closing",
                ));
            }
            return place_tool_peer_in_scope(
                stream,
                self.uid,
                &runtime,
                &scope.path.join(TOOLS_CGROUP_NAME),
                tool_id,
                Some(&scope.closing),
            );
        }
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "peer is not in an active operation runtime",
        ))
    }

    fn launch(&self, stream: &UnixStream) -> io::Result<()> {
        let credentials = peer_credentials(stream)?;
        let pidfd = open_pidfd(credentials.pid)?
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "task launcher exited"))?;
        // A socket PID is not a stable lifetime identity. Recheck after pidfd_open.
        if pidfd_exited(&pidfd)? || !self.caller_is_main(stream)? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "task launcher is not in the owning operation",
            ));
        }
        let handle = TaskHandle::generate();
        let path = self
            .tools
            .join(format!("{TASK_CGROUP_PREFIX}{}", handle.as_str()));
        fs::create_dir(&path)?;
        let setup = (|| {
            fs::write(path.join(MEMORY_OOM_GROUP_FILE), WORKLOAD_MEMORY_OOM_GROUP)?;
            fs::write(
                path.join(CGROUP_SUBTREE_CONTROL_FILE),
                MEMORY_SUBTREE_CONTROL,
            )?;
            let runtime = path.join(RUNTIME_CGROUP_NAME);
            let tools = path.join(TOOLS_CGROUP_NAME);
            fs::create_dir(&runtime)?;
            fs::write(runtime.join(MEMORY_OOM_GROUP_FILE), TOOL_MEMORY_OOM_GROUP)?;
            fs::create_dir(&tools)?;
            fs::write(tools.join(MEMORY_OOM_GROUP_FILE), WORKLOAD_MEMORY_OOM_GROUP)?;
            fs::write(
                tools.join(CGROUP_SUBTREE_CONTROL_FILE),
                MEMORY_SUBTREE_CONTROL,
            )?;
            OpenOptions::new()
                .write(true)
                .open(runtime.join(CGROUP_PROCS_FILE))
        })();
        let placement = match setup {
            Ok(placement) => placement,
            Err(error) => {
                if let Err(cleanup) = cleanup_cgroup(&path, ProcessContainmentCleanupMode::Forced) {
                    log("WARN", &format!("task setup rollback failed: {cleanup}"));
                }
                return Err(error);
            }
        };
        let scope = Arc::new(TaskScope {
            path,
            pidfd,
            admitted: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            admission: Mutex::new(()),
        });
        self.scopes()?.insert(handle.clone(), Arc::clone(&scope));
        let result = (|| {
            ipc::write_reply(
                &mut &*stream,
                &TaskReply::Ready {
                    task: TaskStartup {
                        handle: handle.clone(),
                        pid: credentials.pid as u32,
                    },
                },
            )?;
            process_control_ipc::send_tool_placement(stream, placement.as_fd())?;
            process_control_ipc::read_tool_placement_confirmation(stream)?;
            if pidfd_exited(&scope.pidfd)?
                || !peer_matches(stream, self.uid, &scope.path.join(RUNTIME_CGROUP_NAME))?
            {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "task launcher did not enter its runtime",
                ));
            }
            // Publish only after confirmed placement, before sending ACK so a
            // fast target cannot race the registry's admission publication.
            scope.admitted.store(true, Ordering::Release);
            process_control_ipc::write_tool_placement_ack(stream)
        })();
        drop(placement);
        if result.is_err() {
            // No target may run before ACK. Remove even descendants of a failed
            // or disconnected launcher; do not tie task lifetime to its socket.
            if let Err(error) = self.stop(&handle, ProcessContainmentCleanupMode::Forced) {
                log("WARN", &format!("task launch rollback failed: {error}"));
            }
        }
        result
    }

    fn stop(&self, handle: &TaskHandle, mode: ProcessContainmentCleanupMode) -> io::Result<()> {
        let scope = self.scopes()?.get(handle).cloned().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "unknown or retired task handle")
        })?;
        if scope.closing.swap(true, Ordering::AcqRel) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "task is already closing",
            ));
        }
        // Fence first, then await bounded in-flight placement. The handoff path
        // checks closing again before ACK; no placement FD survives this gate.
        let _admission = scope
            .admission
            .lock()
            .map_err(|_| io::Error::other("task admission gate unavailable"))?;
        cleanup_cgroup(&scope.path, mode).map_err(io::Error::other)?;
        self.scopes()?.remove(handle);
        Ok(())
    }

    fn reap_completed(&self, cancel: &AtomicBool) {
        let scopes = match self.scopes() {
            Ok(scopes) => scopes
                .iter()
                .map(|(handle, scope)| (handle.clone(), Arc::clone(scope)))
                .collect::<Vec<_>>(),
            Err(error) => {
                log("WARN", &format!("task reaper failed: {error}"));
                return;
            }
        };
        for (handle, scope) in scopes {
            // Operation shutdown must not await one grace period per retired
            // task. The outer owner kills the whole hierarchy after workers join.
            if cancel.load(Ordering::Acquire) {
                return;
            }
            if scope.closing.load(Ordering::Acquire) {
                continue;
            }
            match pidfd_exited(&scope.pidfd) {
                Ok(false) => continue,
                Ok(true) => {}
                Err(error) => log(
                    "WARN",
                    &format!("task lifetime observation failed closed: {error}"),
                ),
            }
            if let Err(error) = self.stop(&handle, ProcessContainmentCleanupMode::Graceful) {
                // Keep failed cleanup closed and registered for outer operation
                // teardown; never acknowledge it as a successful stop.
                log(
                    "WARN",
                    &format!("task runtime-exit cleanup failed: {error}"),
                );
            }
        }
    }

    pub(super) fn serve(
        self: Arc<Self>,
        listener: UnixListener,
        active: Arc<ActiveToolPlacement>,
        cancel: Arc<AtomicBool>,
    ) {
        while !cancel.load(Ordering::Acquire) {
            self.reap_completed(&cancel);
            let stream = match process_control_ipc::accept_with_timeout(
                &listener,
                Duration::from_millis(100),
            ) {
                Ok(stream) => stream,
                Err(error) if error.kind() == io::ErrorKind::TimedOut => continue,
                Err(error) => {
                    log("WARN", &format!("task placement accept failed: {error}"));
                    return;
                }
            };
            let stream = match active.register(stream, &cancel) {
                Ok(Some(stream)) => stream,
                Ok(None) => return,
                Err(error) => {
                    log("WARN", &format!("task stream registration failed: {error}"));
                    return;
                }
            };
            let stream = stream.as_ref();
            let result = (|| {
                stream.set_read_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))?;
                stream.set_write_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))?;
                if !self.caller_is_main(stream)? {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "task caller is not in the owning main runtime/tools domain",
                    ));
                }
                match ipc::read_request_with_timeout(stream, TOOL_PLACEMENT_IO_TIMEOUT)? {
                    TaskRequest::Launch {} => self.launch(stream),
                    TaskRequest::Stop { handle } => {
                        self.stop(&handle, ProcessContainmentCleanupMode::Graceful)?;
                        ipc::write_reply(&mut &*stream, &TaskReply::Stopped {})
                    }
                }
            })();
            if let Err(error) = result {
                if cancel.load(Ordering::Acquire) {
                    return;
                }
                let _ = ipc::write_reply(
                    &mut &*stream,
                    &TaskReply::Rejected {
                        diagnostic: error.to_string(),
                    },
                );
                log("WARN", &format!("managed task request rejected: {error}"));
            }
        }
        // The outer owner joins all placement workers, captures evidence, and
        // recursively empties/removes the complete operation, including tasks.
    }
}

fn main_tool_source(path: &Path, tools: &Path) -> bool {
    path.parent() == Some(tools)
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_prefix(TOOL_CGROUP_NAME_PREFIX))
            .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
}

fn pidfd_exited(pidfd: &OwnedFd) -> io::Result<bool> {
    let mut pollfd = libc::pollfd {
        fd: pidfd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: one initialized entry refers to the retained, live pidfd.
    let result = unsafe { libc::poll(&mut pollfd, 1, 0) };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    if pollfd.revents & (libc::POLLNVAL | libc::POLLERR) != 0 {
        return Err(io::Error::other("task lifetime pidfd unavailable"));
    }
    Ok(pollfd.revents & (libc::POLLIN | libc::POLLHUP) != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admission_source_excludes_nested_tasks_and_other_operations() {
        let tools = Path::new("/sys/fs/cgroup/vm0-exec/exec-1/workload/tools");
        assert!(main_tool_source(&tools.join("tool-1"), tools));
        for path in [
            tools.join("task-1/runtime"),
            tools.join("task-1/tools/tool-1"),
            tools.join("tool-1/runtime"),
            tools.join("tool-"),
            tools.join("tool-not-a-number"),
            PathBuf::from("/sys/fs/cgroup/vm0-exec/exec-2/workload/tools/tool-1"),
        ] {
            assert!(!main_tool_source(&path, tools));
        }
    }

    #[test]
    fn unknown_and_retired_handles_cannot_target_a_process_or_path() {
        let tasks = ManagedTasks::new(1000, PathBuf::from("/runtime"), PathBuf::from("/tools"));
        for _ in 0..2 {
            assert_eq!(
                tasks
                    .stop(
                        &TaskHandle::generate(),
                        ProcessContainmentCleanupMode::Graceful
                    )
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::NotFound
            );
        }
    }

    #[test]
    fn wrong_uid_and_operation_fail_before_allocating_a_task() {
        let (_client, server) = UnixStream::pair().unwrap();
        let uid = unsafe { libc::geteuid() };
        let wrong_uid =
            ManagedTasks::new(uid + 1, PathBuf::from("/runtime"), PathBuf::from("/tools"));
        assert!(!wrong_uid.caller_is_main(&server).unwrap());
        assert_eq!(
            wrong_uid.launch(&server).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        let wrong_operation = ManagedTasks::new(
            uid,
            PathBuf::from("/sys/fs/cgroup/vm0-exec/exec-not-this-operation/workload/runtime"),
            PathBuf::from("/sys/fs/cgroup/vm0-exec/exec-not-this-operation/workload/tools"),
        );
        assert!(!wrong_operation.caller_is_main(&server).unwrap());
        assert!(wrong_operation.launch(&server).is_err());
        assert!(wrong_operation.scopes().unwrap().is_empty());
    }

    #[test]
    fn failed_cleanup_retains_a_closed_handle_and_is_never_a_successful_stop() {
        let directory = tempfile::tempdir().unwrap();
        let tasks = ManagedTasks::new(1000, PathBuf::from("/runtime"), PathBuf::from("/tools"));
        let handle = TaskHandle::generate();
        let scope = Arc::new(TaskScope {
            path: directory.path().to_path_buf(),
            pidfd: open_pidfd(std::process::id() as libc::pid_t)
                .unwrap()
                .unwrap(),
            admitted: AtomicBool::new(true),
            closing: AtomicBool::new(false),
            admission: Mutex::new(()),
        });
        tasks
            .scopes()
            .unwrap()
            .insert(handle.clone(), Arc::clone(&scope));
        // A regular directory cannot provide kernel populated/empty evidence.
        assert!(
            tasks
                .stop(&handle, ProcessContainmentCleanupMode::Forced)
                .is_err()
        );
        assert!(scope.closing.load(Ordering::Acquire));
        assert!(tasks.scopes().unwrap().contains_key(&handle));
        assert!(
            tasks
                .stop(&handle, ProcessContainmentCleanupMode::Forced)
                .is_err()
        );
    }

    #[test]
    fn cancelled_reaper_leaves_tasks_to_bounded_outer_operation_cleanup() {
        let tasks = ManagedTasks::new(1000, PathBuf::from("/runtime"), PathBuf::from("/tools"));
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "read marker"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let pidfd = open_pidfd(child.id() as libc::pid_t).unwrap().unwrap();
        drop(child.stdin.take());
        child.wait().unwrap();
        let handle = TaskHandle::generate();
        let scope = Arc::new(TaskScope {
            path: PathBuf::from("/must-not-start-per-task-cleanup-after-cancel"),
            pidfd,
            admitted: AtomicBool::new(true),
            closing: AtomicBool::new(false),
            admission: Mutex::new(()),
        });
        tasks
            .scopes()
            .unwrap()
            .insert(handle.clone(), Arc::clone(&scope));
        tasks.reap_completed(&AtomicBool::new(true));
        assert!(!scope.closing.load(Ordering::Acquire));
        assert!(tasks.scopes().unwrap().contains_key(&handle));
    }

    #[test]
    fn pidfd_observes_exit_without_claiming_reaping_ownership() {
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "read marker"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let pidfd = open_pidfd(child.id() as libc::pid_t).unwrap().unwrap();
        assert!(!pidfd_exited(&pidfd).unwrap());
        drop(child.stdin.take());
        child.wait().unwrap();
        assert!(pidfd_exited(&pidfd).unwrap());
    }
}
