use super::*;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use tokio::io::{AsyncBufReadExt, BufReader};

/// Only used in the isolated test process, after all required descriptors exist.
struct ExhaustedFileDescriptors(libc::rlimit);

impl ExhaustedFileDescriptors {
    fn new() -> Self {
        let mut previous = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: the output points to initialized storage. This exact-test
        // subprocess has no other tests whose descriptor limit could change.
        assert_eq!(
            unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut previous) },
            0
        );
        let exhausted = libc::rlimit {
            rlim_cur: 0,
            rlim_max: previous.rlim_max,
        };
        // SAFETY: reducing the soft limit preserves every existing descriptor.
        assert_eq!(
            unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &exhausted) },
            0
        );
        Self(previous)
    }
}

impl Drop for ExhaustedFileDescriptors {
    fn drop(&mut self) {
        // SAFETY: restore the original soft limit before harness diagnostics.
        assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &self.0) }, 0);
    }
}

struct DescendantCleanup(OwnedFd);

impl Drop for DescendantCleanup {
    fn drop(&mut self) {
        // SAFETY: this pidfd identifies the test descendant even after exit;
        // failure cleanup must never signal a potentially reused numeric PID.
        unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.0.as_raw_fd(),
                libc::SIGKILL,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            );
        }
    }
}

#[tokio::test]
async fn managed_monitor_cleans_group_with_exhausted_file_descriptors() {
    const CHILD_ENV: &str = "OKOU_TEST_MANAGED_MONITOR_FD_PRESSURE";
    if std::env::var_os(CHILD_ENV).is_none() {
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "sandbox::tests::managed_exit::managed_monitor_cleans_group_with_exhausted_file_descriptors",
                "--nocapture",
            ])
            .env(CHILD_ENV, "1")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let result = tokio::time::timeout(Duration::from_secs(15), child.wait()).await;
        if result.is_err() {
            child.kill().await.unwrap();
        }
        assert!(
            result
                .expect("isolated monitor regression must finish")
                .unwrap()
                .success()
        );
        return;
    }

    let process = std::process::Command::new("/bin/bash")
        .args([
            "-c",
            "trap '' HUP; sleep 60 & printf '%s\\n' \"$!\"; read -r release; exit 7",
        ])
        .process_group(0)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut child =
        process_launch::asynchronous::Child::try_from(process_launch::Child::from(process))
            .unwrap();
    let pid = child.id().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut descendant_line = String::new();
    tokio::time::timeout(
        Duration::from_secs(2),
        stdout.read_line(&mut descendant_line),
    )
    .await
    .unwrap()
    .unwrap();
    let descendant_pid: u32 = descendant_line.trim().parse().unwrap();
    let _descendant_cleanup =
        DescendantCleanup(process_launch::asynchronous::open_pidfd(descendant_pid).unwrap());
    assert!(pid_is_running(descendant_pid));

    let state = Arc::new(AtomicU8::new(SandboxState::Running as u8));
    let state_publish_lock = Arc::new(Mutex::new(()));
    let (state_tx, _state_rx) = watch::channel(SandboxState::Running);
    let guest = Arc::new(tokio::sync::Mutex::new(None::<Arc<GuestControlClient>>));
    let exhausted = ExhaustedFileDescriptors::new();
    assert_eq!(
        process_launch::asynchronous::open_pidfd(pid)
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EMFILE)
    );

    stdin.write_all(b"exit\n").await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), child.exit_notification().unwrap())
        .await
        .unwrap()
        .unwrap();
    // SAFETY: WNOWAIT proves observation has left the exact leader unreaped.
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
    // SAFETY: successful waitid initialized these child-status fields.
    assert_eq!(unsafe { info.si_pid() }, pid as i32);
    assert_eq!(unsafe { info.si_status() }, 7);

    let handle = monitor_process(
        "managed-fd-pressure",
        child,
        Arc::clone(&state),
        state_publish_lock,
        state_tx,
        guest,
        CancellationToken::new(),
    );
    let exit = handle.exit.clone();
    tokio::time::timeout(Duration::from_secs(2), handle.wait())
        .await
        .expect("managed monitor must finish using its already registered pidfd");
    assert!(
        exit.confirmed().await,
        "monitor must confirm a successful reap"
    );
    // Keep EMFILE in force throughout monitoring, then permit /proc assertions.
    drop(exhausted);

    assert!(
        wait_for_pid_not_running(descendant_pid).await,
        "managed monitor must terminate the descendant despite FD exhaustion"
    );
    assert_eq!(
        SandboxState::from_u8(state.load(Ordering::Acquire)),
        SandboxState::Crashed
    );
    // SAFETY: this checks only the test leader; WNOHANG bounds a failed reap.
    assert_eq!(
        unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG) },
        -1
    );
    assert_eq!(
        io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD)
    );
}
