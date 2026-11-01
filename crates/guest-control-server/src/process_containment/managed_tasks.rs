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
    // Operation-local tombstones make a completion/stop race idempotent without
    // treating unknown handles or failed cleanup as successful stops.
    retired: Mutex<HashMap<TaskHandle, PathBuf>>,
}

struct TaskScope {
    path: PathBuf,
    parent: Option<TaskHandle>,
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
            retired: Mutex::new(HashMap::new()),
        }
    }

    fn scopes(&self) -> io::Result<std::sync::MutexGuard<'_, HashMap<TaskHandle, Arc<TaskScope>>>> {
        self.scopes
            .lock()
            .map_err(|_| io::Error::other("managed task registry unavailable"))
    }

    fn caller_scope(&self, stream: &UnixStream) -> io::Result<Option<TaskHandle>> {
        let credentials = peer_credentials(stream)?;
        if credentials.uid != self.uid {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "task caller UID mismatch",
            ));
        }
        let cgroup = fs::read_to_string(format!("/proc/{}/cgroup", credentials.pid))?;
        let Some(relative) = cgroup.lines().find_map(|line| line.strip_prefix("0::/")) else {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "task caller cgroup missing",
            ));
        };
        let path = Path::new(CGROUP_V2_MOUNT_PATH).join(relative);
        if path == self.runtime || main_tool_source(&path, &self.tools) {
            return Ok(None);
        }
        let scopes = self.scopes()?;
        let owner = scopes.iter().find_map(|(handle, scope)| {
            (path == scope.path.join(RUNTIME_CGROUP_NAME)
                || main_tool_source(&path, &scope.path.join(TOOLS_CGROUP_NAME)))
            .then(|| handle.clone())
        });
        drop(scopes);
        let owner = owner.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "task caller is not in an owned runtime/tools domain",
            )
        })?;
        self.require_active_ancestors(&owner)?;
        Ok(Some(owner))
    }

    fn require_active_ancestors(&self, handle: &TaskHandle) -> io::Result<()> {
        let scopes = self.scopes()?;
        let mut next = Some(handle);
        while let Some(handle) = next {
            let scope = scopes.get(handle).ok_or_else(|| {
                io::Error::new(io::ErrorKind::PermissionDenied, "task ancestor retired")
            })?;
            if !scope.admitted.load(Ordering::Acquire)
                || scope.closing.load(Ordering::Acquire)
                || pidfd_exited(&scope.pidfd)?
            {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "task ancestor is closing",
                ));
            }
            next = scope.parent.as_ref();
        }
        Ok(())
    }

    pub(super) fn place_tool(&self, stream: &UnixStream, tool_id: u64) -> io::Result<()> {
        if peer_matches(stream, self.uid, &self.runtime)? {
            return place_tool_peer(stream, self.uid, &self.runtime, &self.tools, tool_id);
        }
        let scopes: Vec<_> = self
            .scopes()?
            .iter()
            .map(|(h, s)| (h.clone(), Arc::clone(s)))
            .collect();
        for (handle, scope) in scopes {
            let runtime = scope.path.join(RUNTIME_CGROUP_NAME);
            if !peer_matches(stream, self.uid, &runtime)? {
                continue;
            }
            let _admission = scope
                .admission
                .lock()
                .map_err(|_| io::Error::other("task admission gate unavailable"))?;
            self.require_active_ancestors(&handle)?;
            return place_tool_peer_in_scope(
                stream,
                self.uid,
                &runtime,
                &scope.path.join(TOOLS_CGROUP_NAME),
                tool_id,
                Some(&|| self.require_active_ancestors(&handle)),
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
        if pidfd_exited(&pidfd)? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "task launcher is not in the owning operation",
            ));
        }
        let parent = self.caller_scope(stream)?;
        let parent_scope = parent
            .as_ref()
            .map(|handle| {
                self.scopes()?.get(handle).cloned().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::PermissionDenied, "task parent retired")
                })
            })
            .transpose()?;
        let parent_admission = parent_scope
            .as_ref()
            .map(|scope| {
                scope
                    .admission
                    .lock()
                    .map_err(|_| io::Error::other("task admission gate unavailable"))
            })
            .transpose()?;
        if let Some(parent) = &parent {
            self.require_active_ancestors(parent)?;
        }
        let handle = TaskHandle::generate();
        let tools = parent_scope
            .as_ref()
            .map(|scope| scope.path.join(TOOLS_CGROUP_NAME))
            .unwrap_or_else(|| self.tools.clone());
        let path = tools.join(format!("{TASK_CGROUP_PREFIX}{}", handle.as_str()));
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
            parent: parent.clone(),
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
            if let Some(parent) = &parent {
                self.require_active_ancestors(parent)?;
            }
            // Publish only after confirmed placement, before sending ACK so a
            // fast target cannot race the registry's admission publication.
            scope.admitted.store(true, Ordering::Release);
            process_control_ipc::write_tool_placement_ack(stream)
        })();
        drop(placement);
        drop(parent_admission);
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
        let scope = self.scopes()?.get(handle).cloned();
        let Some(scope) = scope else {
            if self
                .retired
                .lock()
                .map_err(|_| io::Error::other("task retirement registry unavailable"))?
                .contains_key(handle)
            {
                return Ok(());
            }
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "unknown task handle",
            ));
        };
        if scope.closing.swap(true, Ordering::AcqRel) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "task is already closing",
            ));
        }
        // Fence first, then await bounded in-flight placement. The handoff path
        // checks closing again before ACK; no placement FD survives this gate.
        let family: Vec<_> = self
            .scopes()?
            .iter()
            .filter(|(_, member)| member.path.starts_with(&scope.path))
            .map(|(handle, member)| (handle.clone(), Arc::clone(member)))
            .collect();
        for (_, member) in &family {
            member.closing.store(true, Ordering::Release);
        }
        let _admissions: Vec<_> = family
            .iter()
            .map(|(_, member)| {
                member
                    .admission
                    .lock()
                    .map_err(|_| io::Error::other("task admission gate unavailable"))
            })
            .collect::<io::Result<_>>()?;
        cleanup_cgroup(&scope.path, mode).map_err(io::Error::other)?;
        let mut scopes = self.scopes()?;
        let mut retired = self
            .retired
            .lock()
            .map_err(|_| io::Error::other("task retirement registry unavailable"))?;
        for (handle, member) in &family {
            scopes.remove(handle);
            retired.insert(handle.clone(), member.path.clone());
        }
        Ok(())
    }

    fn stop_from_caller(&self, stream: &UnixStream, handle: &TaskHandle) -> io::Result<()> {
        let credentials = peer_credentials(stream)?;
        let caller = open_pidfd(credentials.pid)?.ok_or_else(|| {
            io::Error::new(io::ErrorKind::PermissionDenied, "task stop caller exited")
        })?;
        if pidfd_exited(&caller)? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "task stop caller exited",
            ));
        }
        if let Some(owner) = self.caller_scope(stream)? {
            let owner_path = self
                .scopes()?
                .get(&owner)
                .map(|s| s.path.join(TOOLS_CGROUP_NAME))
                .ok_or_else(|| {
                    io::Error::new(io::ErrorKind::PermissionDenied, "task caller retired")
                })?;
            let target = self.scopes()?.get(handle).map(|s| s.path.clone());
            let target = match target {
                Some(target) => target,
                None => self
                    .retired
                    .lock()
                    .map_err(|_| io::Error::other("task retirement registry unavailable"))?
                    .get(handle)
                    .cloned()
                    .ok_or_else(|| {
                        io::Error::new(io::ErrorKind::NotFound, "unknown task handle")
                    })?,
            };
            if !target.starts_with(owner_path) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "task handle belongs outside caller's descendants",
                ));
            }
        }
        self.stop(handle, ProcessContainmentCleanupMode::Graceful)
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
                // Consume the bounded request before rejecting its caller. Closing
                // unread input can reset the stream while the helper is still writing,
                // replacing the rejection diagnostic with a transport error.
                let request = ipc::read_request_with_timeout(stream, TOOL_PLACEMENT_IO_TIMEOUT)?;
                match request {
                    TaskRequest::Launch {} => self.launch(stream),
                    TaskRequest::Stop { handle } => {
                        self.stop_from_caller(stream, &handle)?;
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
mod tests;
