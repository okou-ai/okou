use std::fs::File;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use nix::fcntl::Flock;

use crate::error::{RunnerError, RunnerResult};

use super::cleanup::TemplateCleanup;

#[cfg(test)]
mod process_tests;

pub(super) const TEMPLATE_BUILD_SCRIPT: &str = include_str!("../../../scripts/build-template.sh");
const VERIFY_SCRIPT: &str = include_str!("../../../scripts/verify-rootfs.sh");
pub(super) const CUSTOMIZE_SCRIPT: &str = include_str!("../../../scripts/customize-rootfs.sh");

pub(super) struct RootfsScripts {
    temp_dir: Option<Arc<tempfile::TempDir>>,
    primary_lock: Arc<Flock<File>>,
    template_lock: Option<Arc<Flock<File>>>,
    launcher: PathBuf,
}

/// The extracted scripts and locks must outlive an in-flight process, including cancellation.
#[derive(Clone)]
pub(super) struct RootfsScriptDir {
    directory: Arc<tempfile::TempDir>,
    locks: Vec<Arc<Flock<File>>>,
    launcher: PathBuf,
}

impl std::ops::Deref for RootfsScriptDir {
    type Target = Path;

    fn deref(&self) -> &Path {
        self.directory.path()
    }
}

pub(super) struct RootfsScriptCommand {
    pub(super) command: std::process::Command,
    directory: RootfsScriptDir,
    inherited_locks: Vec<OwnedFd>,
}

impl RootfsScripts {
    pub(super) fn new(
        primary_lock: Arc<Flock<File>>,
        template_lock: Option<Arc<Flock<File>>>,
    ) -> Self {
        Self {
            temp_dir: None,
            primary_lock,
            template_lock,
            launcher: PathBuf::from("unshare"),
        }
    }

    #[cfg(test)]
    pub(super) fn from_temp_dir(temp_dir: tempfile::TempDir) -> Self {
        let primary_lock = Arc::new(
            Flock::lock(
                tempfile::tempfile().unwrap(),
                nix::fcntl::FlockArg::LockExclusive,
            )
            .unwrap(),
        );
        Self {
            // A checked-in executable avoids ETXTBSY from writable fixture
            // descriptors inherited by unrelated parallel test processes.
            launcher: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/unshare-fixture.sh"),
            temp_dir: Some(Arc::new(temp_dir)),
            primary_lock,
            template_lock: None,
        }
    }

    pub(super) fn release_template_lock(&mut self) {
        self.template_lock = None;
    }

    pub(super) fn retain_template_lock(&mut self, guard: Arc<Flock<File>>) {
        self.template_lock = Some(guard);
    }

    pub(super) fn cleanup(&self) -> TemplateCleanup {
        TemplateCleanup::new(Arc::clone(&self.primary_lock))
    }

    pub(super) async fn path(&mut self) -> RunnerResult<RootfsScriptDir> {
        if self.temp_dir.is_none() {
            self.temp_dir = Some(Arc::new(create_rootfs_scripts_dir().await?));
        }
        match self.temp_dir.as_ref() {
            Some(directory) => Ok(RootfsScriptDir {
                directory: Arc::clone(directory),
                locks: std::iter::once(Arc::clone(&self.primary_lock))
                    .chain(self.template_lock.iter().cloned())
                    .collect(),
                launcher: self.launcher.clone(),
            }),
            None => Err(RunnerError::Internal(
                "rootfs scripts dir was not initialized".into(),
            )),
        }
    }
}

