//! Operation-owned task lifetime and scoped tool admission, independent of Pi.

use std::collections::{HashMap, HashSet};
use std::os::unix::net::{UnixListener, UnixStream};

use guest_contracts::managed_task::{TASK_CGROUP_PREFIX, TaskHandle, TaskStartup};
use process_control_ipc::managed_task::{self as ipc, TaskReply, TaskRequest};

use super::*;

pub(super) struct ManagedTasks {
    uid: libc::uid_t,
    runtime: PathBuf,
    tools: PathBuf,
    scopes: Mutex<HashMap<TaskHandle, Arc<TaskScope>>>,
    // Operation-local tombstones make repeated stops idempotent without
    // treating unknown handles or failed cleanup as successful stops.
    retired: Mutex<HashSet<TaskHandle>>,
}

struct TaskScope {
    path: PathBuf,
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
            retired: Mutex::new(HashSet::new()),
        }
    }

    fn scopes(&self) -> io::Result<std::sync::MutexGuard<'_, HashMap<TaskHandle, Arc<TaskScope>>>> {
        self.scopes
            .lock()
            .map_err(|_| io::Error::other("managed task registry unavailable"))
    }

    fn caller_scope(&self, stream: &UnixStream) -> io::Result<Option<TaskHandle>> {
        let credentials = peer_credentials(stream)?;
        if credentials.uid() != self.uid {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "task caller UID mismatch",
            ));
        }
        let cgroup = fs::read_to_string(format!("/proc/{}/cgroup", credentials.pid()))?;
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
        self.require_active(&owner)?;
        Ok(Some(owner))
    }

    fn require_active(&self, handle: &TaskHandle) -> io::Result<()> {
        let scopes = self.scopes()?;
        let scope = scopes
            .get(handle)
            .ok_or_else(|| io::Error::new(io::ErrorKind::PermissionDenied, "task retired"))?;
        if !scope.admitted.load(Ordering::Acquire) || scope.closing.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "task is closing",
            ));
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
            self.require_active(&handle)?;
            return place_tool_peer_in_scope(
                stream,
                self.uid,
                &runtime,
                &scope.path.join(TOOLS_CGROUP_NAME),
                tool_id,
                Some(&|| self.require_active(&handle)),
            );
        }
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "peer is not in an active operation runtime",
        ))
    }

    fn launch(&self, stream: &UnixStream) -> io::Result<()> {
        let credentials = peer_credentials(stream)?;
        let pidfd = open_pidfd(credentials.pid())?
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "task launcher exited"))?;
        // A socket PID is not a stable lifetime identity. Recheck after pidfd_open.
        if pidfd_exited(&pidfd)? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "task launcher is not in the owning operation",
            ));
        }
        let caller = self.caller_scope(stream)?;
        let caller_scope = caller
            .as_ref()
            .map(|handle| {
                self.scopes()?.get(handle).cloned().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::PermissionDenied, "task caller retired")
                })
            })
            .transpose()?;
        let caller_admission = caller_scope
            .as_ref()
            .map(|scope| {
                scope
                    .admission
                    .lock()
                    .map_err(|_| io::Error::other("task admission gate unavailable"))
            })
            .transpose()?;
        if let Some(caller) = &caller {
            self.require_active(caller)?;
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
                        pid: credentials.pid() as u32,
                    },
                },
            )?;
            process_control_ipc::offer_tool_placement(stream, placement.as_fd(), || {
                if pidfd_exited(&pidfd)?
                    || !peer_matches(stream, self.uid, &scope.path.join(RUNTIME_CGROUP_NAME))?
                {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "task launcher did not enter its runtime",
                    ));
                }
                if let Some(caller) = &caller {
                    self.require_active(caller)?;
                }
                // Publish after confirmed placement and before ACK so the target
                // can use the admitted scope as soon as it starts.
                scope.admitted.store(true, Ordering::Release);
                Ok(())
            })
        })();
        drop(placement);
        drop(caller_admission);
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
                .contains(handle)
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
        // Fence only this runtime and its ordinary tools, then await bounded
        // in-flight placement. Separately launched tasks belong to the operation.
        let _admission = scope
            .admission
            .lock()
            .map_err(|_| io::Error::other("task admission gate unavailable"))?;
        cleanup_cgroup(&scope.path, mode).map_err(io::Error::other)?;
        let mut scopes = self.scopes()?;
        let mut retired = self
            .retired
            .lock()
            .map_err(|_| io::Error::other("task retirement registry unavailable"))?;
        scopes.remove(handle);
        retired.insert(handle.clone());
        Ok(())
    }

    fn stop_from_caller(&self, stream: &UnixStream, handle: &TaskHandle) -> io::Result<()> {
        let credentials = peer_credentials(stream)?;
        let caller = open_pidfd(credentials.pid())?.ok_or_else(|| {
            io::Error::new(io::ErrorKind::PermissionDenied, "task stop caller exited")
        })?;
        if pidfd_exited(&caller)? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "task stop caller exited",
            ));
        }
        self.caller_scope(stream)?;
        self.stop(handle, ProcessContainmentCleanupMode::Graceful)
    }

    pub(super) fn serve(
        self: Arc<Self>,
        listener: UnixListener,
        active: Arc<ActiveToolPlacement>,
        cancel: Arc<AtomicBool>,
    ) {
        while !cancel.load(Ordering::Acquire) {
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
