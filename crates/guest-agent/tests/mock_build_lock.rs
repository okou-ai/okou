//! Cross-process coverage for the mock-package build lock shared by guest-agent tests.

mod common;

use std::fs::{OpenOptions, TryLockError};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;
use tokio::process::{Child, Command};

const TEST_NAME: &str = "mock_build_lock_recovers_after_holder_exit";
const HOLDER_ENV: &str = "OKOU_MOCK_BUILD_LOCK_TEST_HOLDER";
const LOCK_PATH_ENV: &str = "OKOU_MOCK_BUILD_LOCK_TEST_PATH";
const STARTED_PATH_ENV: &str = "OKOU_MOCK_BUILD_LOCK_TEST_STARTED_PATH";
const READY_PATH_ENV: &str = "OKOU_MOCK_BUILD_LOCK_TEST_READY_PATH";
const PROCESS_TIMEOUT: Duration = Duration::from_secs(5);

struct HolderProcess {
    child: Child,
}

impl HolderProcess {
    fn spawn(lock: &Path, started: &Path, ready: &Path) -> io::Result<Self> {
        let child = Command::new(std::env::current_exe()?)
            .arg("--exact")
            .arg(TEST_NAME)
            .arg("--nocapture")
            .env(HOLDER_ENV, "1")
            .env(LOCK_PATH_ENV, lock)
            .env(STARTED_PATH_ENV, started)
            .env(READY_PATH_ENV, ready)
            .stdin(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        Ok(Self { child })
    }

    async fn crash(&mut self) -> io::Result<()> {
        self.child.start_kill()?;
        let status = wait_for_exit(&mut self.child, "crashed holder").await?;
        if status.success() {
            return Err(io::Error::other(format!(
                "crashed holder exited successfully: {status}"
            )));
        }
        Ok(())
    }

    async fn release(&mut self) -> io::Result<()> {
        drop(self.child.stdin.take());
        let status = wait_for_exit(&mut self.child, "released holder").await?;
        if !status.success() {
            return Err(io::Error::other(format!(
                "released holder failed: {status}"
            )));
        }
        Ok(())
    }
}

#[tokio::test]
async fn mock_build_lock_recovers_after_holder_exit() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::var_os(HOLDER_ENV).is_some() {
        run_holder(&required_path(LOCK_PATH_ENV)?)?;
        return Ok(());
    }

    let temp = tempfile::tempdir()?;
    let lock = temp.path().join("mock-build.lock");
    let first_started = temp.path().join("first-started");
    let first_ready = temp.path().join("first-ready");
    let successor_started = temp.path().join("successor-started");
    let successor_ready = temp.path().join("successor-ready");

    let mut first = HolderProcess::spawn(&lock, &first_started, &first_ready)?;
    common::wait_for_path(&first_ready, PROCESS_TIMEOUT).await?;
    assert!(
        !shared_lock_is_available(&lock)?,
        "first holder should exclude shared contenders"
    );
    assert!(
        !lock_is_available(&lock)?,
        "first holder should exclude the parent process"
    );

    let mut successor = HolderProcess::spawn(&lock, &successor_started, &successor_ready)?;
    common::wait_for_path(&successor_started, PROCESS_TIMEOUT).await?;
    assert!(
        !lock_is_available(&lock)?,
        "first holder should remain exclusive while successor waits"
    );

    first.crash().await?;
    common::wait_for_path(&successor_ready, PROCESS_TIMEOUT).await?;
    assert!(
        !shared_lock_is_available(&lock)?,
        "successor should exclude shared contenders"
    );
    assert!(
        !lock_is_available(&lock)?,
        "successor should exclude the parent process"
    );

    successor.release().await?;
    assert!(
        lock_is_available(&lock)?,
        "released successor should make the lock available"
    );
    assert!(lock.is_file(), "lock pathname should remain stable");

    Ok(())
}

fn run_holder(lock: &Path) -> io::Result<()> {
    let started = required_path(STARTED_PATH_ENV)?;
    let ready = required_path(READY_PATH_ENV)?;
    std::fs::write(started, b"started")?;
    let _lock = common::acquire_mock_build_lock(lock).map_err(io::Error::other)?;
    std::fs::write(ready, b"ready")?;

    let mut input = Vec::new();
    io::stdin().read_to_end(&mut input)?;
    Ok(())
}

fn shared_lock_is_available(lock: &Path) -> io::Result<bool> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock)?;
    match file.try_lock_shared() {
        Ok(()) => Ok(true),
        Err(TryLockError::WouldBlock) => Ok(false),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

fn lock_is_available(lock: &Path) -> io::Result<bool> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock)?;
    match file.try_lock() {
        Ok(()) => Ok(true),
        Err(TryLockError::WouldBlock) => Ok(false),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

fn required_path(key: &str) -> io::Result<PathBuf> {
    std::env::var_os(key).map(PathBuf::from).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("missing child path environment variable {key}"),
        )
    })
}

async fn wait_for_exit(child: &mut Child, context: &str) -> io::Result<ExitStatus> {
    tokio::time::timeout(PROCESS_TIMEOUT, child.wait())
        .await
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::TimedOut,
                format!("timed out waiting for {context}"),
            )
        })?
}
