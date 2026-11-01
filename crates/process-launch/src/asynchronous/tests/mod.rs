use super::*;
use crate::Stdio;
use std::fs::File;
use std::future::{Future, poll_fn};
use std::io::Read;
use std::os::fd::AsFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::pin::Pin;
use std::task::Poll;
use std::time::Duration;

#[tokio::test]
async fn exit_notification_can_be_cancelled_and_repeated_before_wait() {
    use tokio::io::AsyncWriteExt;

    let process = std::process::Command::new("/bin/sh")
        .args([
            "-c",
            "read -r line && test \"$line\" = go && exit 23; exit 42",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .unwrap();
    let mut child = Child::try_from(crate::Child::from(process)).unwrap();
    let pid = child.id().unwrap();
    let mut notification = Box::pin(child.exit_notification().unwrap());
    poll_fn(|cx| {
        assert!(notification.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    drop(notification);

    // Cancellation must leave stdin usable and the child owned by its caller.
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"go\n")
        .await
        .unwrap();
    for _ in 0..2 {
        tokio::time::timeout(Duration::from_secs(2), child.exit_notification().unwrap())
            .await
            .unwrap()
            .unwrap();
    }
    assert_eq!(child.id(), Some(pid));
    // SAFETY: waitid observes this exact child without consuming its status.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    assert_eq!(
        unsafe {
            libc::waitid(
                libc::P_PID,
                pid,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        },
        0
    );
    // SAFETY: successful waitid initialized the child status fields.
    assert_eq!(unsafe { info.si_pid() }, pid as i32);
    assert_eq!(unsafe { info.si_status() }, 23);

    let status = child.wait().await.unwrap();
    assert_eq!(status.code(), Some(23));
    assert_eq!(child.wait().await.unwrap(), status);
    assert!(child.exit_notification().is_none());
    assert_reaped(pid);
}

#[tokio::test]
async fn standard_child_keeps_its_explicit_wait_policy() {
    let process = tokio::process::Command::new("/bin/sh")
        .args(["-c", "exit 17"])
        .spawn()
        .unwrap();
    let mut child = Child::from(process);
    assert!(child.exit_notification().is_none());
    assert_eq!(child.wait().await.unwrap().code(), Some(17));
}

#[test]
fn adoption_registration_panic_reaps_the_owned_child() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let process = std::process::Command::new("/bin/sleep")
        .arg("60")
        .process_group(0)
        .spawn()
        .unwrap();
    let pid = process.id();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        runtime.block_on(async { Child::try_from(crate::Child::from(process)) })
    }));
    assert!(result.is_err());
    assert_reaped(pid);
}

fn pending_child() -> (crate::spawn::PendingChild, File, u32) {
    let (reader, writer) = std::io::pipe().unwrap();
    let child = std::process::Command::new("/bin/sleep")
        .arg("60")
        .process_group(0)
        .spawn()
        .unwrap();
    let pid = child.id();
    (
        crate::spawn::PendingChild::new(child.into(), File::from(OwnedFd::from(reader))),
        File::from(OwnedFd::from(writer)),
        pid,
    )
}

fn assert_reaped(pid: u32) {
    // SAFETY: waitpid only observes the exact test-owned child; WNOHANG
    // bounds a failed assertion. Cleanup must already have consumed status.
    assert_eq!(
        unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG) },
        -1
    );
    assert_eq!(
        io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD)
    );
    assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
}

