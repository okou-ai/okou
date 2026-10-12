//! Actual parent death after secret-free Ready and before password delivery.
#![cfg(test)]
#![cfg(target_os = "linux")]
pub mod common;

use kerberos_worker::{Credentials, Error, KdcExchange, Password, Source};
use rustix::process::{
    Pid, PidfdFlags, Signal, WaitOptions, child_subreaper, pidfd_open, pidfd_send_signal,
    set_child_subreaper, waitpid,
};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
use tokio::time::Instant;
use zeroize::Zeroizing;

fn children() -> Vec<u32> {
    let mut children = Vec::new();
    for task in fs::read_dir("/proc/self/task").unwrap() {
        if let Ok(text) = fs::read_to_string(task.unwrap().path().join("children")) {
            children.extend(text.split_whitespace().map(|id| id.parse::<u32>().unwrap()));
        }
    }
    children
}

struct BeforeCredentials {
    calls: usize,
    root: PathBuf,
}
impl KdcExchange for BeforeCredentials {
    async fn authorize(&mut self) -> Result<(), Error> {
        self.calls += 1;
        if self.calls == 1 {
            return Ok(());
        }
        // Public open has verified Ready and unlinked the empty input names.
        // This second authority gate precedes the password/initialize IPC frame.
        assert_eq!(self.calls, 2);
        let children = children();
        assert_eq!(children.len(), 1);
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.root.join("ready.pid"))
            .unwrap()
            .write_all(&children[0].to_be_bytes())
            .unwrap();
        std::future::pending().await
    }
    async fn exchange(&mut self, _: &str, _: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
        panic!("parent must die before credentials or KDC work")
    }
}

#[tokio::test]
#[ignore = "requires supported native Linux namespace/Landlock runtime; strict matrix job"]
async fn stopped_ready_worker_dies_with_parent_before_credentials_and_is_actually_reaped() {
    if let Some(root) = std::env::var_os("KERBEROS_PARENT_DEATH_ROOT") {
        let root = PathBuf::from(root);
        let mut caller = BeforeCredentials {
            calls: 0,
            root: root.clone(),
        };
        let credentials = Credentials::new(
            common::principal(&["probe"]),
            common::principal(&["vnc", "fixture"]),
            Source::Password(
                Password::new(Zeroizing::new("synthetic-parent-death-only".into())).unwrap(),
            ),
        )
        .unwrap();
        let result = kerberos_worker::open(
            &root,
            credentials,
            common::policy(),
            Instant::now() + Duration::from_secs(30),
            &mut caller,
        )
        .await;
        panic!("unexpected child completion before the parent-death control: {result:?}");
    }

    let root = common::root();
    let path = root.path().canonicalize().unwrap();
    let marker = path.join("ready.pid");
    let before = children();
    let previous = child_subreaper().unwrap();
    // The attribute is process-local. Rustix represents its nonzero Boolean as Pid.
    set_child_subreaper(Pid::from_raw(1)).unwrap();
    let mut parent = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "stopped_ready_worker_dies_with_parent_before_credentials_and_is_actually_reaped",
            "--ignored",
            "--test-threads=1",
        ])
        .env_clear()
        .env("KERBEROS_PARENT_DEATH_ROOT", &path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut native = None;
    let mut reaped = false;
    // Keep all assertions until owned-process cleanup, including a failing control.
    let outcome = async {
        let until = Instant::now() + Duration::from_secs(5);
        let id = loop {
            match fs::read(&marker) {
                Ok(bytes) if bytes.len() == 4 => {
                    break u32::from_be_bytes(
                        bytes.try_into().map_err(|_| {
                            std::io::Error::other("invalid public readiness marker")
                        })?,
                    );
                }
                Ok(bytes) if bytes.len() < 4 && Instant::now() < until => {
                    tokio::task::yield_now().await
                }
                Ok(_) => return Err(std::io::Error::other("invalid public readiness marker")),
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound && Instant::now() < until =>
                {
                    tokio::task::yield_now().await
                }
                Err(error) => return Err(error),
            }
        };
        let pid = Pid::from_raw(
            i32::try_from(id).map_err(|_| std::io::Error::other("invalid process id"))?,
        )
        .ok_or_else(|| std::io::Error::other("missing process id"))?;
        let handle = pidfd_open(pid, PidfdFlags::empty())?;
        native = Some((pid, handle));
        let stat = fs::read_to_string(format!("/proc/{id}/stat"))?;
        let (_, fields) = stat
            .rsplit_once(") ")
            .ok_or_else(|| std::io::Error::other("invalid process state"))?;
        if fields.split_whitespace().nth(1) != Some(parent.id().to_string().as_str()) {
            return Err(std::io::Error::other(
                "readiness marker does not belong to the owned parent",
            ));
        }
        pidfd_send_signal(&native.as_ref().unwrap().1, Signal::STOP)?;
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            let stat = fs::read_to_string(format!("/proc/{id}/stat"))?;
            let (_, fields) = stat
                .rsplit_once(") ")
                .ok_or_else(|| std::io::Error::other("invalid stopped state"))?;
            if fields.split_whitespace().next() == Some("T") {
                break;
            }
            if Instant::now() >= until {
                return Err(std::io::Error::other("owned worker did not stop"));
            }
            tokio::task::yield_now().await;
        }
        // A stopped worker cannot notice stdin EOF or finish a Rust wall timer.
        // SIGKILL of the real parent must cause the native PDEATHSIG to kill it.
        parent.kill()?;
        parent.wait()?;
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some((waited, status)) = waitpid(Some(pid), WaitOptions::NOHANG)? {
                reaped = true;
                if waited != pid || status.terminating_signal() != Some(Signal::KILL.as_raw()) {
                    return Err(std::io::Error::other(
                        "worker did not terminate by the parent-death signal",
                    ));
                }
                break;
            }
            if Instant::now() >= until {
                return Err(std::io::Error::other(
                    "parent-death termination was not observed",
                ));
            }
            tokio::task::yield_now().await;
        }
        if Path::new(&format!("/proc/{id}")).exists() {
            return Err(std::io::Error::other("reaped worker still exists"));
        }
        Ok::<(), std::io::Error>(())
    }
    .await;
    // Cleanup remains mandatory even when the stopped-parent control fails.
    if parent.try_wait().unwrap().is_none() {
        parent.kill().unwrap();
    }
    parent.wait().unwrap();
    if let Some((pid, handle)) = &native
        && !reaped
    {
        match pidfd_send_signal(handle, Signal::KILL) {
            Ok(()) | Err(rustix::io::Errno::SRCH) => (),
            Err(error) => panic!("owned native cleanup failed: {error}"),
        }
        waitpid(Some(*pid), WaitOptions::empty()).unwrap();
    }
    // A failed readiness observation can still leave an adopted owned worker.
    // This isolated test process starts no other children during the control.
    for id in children().into_iter().filter(|id| !before.contains(id)) {
        let pid = Pid::from_raw(i32::try_from(id).unwrap()).unwrap();
        let handle = pidfd_open(pid, PidfdFlags::empty()).unwrap();
        match pidfd_send_signal(&handle, Signal::KILL) {
            Ok(()) | Err(rustix::io::Errno::SRCH) => (),
            Err(error) => panic!("adopted native cleanup failed: {error}"),
        }
        waitpid(Some(pid), WaitOptions::empty()).unwrap();
    }
    set_child_subreaper(previous).unwrap();
    match fs::remove_file(marker) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => panic!("owned marker cleanup failed: {error}"),
    }
    assert_eq!(fs::read_dir(path).unwrap().count(), 0);
    outcome.unwrap();
}