async fn create_rootfs_scripts_dir() -> RunnerResult<tempfile::TempDir> {
    let dir =
        tempfile::tempdir().map_err(|e| RunnerError::Internal(format!("create temp dir: {e}")))?;
    tokio::fs::write(dir.path().join("build-template.sh"), TEMPLATE_BUILD_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write template build script: {e}")))?;
    tokio::fs::write(dir.path().join("verify-rootfs.sh"), VERIFY_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write verify script: {e}")))?;
    tokio::fs::write(dir.path().join("customize-rootfs.sh"), CUSTOMIZE_SCRIPT)
        .await
        .map_err(|e| RunnerError::Internal(format!("write customize script: {e}")))?;
    Ok(dir)
}

// Only the external unshare waiter retains the inherited flock descriptors.
// Namespace-init exit kills all descendants, even across sudo/process groups;
// unshare waits for that teardown before exiting and closing the locks.
const ROOTFS_SUPERVISOR: &str = r#"
set -euo pipefail
[[ "$$" -eq 1 ]]
while [[ "$1" != -- ]]; do
  lock_fd="$1"
  exec {lock_fd}>&-
  shift
done
shift
trap 'exit 125' TERM
(
  IFS= read -r message || kill -TERM "$$"
) <&0 &
bash "$@" </dev/null &
wait "$!"
"#;

pub(super) fn rootfs_script_command(
    directory: &RootfsScriptDir,
    script: &str,
) -> RunnerResult<RootfsScriptCommand> {
    // Reserve descriptors above stdio: replacing stdin must not overwrite a
    // lock originally opened as fd 0 by a runner launched with closed stdin.
    let inherited_locks = directory
        .locks
        .iter()
        .map(|lock| rustix::io::fcntl_dupfd_cloexec(&***lock, 3))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| RunnerError::Internal(format!("duplicate {script} build locks: {e}")))?;
    let mut command = std::process::Command::new(&directory.launcher);
    command.args([
        "--mount",
        "--pid",
        "--fork",
        "--kill-child",
        "--mount-proc",
        "--propagation",
        "private",
        "--",
        "bash",
        "-c",
        ROOTFS_SUPERVISOR,
        "rootfs-supervisor",
    ]);
    for lock in &inherited_locks {
        command.arg(lock.as_raw_fd().to_string());
    }
    command.arg("--").arg(directory.join(script));
    Ok(RootfsScriptCommand {
        command,
        directory: directory.clone(),
        inherited_locks,
    })
}

pub(super) async fn run_rootfs_script(
    command: RootfsScriptCommand,
    label: &str,
) -> RunnerResult<std::process::ExitStatus> {
    let (owner, child_control) = UnixStream::pair()
        .map_err(|e| RunnerError::Internal(format!("create {label} ownership channel: {e}")))?;
    let label = label.to_owned();
    // Spawn and wait belong to the same non-cancellable task. Its Arc guards
    // prevent Flock::drop from explicitly unlocking during async cancellation.
    // If the runner dies instead, the external unshare waiter still owns the
    // same open file descriptions. Never kill that waiter on future drop.
    let task = tokio::task::spawn_blocking(move || {
        let RootfsScriptCommand {
            mut command,
            directory,
            inherited_locks,
        } = command;
        let descriptors: Vec<_> = inherited_locks
            .iter()
            .map(|lock| lock.as_raw_fd())
            .collect();
        command.stdin(std::process::Stdio::from(OwnedFd::from(child_control)));
        // SAFETY: setsid and fcntl are async-signal-safe. inherited_locks owns
        // these descriptors through spawn; only the forked child is changed.
        unsafe {
            command.pre_exec(move || {
                // An orphaned process group containing a stopped worker gets
                // SIGHUP/SIGCONT when its owner dies. A separate session keeps
                // that job-control signal from killing the lock-holding waiter.
                if nix::libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                for descriptor in &descriptors {
                    if nix::libc::fcntl(*descriptor, nix::libc::F_SETFD, 0) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        let mut child = command
            .spawn()
            .map_err(|e| RunnerError::Internal(format!("spawn {label}: {e}")))?;
        drop(inherited_locks);
        let status = child
            .wait()
            .map_err(|e| RunnerError::Internal(format!("wait for {label}: {e}")));
        drop(directory);
        status
    });
    // Abort prevents a queued blocking task from starting after cancellation;
    // it cannot interrupt a running blocking task's owned-child wait.
    let result = tokio_util::task::AbortOnDropHandle::new(task)
        .await
        .map_err(|e| RunnerError::Internal(format!("rootfs script task: {e}")))?;
    drop(owner);
    result
}

#[cfg(test)]
mod tests;