#[tokio::test]
async fn pending_acknowledgement_yields_and_transfers_child_on_eof() {
    let (pending, writer, pid) = pending_child();
    let mut ack = Box::pin(acknowledge_exec(
        pending,
        Instant::now() + Duration::from_secs(5),
    ));
    poll_fn(|cx| {
        assert!(ack.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    // On this single-thread runtime, the writer can only be closed if the
    // pending acknowledgement released the worker.
    tokio::spawn(async move { drop(writer) }).await.unwrap();
    let child = ack.await.unwrap();
    assert_eq!(child.id(), pid);
    child.kill_and_reap().unwrap();
    assert_reaped(pid);
}

#[tokio::test]
async fn dropping_pending_acknowledgement_reaps_before_returning() {
    let (pending, _writer, pid) = pending_child();
    let mut ack = Box::pin(acknowledge_exec(
        pending,
        Instant::now() + Duration::from_secs(5),
    ));
    poll_fn(|cx| {
        assert!(ack.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    drop(ack);
    assert_reaped(pid);
}

#[test]
fn failed_adoption_reaps_before_returning_or_unwinding() {
    for unwind in [false, true] {
        let (pending, writer, pid) = pending_child();
        drop(writer);
        let child = pending.finish().unwrap();
        let result = std::panic::catch_unwind(|| {
            let _guard = SpawnGuard(Some(child));
            if unwind {
                panic!("adoption failed before ownership transfer");
            }
            Err::<(), _>(io::Error::other("adoption failed"))
        });
        if unwind {
            assert!(result.is_err());
        } else {
            assert!(result.unwrap().is_err());
        }
        assert_reaped(pid);
    }
}

#[tokio::test]
async fn pending_acknowledgement_deadline_kills_and_reaps() {
    let (pending, _writer, pid) = pending_child();
    let error = acknowledge_exec(pending, Instant::now() + Duration::from_millis(50))
        .await
        .err()
        .expect("held exec pipe must time out");
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_reaped(pid);

    let (pending, writer, pid) = pending_child();
    drop(writer);
    let error = acknowledge_exec(pending, Instant::now() - Duration::from_secs(1))
        .await
        .err()
        .expect("ready EOF must not override an expired budget");
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_reaped(pid);
}

#[tokio::test]
async fn exec_error_records_reject_and_reap_the_pending_child() {
    use std::io::Write;

    for bytes in [
        libc::ENOENT.to_ne_bytes().to_vec(),
        libc::EINTR.to_ne_bytes().to_vec(),
        libc::EAGAIN.to_ne_bytes().to_vec(),
        vec![1, 2],
    ] {
        let (pending, mut writer, pid) = pending_child();
        writer.write_all(&bytes).unwrap();
        drop(writer);
        let error = acknowledge_exec(pending, Instant::now() + Duration::from_secs(5))
            .await
            .err()
            .expect("exec failure must not return a child");
        if bytes.len() == size_of::<i32>() {
            assert_eq!(
                error.raw_os_error(),
                Some(i32::from_ne_bytes(bytes.try_into().unwrap()))
            );
        } else {
            assert_eq!(error.to_string(), "incomplete process exec error");
        }
        assert_reaped(pid);
    }
}

#[tokio::test]
async fn aborting_pending_acknowledgement_reaps_before_join() {
    let (pending, _writer, pid) = pending_child();
    let (queued, observed) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let mut ack = Box::pin(acknowledge_exec(
            pending,
            Instant::now() + Duration::from_secs(5),
        ));
        poll_fn(|cx| {
            assert!(ack.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        queued.send(()).unwrap();
        ack.await
    });
    observed.await.unwrap();
    task.abort();
    assert!(
        task.await
            .err()
            .expect("pending task must be cancelled")
            .is_cancelled()
    );
    assert_reaped(pid);
}

#[test]
fn reactor_registration_panic_reaps_pending_child() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let (pending, _writer, pid) = pending_child();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        runtime.block_on(acknowledge_exec(
            pending,
            Instant::now() + Duration::from_secs(5),
        ))
    }));
    assert!(result.is_err());
    assert_reaped(pid);
}

async fn poll_queued(future: Pin<&mut impl Future<Output = io::Result<Child>>>) {
    let mut future = future;
    poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
}

fn command_with_owned_pipe() -> (Command, UnixStream) {
    let (owned, peer) = UnixStream::pair().unwrap();
    peer.set_nonblocking(true).unwrap();
    let mut command = Command::new("/bin/true");
    command.stdin(Stdio::Owned(owned.into()));
    (command, peer)
}

async fn assert_pipe_closed(peer: UnixStream) {
    use tokio::io::AsyncReadExt;

    // Concurrent process tests can inherit a CLOEXEC descriptor briefly
    // between fork and exec. Observe closure with a bound instead of assuming
    // no other test has a transient copy when this task finishes dropping it.
    let mut peer = tokio::net::UnixStream::from_std(peer).unwrap();
    let mut byte = [0];
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), peer.read(&mut byte))
            .await
            .expect("cancelled launch must release its pipe")
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn dropping_a_queued_launch_releases_its_resources() {
    let directory = File::open("/").unwrap();
    let admission = tokio::sync::Mutex::new(());
    let held = admission.lock().await;
    let (command, mut peer) = command_with_owned_pipe();
    let mut spawn = Box::pin(spawn_with_admission(
        command,
        directory.as_fd(),
        SpawnOptions::default(),
        &admission,
        Instant::now() + Duration::from_secs(5),
    ));
    poll_queued(spawn.as_mut()).await;
    assert_eq!(
        peer.read(&mut [0]).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );

    drop(spawn);
    assert_pipe_closed(peer).await;
    drop(held);
    assert!(admission.try_lock().is_ok());
}

#[tokio::test]
async fn queued_launch_times_out_without_waiting_for_admission_release() {
    let directory = File::open("/").unwrap();
    let admission = tokio::sync::Mutex::new(());
    let held = admission.lock().await;
    let (command, peer) = command_with_owned_pipe();
    let mut spawn = Box::pin(spawn_with_admission(
        command,
        directory.as_fd(),
        SpawnOptions::default(),
        &admission,
        Instant::now() + Duration::from_millis(50),
    ));
    poll_queued(spawn.as_mut()).await;
    let error = tokio::time::timeout(Duration::from_secs(1), spawn)
        .await
        .expect("queue deadline must resolve while the permit is held")
        .err()
        .expect("queued launch must time out");
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_pipe_closed(peer).await;
    drop(held);
    assert!(admission.try_lock().is_ok());
}

#[tokio::test]
async fn aborting_a_queued_task_does_not_leave_a_detached_spawn() {
    let admission = Arc::new(tokio::sync::Mutex::new(()));
    let held = admission.lock().await;
    let task_admission = Arc::clone(&admission);
    let (command, peer) = command_with_owned_pipe();
    let (queued, observed) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let directory = File::open("/").unwrap();
        let mut spawn = Box::pin(spawn_with_admission(
            command,
            directory.as_fd(),
            SpawnOptions::default(),
            &task_admission,
            Instant::now() + Duration::from_secs(5),
        ));
        poll_queued(spawn.as_mut()).await;
        queued.send(()).unwrap();
        spawn.await
    });
    observed.await.unwrap();
    task.abort();
    let error = tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .expect("abort must complete while the permit is held")
        .err()
        .expect("queued task must be cancelled");
    assert!(error.is_cancelled());
    assert_pipe_closed(peer).await;
    drop(held);
    assert!(admission.try_lock().is_ok());
}

