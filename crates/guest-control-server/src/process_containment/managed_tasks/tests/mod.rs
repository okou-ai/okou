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
fn only_proven_retired_handles_have_idempotent_stop() {
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
    let retired = TaskHandle::generate();
    tasks
        .retired
        .lock()
        .unwrap()
        .insert(retired.clone(), PathBuf::from("/retired"));
    tasks
        .stop(&retired, ProcessContainmentCleanupMode::Graceful)
        .unwrap();
}

#[test]
fn admission_requires_every_ancestor_to_be_active() {
    let tasks = ManagedTasks::new(1000, PathBuf::from("/runtime"), PathBuf::from("/tools"));
    let parent = TaskHandle::generate();
    let child = TaskHandle::generate();
    let sibling = TaskHandle::generate();
    for (handle, owner) in [
        (&parent, None),
        (&child, Some(parent.clone())),
        (&sibling, None),
    ] {
        tasks.scopes().unwrap().insert(
            handle.clone(),
            Arc::new(TaskScope {
                path: PathBuf::from(format!("/tools/task-{}", handle.as_str())),
                parent: owner,
                pidfd: open_pidfd(std::process::id() as libc::pid_t)
                    .unwrap()
                    .unwrap(),
                admitted: AtomicBool::new(true),
                closing: AtomicBool::new(false),
                admission: Mutex::new(()),
            }),
        );
    }
    tasks.require_active_ancestors(&child).unwrap();
    let scope = tasks.scopes().unwrap().get(&parent).cloned().unwrap();
    scope.closing.store(true, Ordering::Release);
    assert_eq!(
        tasks.require_active_ancestors(&child).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    tasks.require_active_ancestors(&sibling).unwrap();
    scope.closing.store(false, Ordering::Release);
    scope.admitted.store(false, Ordering::Release);
    assert!(tasks.require_active_ancestors(&child).is_err());
    tasks.scopes().unwrap().remove(&parent);
    assert!(tasks.require_active_ancestors(&child).is_err());
}

#[test]
fn wrong_uid_and_operation_fail_before_allocating_a_task() {
    let (_client, server) = UnixStream::pair().unwrap();
    let uid = unsafe { libc::geteuid() };
    let wrong_uid = ManagedTasks::new(uid + 1, PathBuf::from("/runtime"), PathBuf::from("/tools"));
    assert!(wrong_uid.caller_scope(&server).is_err());
    assert_eq!(
        wrong_uid.launch(&server).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    let wrong_operation = ManagedTasks::new(
        uid,
        PathBuf::from("/sys/fs/cgroup/vm0-exec/exec-not-this-operation/workload/runtime"),
        PathBuf::from("/sys/fs/cgroup/vm0-exec/exec-not-this-operation/workload/tools"),
    );
    assert!(wrong_operation.caller_scope(&server).is_err());
    assert!(wrong_operation.launch(&server).is_err());
    assert!(wrong_operation.scopes().unwrap().is_empty());
}

#[test]
fn rejected_launch_and_stop_requests_close_after_a_complete_reply() {
    use std::io::Read;

    for request in [
        TaskRequest::Launch {},
        TaskRequest::Stop {
            handle: TaskHandle::generate(),
        },
    ] {
        let endpoint = format!("task-rejection-{}", TaskHandle::generate().as_str());
        let listener = process_control_ipc::bind_abstract_listener(&endpoint).unwrap();
        let tasks = Arc::new(ManagedTasks::new(
            unsafe { libc::geteuid() } + 1,
            PathBuf::from("/runtime"),
            PathBuf::from("/tools"),
        ));
        let active = Arc::new(ActiveToolPlacement {
            stream: Mutex::new(None),
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let mut client = process_control_ipc::connect_abstract_with_timeout(
            &endpoint,
            TOOL_PLACEMENT_IO_TIMEOUT,
        )
        .unwrap();
        client
            .set_read_timeout(Some(TOOL_PLACEMENT_IO_TIMEOUT))
            .unwrap();
        // Queue the complete request before the broker can reject it. Closing
        // with these bytes unread deterministically resets the peer's stream.
        ipc::write_request(&mut client, &request).unwrap();
        let worker = {
            let active = Arc::clone(&active);
            let cancel = Arc::clone(&cancel);
            thread::spawn(move || tasks.serve(listener, active, cancel))
        };
        let reply = ipc::read_reply_with_timeout(&client, TOOL_PLACEMENT_IO_TIMEOUT);
        let closed = client.read(&mut [0]);
        cancel.store(true, Ordering::Release);
        active.shutdown().unwrap();
        worker.join().unwrap();

        assert!(matches!(
            reply.unwrap(),
            TaskReply::Rejected { diagnostic }
                if diagnostic == "task caller UID mismatch"
        ));
        assert_eq!(closed.unwrap(), 0, "rejection must end with clean EOF");
    }
}

#[test]
fn failed_cleanup_retains_a_closed_handle_and_is_never_a_successful_stop() {
    let directory = tempfile::tempdir().unwrap();
    let tasks = ManagedTasks::new(1000, PathBuf::from("/runtime"), PathBuf::from("/tools"));
    let handle = TaskHandle::generate();
    let scope = Arc::new(TaskScope {
        path: directory.path().to_path_buf(),
        parent: None,
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
        parent: None,
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
