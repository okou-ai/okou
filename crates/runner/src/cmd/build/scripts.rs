use std::fs::File;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use nix::fcntl::Flock;

use crate::error::{RunnerError, RunnerResult};

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
mod tests {
    use super::*;

    fn shell_quoted_var<'a>(script: &'a str, name: &str) -> Option<&'a str> {
        let prefix = format!("{name}=\"");
        script.lines().find_map(|line| {
            let value = line.strip_prefix(&prefix)?;
            value.strip_suffix('"')
        })
    }

    fn is_numeric_semver(version: &str) -> bool {
        let mut parts = version.split('.');
        let Some(major) = parts.next() else {
            return false;
        };
        let Some(minor) = parts.next() else {
            return false;
        };
        let Some(patch) = parts.next() else {
            return false;
        };

        parts.next().is_none()
            && [major, minor, patch]
                .iter()
                .all(|part| matches!(part.parse::<u32>(), Ok(value) if *part == value.to_string()))
    }

    fn is_lowercase_sha256(value: &str) -> bool {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    fn template_build_installs_apt_package(package: &str) -> bool {
        let mut in_apt_install = false;
        for raw_line in TEMPLATE_BUILD_SCRIPT.lines() {
            let line = raw_line.trim();
            if line == r#"apt-get install -y \"# {
                in_apt_install = true;
                continue;
            }

            if !in_apt_install {
                continue;
            }

            let package_line = line.strip_suffix('\\').unwrap_or(line).trim();
            if package_line
                .split_whitespace()
                .any(|token| token == package)
            {
                return true;
            }
            if !line.ends_with('\\') {
                in_apt_install = false;
            }
        }
        false
    }

    async fn wait_for_file(path: &Path) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !path.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {}", path.display()));
    }

    fn test_directory(primary_lock: Arc<Flock<File>>) -> RootfsScriptDir {
        RootfsScriptDir {
            directory: Arc::new(tempfile::tempdir().unwrap()),
            locks: vec![primary_lock],
            launcher: PathBuf::from("unshare"),
        }
    }

    #[tokio::test]
    async fn run_rootfs_script_returns_nonzero_status() {
        let guard = Arc::new(
            Flock::lock(
                tempfile::tempfile().unwrap(),
                nix::fcntl::FlockArg::LockExclusive,
            )
            .unwrap(),
        );
        let mut command = std::process::Command::new("bash");
        command.args(["-c", "exit 17"]);
        let command = RootfsScriptCommand {
            command,
            directory: test_directory(guard),
            inherited_locks: Vec::new(),
        };

        let status = run_rootfs_script(command, "nonzero-status-fixture")
            .await
            .unwrap();

        assert_eq!(status.code(), Some(17));
    }

    #[test]
    fn cancellation_does_not_start_a_queued_script() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        let home = tempfile::tempdir().unwrap();
        let lock_path = home.path().join("rootfs.lock");
        let guard = runtime
            .block_on(crate::lock::acquire(lock_path.clone()))
            .unwrap();
        let directory = test_directory(Arc::new(guard));
        let mut command = std::process::Command::new("bash");
        command.args(["-c", "touch \"$1/started\"", "queued-script"]);
        command.arg(home.path());
        let command = RootfsScriptCommand {
            command,
            directory,
            inherited_locks: Vec::new(),
        };
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let blocker = runtime.spawn_blocking(move || {
            started_tx.send(()).unwrap();
            release_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
        });
        started_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        runtime.block_on(async {
            let task = tokio::spawn(run_rootfs_script(command, "queued-script"));
            tokio::task::yield_now().await;
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        });
        release_tx.send(()).unwrap();
        runtime.block_on(blocker).unwrap();
        // Drain the blocking queue before checking that no child was started.
        runtime.block_on(runtime.spawn_blocking(|| {})).unwrap();
        assert!(!home.path().join("started").exists());
        assert!(
            runtime
                .block_on(crate::lock::try_acquire(lock_path))
                .is_ok()
        );
    }

    #[tokio::test]
    async fn cancellation_retains_lock_and_scripts_until_process_cleanup_finishes() {
        let home = tempfile::tempdir().unwrap();
        let lock_path = home.path().join("rootfs.lock");
        let guard = Arc::new(crate::lock::acquire(lock_path.clone()).await.unwrap());
        let directory = test_directory(guard);
        let scripts_path = directory.directory.path().to_path_buf();
        let mut command = std::process::Command::new("bash");
        command
            .arg("-c")
            .arg(
                r#"
set -euo pipefail
printf ready > "$1/ready"
IFS= read -r message || true
printf cleanup > "$1/cleanup"
for ((attempt = 0; attempt < 500; attempt++)); do
  if [[ -f "$1/release" ]]; then
    exit 0
  fi
  sleep 0.01
done
exit 18
"#,
            )
            .arg("cleanup-fixture")
            .arg(home.path());
        let command = RootfsScriptCommand {
            command,
            directory,
            inherited_locks: Vec::new(),
        };
        let task =
            tokio::spawn(async move { run_rootfs_script(command, "ownership-fixture").await });
        wait_for_file(&home.path().join("ready")).await;

        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        wait_for_file(&home.path().join("cleanup")).await;
        assert!(
            scripts_path.exists(),
            "script directory must survive cancellation"
        );
        assert!(matches!(
            crate::lock::try_acquire_or_busy(lock_path.clone())
                .await
                .unwrap(),
            crate::lock::TryLock::Busy
        ));

        std::fs::write(home.path().join("release"), b"release").unwrap();
        let new_guard = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            crate::lock::acquire(lock_path),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            !scripts_path.exists(),
            "script directory must be removed after cleanup"
        );
        drop(new_guard);
    }

    #[tokio::test]
    async fn rootfs_scripts_writes_embedded_scripts_once() {
        let guard = Arc::new(
            Flock::lock(
                tempfile::tempfile().unwrap(),
                nix::fcntl::FlockArg::LockExclusive,
            )
            .unwrap(),
        );
        let mut scripts = RootfsScripts::new(guard, None);

        let first = scripts.path().await.unwrap();
        let second = scripts.path().await.unwrap();

        assert_eq!(&*first, &*second);
        assert!(first.join("build-template.sh").exists());
        assert!(first.join("verify-rootfs.sh").exists());
        assert!(first.join("customize-rootfs.sh").exists());
    }

    /// Guard the `[sync:ca-constants]` contract between customize-rootfs.sh
    /// and verify-rootfs.sh. Drift would cause silent CA
    /// customization/verification failures on rootfs images.
    #[test]
    fn ca_constants_in_sync_across_scripts() {
        let ca_cert_line = r#"CA_CERT_FILE="mitmproxy-ca-cert.pem""#;
        let ca_dest_line = r#"CA_ROOTFS_DEST="usr/local/share/ca-certificates/vm0-proxy-ca.crt""#;

        assert!(
            CUSTOMIZE_SCRIPT.contains(ca_cert_line),
            "customize-rootfs.sh missing CA_CERT_FILE constant — sync with other scripts"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains(ca_dest_line),
            "customize-rootfs.sh missing CA_ROOTFS_DEST constant — sync with other scripts"
        );

        // verify-rootfs.sh only uses CA_ROOTFS_DEST (it reads the cert from
        // inside the rootfs, not from the host CA_DIR).
        assert!(
            VERIFY_SCRIPT.contains(ca_dest_line),
            "verify-rootfs.sh missing CA_ROOTFS_DEST constant — sync with other scripts"
        );
    }

    /// Guard: customize-rootfs.sh must verify the CA actually made it into the
    /// system bundle after `update-ca-certificates`. `update-ca-certificates`
    /// can exit 0 while silently omitting our cert (e.g. malformed PEM),
    /// which would later surface as an opaque snapshot/VM-boot TLS error.
    /// See #9482.
    #[test]
    fn customize_rootfs_verifies_bundle_after_update() {
        assert!(
            CUSTOMIZE_SCRIPT.contains("update-ca-certificates"),
            "customize-rootfs.sh must call update-ca-certificates"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("proxy CA not found in system bundle"),
            "customize-rootfs.sh must verify proxy CA landed in system bundle after \
             update-ca-certificates (silent failure guard; see #9482)"
        );
        assert!(
            !CUSTOMIZE_SCRIPT.contains("keytool -delete"),
            "customize-rootfs.sh starts from a CA-free template; duplicate Java aliases \
             should fail instead of being silently replaced"
        );
    }

    #[test]
    fn template_build_script_excludes_rootfs_only_inputs() {
        for forbidden in [
            "--guest",
            "--ca-dir",
            "--dns-nameserver",
            "CA_ROOTFS_DEST",
            "NODE_EXTRA_CA_CERTS",
        ] {
            assert!(
                !TEMPLATE_BUILD_SCRIPT.contains(forbidden),
                "template build script must not embed rootfs-only input: {forbidden}"
            );
        }
    }

    #[test]
    fn customize_script_uses_chroot_install_for_destinations() {
        assert!(
            CUSTOMIZE_SCRIPT.contains("sudo chroot \"$MOUNT_DIR\" install -D"),
            "customize-rootfs.sh should install inside the chroot so /sbin -> /usr/sbin \
             resolves like it does at boot"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("realpath -m -- \"$parent\""),
            "customize-rootfs.sh should resolve destination parents inside the chroot"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("runtime mount"),
            "customize-rootfs.sh should reject writes that resolve under /proc, /sys, or /dev"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("sudo chroot \"$MOUNT_DIR\" rm -f -- \"$safe_dest\""),
            "customize-rootfs.sh should replace existing target symlinks instead of \
             overwriting through them"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("mktemp -d -p \"$MOUNT_DIR\""),
            "customize-rootfs.sh should create temp files directly under the mounted root, \
             not below an untrusted in-rootfs parent like /tmp"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("/proc, /sys, and /dev are not mounted yet"),
            "customize-rootfs.sh should document why file writes happen before runtime bind mounts"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("unsafe rootfs destination component"),
            "customize-rootfs.sh should reject lexical path escapes before chroot install"
        );
    }

    #[test]
    fn customize_script_fails_when_cleanup_fails() {
        assert!(
            CUSTOMIZE_SCRIPT.contains("local status=$?"),
            "customize-rootfs.sh cleanup should preserve the original command status"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("cleanup_failed=1"),
            "customize-rootfs.sh should track cleanup failures"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("if ! rmdir \"$MOUNT_DIR\""),
            "customize-rootfs.sh should treat mount temp dir cleanup failure as a cleanup failure"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("error: rootfs cleanup failed"),
            "customize-rootfs.sh should fail a successful customization if cleanup fails"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("exit \"$status\""),
            "customize-rootfs.sh EXIT trap should return cleanup-adjusted status"
        );
    }

    #[test]
    fn build_script_fails_when_successful_cleanup_fails() {
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("local status=$?"),
            "build-template.sh cleanup should preserve the original command status"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("error: template build cleanup failed"),
            "build-template.sh should fail a successful build if temp rootfs cleanup fails"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("exit \"$status\""),
            "build-template.sh EXIT trap should return cleanup-adjusted status"
        );
    }

    #[test]
    fn build_script_outputs_template_file() {
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(r#"TEMPLATE_FILE="template.ext4""#),
            "build-template.sh should produce a template image, not the rootfs image filename"
        );
    }

    #[test]
    fn template_installs_and_verifies_pnpm() {
        let pnpm_version = shell_quoted_var(TEMPLATE_BUILD_SCRIPT, "PNPM_VERSION")
            .expect("build-template.sh should declare PNPM_VERSION");
        assert!(
            is_numeric_semver(pnpm_version),
            "build-template.sh should pin PNPM_VERSION to an exact numeric semver so template \
             cache inputs are deterministic"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("pnpm@${PNPM_VERSION}"),
            "build-template.sh should install pnpm into sandbox templates"
        );
        assert!(
            VERIFY_SCRIPT.contains(r#""${MOUNT_DIR}/usr/bin/pnpm""#),
            "verify-rootfs.sh should verify pnpm is present in sandbox images"
        );
    }

    #[test]
    fn template_installs_vm0_agent_browser_for_each_guest_architecture() {
        let agent_browser_version =
            shell_quoted_var(TEMPLATE_BUILD_SCRIPT, "AGENT_BROWSER_VERSION")
                .expect("build-template.sh should declare AGENT_BROWSER_VERSION");
        assert_eq!(
            agent_browser_version, "0.33.0-vm0.1",
            "build-template.sh should pin the immutable vm0 agent-browser release"
        );

        for checksum_var in [
            "AGENT_BROWSER_LINUX_X64_SHA256",
            "AGENT_BROWSER_LINUX_ARM64_SHA256",
        ] {
            let checksum = shell_quoted_var(TEMPLATE_BUILD_SCRIPT, checksum_var)
                .unwrap_or_else(|| panic!("build-template.sh should declare {checksum_var}"));
            assert!(
                is_lowercase_sha256(checksum),
                "build-template.sh should pin {checksum_var} to a lowercase SHA-256"
            );
        }

        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(
                r#"DOWNLOAD_BASE_URL=\"https://github.com/vm0-ai/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}\""#
            ),
            "build-template.sh should download agent-browser from the vm0 fork"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(
                r#"amd64)
        PLATFORM=\"linux-x64\"
        CHECKSUM=\"${AGENT_BROWSER_LINUX_X64_SHA256}\""#
            ) && TEMPLATE_BUILD_SCRIPT.contains(
                r#"arm64)
        PLATFORM=\"linux-arm64\"
        CHECKSUM=\"${AGENT_BROWSER_LINUX_ARM64_SHA256}\""#
            ),
            "build-template.sh should map Debian guest architectures to fork release assets"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT
                .contains(r#"echo \"\${CHECKSUM}  /tmp/agent-browser\" | sha256sum -c -"#),
            "build-template.sh should verify agent-browser before installation"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(
                r#"curl -fsSL \"\${DOWNLOAD_BASE_URL}/agent-browser-\${PLATFORM}\" -o /tmp/agent-browser"#
            ),
            "build-template.sh should download the mapped release asset"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT
                .contains("install -m 0755 /tmp/agent-browser /usr/local/bin/agent-browser"),
            "build-template.sh should install the verified native binary"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(
                r#"test \"\$(/usr/local/bin/agent-browser --version)\" = \"agent-browser ${AGENT_BROWSER_VERSION}\""#
            ),
            "build-template.sh should execute the installed binary and verify its version"
        );
        assert!(
            !TEMPLATE_BUILD_SCRIPT.contains("agent-browser@"),
            "build-template.sh must not install the upstream npm package"
        );
        assert!(
            VERIFY_SCRIPT.contains(
                r#"check_required_executable "/usr/local/bin/agent-browser" "agent-browser CLI""#
            ),
            "verify-rootfs.sh should verify the native agent-browser binary"
        );
    }

    #[test]
    fn template_installs_and_verifies_ffmpeg() {
        assert!(
            template_build_installs_apt_package("ffmpeg"),
            "build-template.sh should install ffmpeg into sandbox templates"
        );
        assert!(
            VERIFY_SCRIPT.contains(r#"check_required_executable "/usr/bin/ffmpeg" "ffmpeg""#),
            "verify-rootfs.sh should verify ffmpeg is present in sandbox images"
        );
    }

    #[test]
    fn template_installs_and_verifies_presentation_renderers() {
        for package in ["libreoffice-impress", "poppler-utils"] {
            assert!(
                template_build_installs_apt_package(package),
                "build-template.sh should install {package} into sandbox templates"
            );
        }

        for (path, name) in [
            ("/usr/bin/soffice", "LibreOffice"),
            ("/usr/bin/pdftocairo", "Poppler pdftocairo"),
        ] {
            let check = format!(r#"check_required_executable "{path}" "{name}""#);
            assert!(
                VERIFY_SCRIPT.contains(&check),
                "verify-rootfs.sh should verify {name} is present in sandbox images"
            );
        }
    }

    #[test]
    fn template_installs_and_verifies_legacy_timezone_links() {
        assert!(
            template_build_installs_apt_package("tzdata-legacy"),
            "build-template.sh should install legacy IANA timezone links"
        );
        assert!(
            VERIFY_SCRIPT.contains(
                r#"check_required_file_contains "/usr/share/zoneinfo/Asia/Calcutta" "TZif" \"#
            ),
            "verify-rootfs.sh should verify the legacy IANA timezone link resolves to a timezone file"
        );
    }

    #[test]
    fn template_installs_and_verifies_noto_fonts() {
        for package in [
            "fonts-noto-core",
            "fonts-noto-cjk",
            "fonts-noto-color-emoji",
        ] {
            assert!(
                template_build_installs_apt_package(package),
                "build-template.sh should install {package}"
            );
        }

        for (path, name) in [
            (
                "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
                "Noto Sans",
            ),
            (
                "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf",
                "Noto Sans Arabic",
            ),
            (
                "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                "Noto Sans CJK",
            ),
            (
                "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
                "Noto Color Emoji",
            ),
        ] {
            let check = format!(r#"check_bin "{path}" "{name}""#);
            assert!(
                VERIFY_SCRIPT.contains(&check),
                "verify-rootfs.sh should verify {name} is present in sandbox images"
            );
        }
    }

    #[test]
    fn template_installs_and_verifies_pgvector() {
        assert!(
            template_build_installs_apt_package("postgresql-18-pgvector"),
            "build-template.sh should install pgvector into sandbox templates"
        );
        assert!(
            VERIFY_SCRIPT.contains(
                r#"check_bin "/usr/share/postgresql/*/extension/vector.control" "pgvector extension""#
            ),
            "verify-rootfs.sh should verify pgvector is present in sandbox images"
        );
    }

    #[test]
    fn verify_script_checks_sandbox_helper_runtime_commands() {
        assert!(
            VERIFY_SCRIPT.contains("resolve_rootfs_path()"),
            "verify-rootfs.sh should resolve required executable symlinks within the mounted rootfs"
        );
        assert!(
            VERIFY_SCRIPT.contains(
                "for cmd in sudo unshare mount umount mountpoint stat mktemp sed grep readlink; do"
            ),
            "verify-rootfs.sh should declare readlink as a host dependency for safe symlink resolution"
        );
        assert!(
            VERIFY_SCRIPT
                .lines()
                .filter(|line| !line.trim_start().starts_with('#'))
                .all(|line| !line.contains("chroot")),
            "verify-rootfs.sh must not chroot into the image it is verifying"
        );

        for (group, command_paths) in [
            (
                "shell wrapper runtime",
                &["/bin/sh", "/bin/bash", "/usr/bin/su", "/usr/bin/rmdir"][..],
            ),
            (
                "guest state runtime",
                &["/usr/bin/date", "/usr/bin/ln", "/usr/bin/sed"][..],
            ),
            (
                "storage and Codex cleanup runtime",
                &[
                    "/usr/bin/rm",
                    "/usr/bin/find",
                    "/usr/bin/awk",
                    "/usr/bin/xargs",
                    "/usr/bin/mktemp",
                    "/usr/bin/tr",
                ][..],
            ),
            (
                "workspace mount and freeze runtime",
                &[
                    "/usr/bin/mountpoint",
                    "/usr/bin/mount",
                    "/usr/sbin/fsfreeze",
                    "/usr/bin/chown",
                    "/usr/bin/mkdir",
                ][..],
            ),
        ] {
            for command_path in command_paths {
                let verifier_check = format!(r#"check_required_executable "{command_path}""#);
                assert!(
                    VERIFY_SCRIPT.contains(&verifier_check),
                    "verify-rootfs.sh should verify {command_path} is present for {group}"
                );
            }
        }

        assert!(
            VERIFY_SCRIPT.contains(r#"check_required_executable "$dest" "$dest""#),
            "verify-rootfs.sh should verify rootfs-only guest binaries are executable"
        );
        assert!(
            VERIFY_SCRIPT.contains("--guest-dest)"),
            "verify-rootfs.sh should accept guest destinations from the runner"
        );
        assert!(
            VERIFY_SCRIPT.contains(r#""${GUEST_DESTINATIONS[@]}""#),
            "verify-rootfs.sh should iterate every supplied guest destination"
        );
    }

    #[test]
    fn customize_script_installs_supplied_guest_pairs() {
        assert!(
            CUSTOMIZE_SCRIPT.contains("--guest)"),
            "customize-rootfs.sh should accept guest source/destination pairs"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains(r#""${!GUEST_SOURCES[@]}""#),
            "customize-rootfs.sh should iterate every supplied guest pair"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains(
                r#"install_host_file "${GUEST_SOURCES[$index]}" "${GUEST_DESTINATIONS[$index]}" 755"#
            ),
            "customize-rootfs.sh should install each supplied guest pair as executable"
        );
    }

    #[test]
    fn rootfs_scripts_install_explicit_runtime_tool_hooks() {
        let tool_exec_path = guest_contracts::guest_binary::TOOL_EXEC_PATH;
        let tool_exec_assignment = format!(r#"TOOL_EXEC_DEST="{tool_exec_path}""#);
        let claude_hook_command = format!(r#""command": "{tool_exec_path} hook""#);
        let codex_hook_command = format!(r#"command = "{tool_exec_path} hook""#);
        assert!(
            CUSTOMIZE_SCRIPT.contains(&tool_exec_assignment),
            "customize-rootfs.sh should use the canonical tool executor path"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains(&claude_hook_command),
            "customize-rootfs.sh should configure the Claude Code tool hook"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains(&codex_hook_command),
            "customize-rootfs.sh should configure the Codex tool hook"
        );
        assert!(
            VERIFY_SCRIPT.contains("check_required_file_contains \"$CLAUDE_TOOL_HOOK_DEST\""),
            "verify-rootfs.sh should verify the Claude Code tool hook"
        );
        assert!(
            VERIFY_SCRIPT.contains(&claude_hook_command),
            "verify-rootfs.sh should require the canonical Claude Code tool hook command"
        );
        assert!(
            VERIFY_SCRIPT.contains("check_required_file_contains \"$CODEX_TOOL_HOOK_DEST\""),
            "verify-rootfs.sh should verify the Codex tool hook"
        );
        assert!(
            VERIFY_SCRIPT.contains(&codex_hook_command),
            "verify-rootfs.sh should require the canonical Codex tool hook command"
        );
    }

    #[cfg(unix)]
    #[test]
    fn verify_script_resolves_rootfs_symlinks_without_host_paths() {
        use std::os::unix::fs::symlink;
        use std::process::Command;

        let resolver_start = VERIFY_SCRIPT
            .find("resolve_rootfs_path() {")
            .expect("verify-rootfs.sh should define resolve_rootfs_path");
        let resolver_end = VERIFY_SCRIPT
            .find("\ncheck_required_executable() {")
            .expect("verify-rootfs.sh should define check_required_executable after resolver");
        let resolver_function = &VERIFY_SCRIPT[resolver_start..resolver_end];

        let rootfs = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(rootfs.path().join("usr/bin")).unwrap();
        std::fs::create_dir_all(rootfs.path().join("etc/alternatives")).unwrap();
        symlink("usr/bin", rootfs.path().join("bin")).unwrap();
        symlink("/etc/alternatives/awk", rootfs.path().join("usr/bin/awk")).unwrap();
        symlink(
            "../../usr/bin/real-tool",
            rootfs.path().join("etc/alternatives/awk"),
        )
        .unwrap();
        let real_tool = rootfs.path().join("usr/bin/real-tool");
        std::fs::write(&real_tool, b"#!/bin/sh\n").unwrap();
        let mut perms = std::fs::metadata(&real_tool).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
        std::fs::set_permissions(&real_tool, perms).unwrap();
        symlink("loop-b", rootfs.path().join("usr/bin/loop-a")).unwrap();
        symlink("loop-a", rootfs.path().join("usr/bin/loop-b")).unwrap();

        let script = format!(
            r#"
set -euo pipefail
{resolver_function}
resolved="$(resolve_rootfs_path /bin/awk)"
test "$resolved" = "/usr/bin/real-tool"
test -x "${{MOUNT_DIR}}${{resolved}}"
if resolve_rootfs_path /usr/bin/loop-a >/dev/null; then
  echo "loop not detected" >&2
  exit 1
fi
"#
        );
        let output = Command::new("bash")
            .arg("-c")
            .arg(script)
            .env("MOUNT_DIR", rootfs.path())
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "resolver script failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    #[test]
    fn verify_script_does_not_treat_host_executables_as_rootfs_executables() {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::fs::symlink;
        use std::process::Command;

        let functions_start = VERIFY_SCRIPT
            .find("resolve_rootfs_path() {")
            .expect("verify-rootfs.sh should define resolve_rootfs_path");
        let functions_end = VERIFY_SCRIPT
            .find("\ncheck_bin() {")
            .expect("verify-rootfs.sh should define check_bin after executable checks");
        let verifier_functions = &VERIFY_SCRIPT[functions_start..functions_end];

        let rootfs = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(rootfs.path().join("bin")).unwrap();
        std::fs::create_dir_all(rootfs.path().join("usr/bin")).unwrap();
        symlink("/bin/bash", rootfs.path().join("bin/awk")).unwrap();
        symlink("../../../../bin/bash", rootfs.path().join("bin/sh")).unwrap();
        symlink("/usr/bin/missing-target", rootfs.path().join("bin/broken")).unwrap();
        std::fs::write(
            rootfs.path().join("usr/bin/file-parent"),
            b"not a directory",
        )
        .unwrap();
        let non_executable = rootfs.path().join("usr/bin/not-executable");
        std::fs::write(&non_executable, b"#!/bin/sh\n").unwrap();
        let mut perms = std::fs::metadata(&non_executable).unwrap().permissions();
        perms.set_mode(0o644);
        std::fs::set_permissions(&non_executable, perms).unwrap();
        std::fs::create_dir(rootfs.path().join("usr/bin/dir-command")).unwrap();

        let script = format!(
            r#"
set -euo pipefail
{verifier_functions}
assert_check_error() {{
  local path="$1" name="$2" expected="$3"
  errors=()
  check_required_executable "$path" "$name"
  test "${{#errors[@]}}" -eq 1
  test "${{errors[0]}}" = "$expected"
}}
assert_check_error /bin/awk awk "awk not found or not executable at /bin/awk"
assert_check_error /bin/sh sh "sh not found or not executable at /bin/sh"
assert_check_error /bin/broken broken "broken not found or not executable at /bin/broken"
assert_check_error \
  /usr/bin/file-parent/tool \
  file-parent-tool \
  "file-parent-tool not found or not executable at /usr/bin/file-parent/tool"
assert_check_error \
  /usr/bin/not-executable \
  not-executable \
  "not-executable not found or not executable at /usr/bin/not-executable"
assert_check_error \
  /usr/bin/dir-command \
  dir-command \
  "dir-command not found or not executable at /usr/bin/dir-command"
"#
        );
        let output = Command::new("bash")
            .arg("-c")
            .arg(script)
            .env("MOUNT_DIR", rootfs.path())
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "rootfs executable check script failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn verify_script_documents_optional_diagnostic_commands() {
        assert!(
            VERIFY_SCRIPT.contains(
                "Intentionally unchecked optional diagnostic commands: file sha256sum free timeout ps"
            ),
            "verify-rootfs.sh should document intentionally unchecked optional diagnostics"
        );
    }

    #[test]
    fn build_script_publishes_debootstrap_cache_atomically() {
        assert!(
            TEMPLATE_BUILD_SCRIPT
                .contains(r#"CACHE_TMP_TAR=$(mktemp "${cache_tar%.tar}.tmp.mktemp.XXXXXX.tar")"#),
            "build-template.sh should stage shared-cache writes with namespace-independent uniqueness"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("debootstrap validates the tarball suffix"),
            "build-template.sh should document why temp debootstrap tarballs keep a .tar suffix"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(r#"--make-tarball="$CACHE_TMP_TAR""#),
            "build-template.sh must not write debootstrap output directly to the stable cache path"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(r#"--unpack-tarball="$(realpath "$CACHE_TMP_TAR")""#),
            "build-template.sh should validate the temp tarball before publishing it"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains(r#"mv -f "$CACHE_TMP_TAR" "$cache_tar""#),
            "build-template.sh should atomically publish the verified debootstrap cache tarball"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT
                .contains(r#"[[ -n "$CACHE_TMP_TAR" ]] && ! rm -f "$CACHE_TMP_TAR""#),
            "build-template.sh should remove unpublished debootstrap cache temp files on cleanup"
        );
        assert!(
            !TEMPLATE_BUILD_SCRIPT.contains(r#"--make-tarball="$cache_tar""#),
            "build-template.sh must not publish partial debootstrap cache tarballs on cancellation"
        );
    }

    #[test]
    fn build_script_locks_only_debootstrap_cache_access() {
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("--debootstrap-lock"),
            "build-template.sh should receive the same debootstrap cache lock path used by GC"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("flock \"$lock_fd\""),
            "build-template.sh should lock shared debootstrap cache access"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("exec {lock_fd}>>\"$DEBOOTSTRAP_LOCK\""),
            "build-template.sh should open the pre-created lock file without truncating it"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("flock -u \"$lock_fd\""),
            "build-template.sh should release the debootstrap cache lock after unpack"
        );
        assert!(
            TEMPLATE_BUILD_SCRIPT.contains("debootstrap_cache_locked\n  flock -u"),
            "build-template.sh should release the cache lock before chroot package install and mkfs"
        );
    }

    #[test]
    fn rootfs_scripts_enter_private_mount_namespace() {
        for (name, script) in [
            ("build-template.sh", TEMPLATE_BUILD_SCRIPT),
            ("customize-rootfs.sh", CUSTOMIZE_SCRIPT),
            ("verify-rootfs.sh", VERIFY_SCRIPT),
        ] {
            assert!(
                script.contains(r#"UNSHARE_SENTINEL="--__runner_unshared__""#),
                "{name} should use a sentinel so sudo does not need to preserve env vars"
            );
            assert!(
                script.contains("unshare --mount --propagation private"),
                "{name} should isolate mounts so SIGKILL cannot leak host-visible rootfs mounts"
            );
        }
    }

    #[test]
    fn customize_script_uses_autoclear_loop_mount() {
        assert!(
            CUSTOMIZE_SCRIPT.contains("sudo mount -o loop \"$ROOTFS\" \"$MOUNT_DIR\""),
            "customize-rootfs.sh should let mount create an autoclear loop device"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("sudo mount --bind /proc")
                && CUSTOMIZE_SCRIPT.contains("sudo mount --bind /sys")
                && CUSTOMIZE_SCRIPT.contains("sudo mount --bind /dev"),
            "customize-rootfs.sh should run keytool in the same proc/sys/dev chroot environment \
             as the old rootfs build path"
        );
        assert!(
            CUSTOMIZE_SCRIPT.contains("sudo umount -R \"$target\""),
            "customize-rootfs.sh should recursively unmount runtime bind mounts"
        );
        assert!(
            !CUSTOMIZE_SCRIPT.contains("losetup --find --show"),
            "customize-rootfs.sh should not keep an explicit loop device that can leak on SIGKILL"
        );
    }

    #[test]
    fn verify_script_retries_and_surfaces_cleanup_failures() {
        assert!(
            VERIFY_SCRIPT.contains("unmount_with_retries()"),
            "verify-rootfs.sh should retry unmount to avoid transient loop mount leaks"
        );
        assert!(
            VERIFY_SCRIPT.contains(r#"error: ${MODE} verification cleanup failed"#),
            "verify-rootfs.sh should fail successful verification if cleanup fails"
        );
        assert!(
            VERIFY_SCRIPT.contains("if ! rmdir \"$MOUNT_DIR\""),
            "verify-rootfs.sh should treat mount temp dir cleanup failure as a cleanup failure"
        );
        assert!(
            VERIFY_SCRIPT.contains("exit \"$status\""),
            "verify-rootfs.sh EXIT trap should return cleanup-adjusted status"
        );
    }

    #[test]
    fn verify_script_has_template_and_rootfs_modes() {
        assert!(
            VERIFY_SCRIPT.contains("--mode)"),
            "verify-rootfs.sh should accept --mode"
        );
        assert!(
            VERIFY_SCRIPT.contains(r#"$MODE" != "template""#)
                || VERIFY_SCRIPT.contains(r#"$MODE" == "template""#),
            "verify-rootfs.sh should have a template mode"
        );
        assert!(
            VERIFY_SCRIPT.contains(r#"$MODE" == "rootfs""#),
            "verify-rootfs.sh should gate guest/CA checks to rootfs mode"
        );
    }

    #[test]
    fn verify_script_rejects_rootfs_only_content_in_template_mode() {
        assert!(
            VERIFY_SCRIPT.contains("template contains rootfs-only guest binary"),
            "verify-rootfs.sh should reject guest binaries in template mode"
        );
        assert!(
            VERIFY_SCRIPT.contains("template contains rootfs-only proxy CA certificate"),
            "verify-rootfs.sh should reject injected proxy CA files in template mode"
        );
        assert!(
            VERIFY_SCRIPT.contains("template contains rootfs-only environment CA settings"),
            "verify-rootfs.sh should reject injected CA environment settings in template mode"
        );
        assert!(
            VERIFY_SCRIPT.contains("template contains rootfs-only resolv.conf content"),
            "verify-rootfs.sh should reject customized resolver state in template mode"
        );
    }
}