#[tokio::test]
async fn ready_admission_does_not_override_an_expired_deadline() {
    let directory = File::open("/").unwrap();
    let admission = tokio::sync::Mutex::new(());
    let mut command = Command::new("/bin/true");
    command.arg("invalid\0argument");
    let error = spawn_with_admission(
        command,
        directory.as_fd(),
        SpawnOptions::default(),
        &admission,
        Instant::now() - Duration::from_secs(1),
    )
    .await
    .err()
    .expect("expired admission must not prepare or spawn");
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert!(admission.try_lock().is_ok());
}

#[tokio::test]
async fn preparation_and_clone_errors_release_admission() {
    let directory = File::open("/").unwrap();
    let admission = tokio::sync::Mutex::new(());
    for malformed in [true, false] {
        let mut command = Command::new("/bin/true");
        if malformed {
            command.arg("invalid\0argument");
        }
        let error = spawn_with_admission(
            command,
            directory.as_fd(),
            SpawnOptions::default(),
            &admission,
            Instant::now() + Duration::from_secs(5),
        )
        .await
        .err()
        .expect("malformed input or non-cgroup directory must reject launch");
        if malformed {
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        } else {
            assert!(error.raw_os_error().is_some(), "{error}");
        }
        assert!(admission.try_lock().is_ok());
    }
}
