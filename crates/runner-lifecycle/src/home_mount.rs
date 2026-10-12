//! Home drive mount and terminal freeze boundaries.
//!
//! The mount helper accepts an existing mount only when `/home/user` is
//! backed by `/dev/vdb`. It rejects symlink path components, unrelated
//! mountpoints, and a home device mounted elsewhere.
//!
//! Home image promotion uses the freeze helper as a terminal consistency
//! boundary. The helper verifies the same path and device identity before it
//! freezes ext4, flushing completed writes and blocking further modifications.
//! A sandbox that crosses this boundary must be stopped and destroyed; it must
//! never be thawed or returned to the idle pool.

use std::time::Duration;

use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox};
use shell_quote::quote_shell_arg;

use crate::error::{LifecycleError, LifecycleResult};
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};

pub const HOME_MOUNT_TIMEOUT: Duration = Duration::from_secs(30);
const HOME_FREEZE_TIMEOUT: Duration = Duration::from_secs(30);
const HOME_DEVICE: &str = "/dev/vdb";
const HOME_FSFREEZE_PATH: &str = "/usr/sbin/fsfreeze";
const HOME_FREEZE_SCRIPT: &str = include_str!("../scripts/freeze-home-drive.sh");

#[derive(Debug)]
pub struct HomeDriveMountError {
    pub error: LifecycleError,
    pub guest_duration: Option<Duration>,
}

pub async fn ensure_home_drive_mounted(
    sandbox: &dyn Sandbox,
    diagnostic_id: impl std::fmt::Display,
) -> Result<Option<Duration>, HomeDriveMountError> {
    let result = sandbox
        .mount_home_drive()
        .await
        .map_err(|error| HomeDriveMountError {
            error: LifecycleError::from(error),
            guest_duration: None,
        })?;
    let guest_duration = result
        .guest_duration_ms
        .map(|duration_ms| Duration::from_millis(u64::from(duration_ms)));
    if helper_exec_succeeded(&result) {
        return Ok(guest_duration);
    }

    let mut message = format_helper_exec_failure("mount home drive", &result);
    message.push_str(&format!("; diagnostic id: {diagnostic_id}"));
    Err(HomeDriveMountError {
        error: LifecycleError::Internal(message),
        guest_duration,
    })
}

pub async fn freeze_home_drive(
    sandbox: &dyn Sandbox,
    diagnostic_id: impl std::fmt::Display,
) -> LifecycleResult<()> {
    run_home_drive_command(
        sandbox,
        diagnostic_id,
        &home_freeze_command(),
        "freeze home drive",
        "home-freeze",
        HOME_FREEZE_TIMEOUT,
    )
    .await
    .map(|_| ())
    .map_err(|error| error.error)
}

async fn run_home_drive_command(
    sandbox: &dyn Sandbox,
    diagnostic_id: impl std::fmt::Display,
    cmd: &str,
    operation: &'static str,
    label: &'static str,
    timeout: Duration,
) -> Result<Option<Duration>, HomeDriveMountError> {
    let result = sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd,
                timeout,
                env: &[],
                sudo: true,
                expected_exit_codes: &[],
                stdin_bytes: None,
                output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
            },
            label,
        )
        .await
        .map_err(|error| HomeDriveMountError {
            error: LifecycleError::from(error),
            guest_duration: None,
        })?;
    let guest_duration = result
        .guest_duration_ms
        .map(|duration_ms| Duration::from_millis(u64::from(duration_ms)));
    if helper_exec_succeeded(&result) {
        return Ok(guest_duration);
    }

    let mut message = format_helper_exec_failure(operation, &result);
    message.push_str(&format!("; diagnostic id: {diagnostic_id}"));
    Err(HomeDriveMountError {
        error: LifecycleError::Internal(message),
        guest_duration,
    })
}

fn home_freeze_command() -> String {
    home_freeze_command_for("/home/user", HOME_DEVICE, HOME_FSFREEZE_PATH)
}

fn home_freeze_command_for(home_dir: &str, home_device: &str, home_fsfreeze_path: &str) -> String {
    let home_dir = quote_shell_arg(home_dir);
    let home_device = quote_shell_arg(home_device);
    let home_fsfreeze_path = quote_shell_arg(home_fsfreeze_path);
    format!(
        "home_dir={home_dir}\nhome_device={home_device}\nhome_fsfreeze_path={home_fsfreeze_path}\n{HOME_FREEZE_SCRIPT}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_shell_arg_handles_single_quotes() {
        assert_eq!(quote_shell_arg("/tmp/a'b"), "'/tmp/a'\\''b'");
    }

    #[tokio::test]
    async fn home_drive_operations_use_typed_mount_and_bounded_privileged_freeze() {
        let sandbox = sandbox_mock::MockSandbox::new("home-boundary-test");

        ensure_home_drive_mounted(&sandbox, "mount-diagnostic")
            .await
            .unwrap();
        freeze_home_drive(&sandbox, "freeze-diagnostic")
            .await
            .unwrap();

        assert_eq!(sandbox.home_drive_mount_calls(), 1);
        let calls = sandbox.exec_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].timeout, HOME_FREEZE_TIMEOUT);
        assert!(calls[0].sudo);
        assert_eq!(calls[0].output_limits, EXEC_OUTPUT_LIMIT_64_KIB);
    }

    #[cfg(target_os = "linux")]
    mod behavior {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::path::{Path, PathBuf};
        use std::process::{Command, Output};

        use super::*;

        const HOME_DEV: &str = "8:16";

        struct HomeScriptFixture {
            temp: tempfile::TempDir,
            home_dir: PathBuf,
            home_device: PathBuf,
            fake_bin: PathBuf,
            calls_path: PathBuf,
            fsfreeze_path: PathBuf,
        }

        impl HomeScriptFixture {
            fn new() -> Self {
                let temp = tempfile::tempdir().unwrap();
                let home_dir = temp.path().join("workspace");
                let home_device = temp.path().join("vdb");
                let fake_bin = temp.path().join("bin");
                let calls_path = temp.path().join("calls.log");
                let fsfreeze_path = fake_bin.join("fsfreeze");

                fs::create_dir(&fake_bin).unwrap();
                fs::write(&home_device, b"").unwrap();
                fs::write(&calls_path, b"").unwrap();

                let fixture = Self {
                    temp,
                    home_dir,
                    home_device,
                    fake_bin,
                    calls_path,
                    fsfreeze_path,
                };
                fixture.write_mountpoint(false, None, None);
                fixture.write_fsfreeze(0, "");
                fixture
            }

            fn create_workspace(&self) {
                fs::create_dir(&self.home_dir).unwrap();
            }

            fn write_mountpoint(
                &self,
                home_mounted: bool,
                home_dev: Option<&str>,
                target_dev: Option<&str>,
            ) {
                let home_dir = quoted_path(&self.home_dir);
                let home_device = quoted_path(&self.home_device);
                let home_mounted = if home_mounted { "1" } else { "0" };
                let home_dev = quote_shell_arg(home_dev.unwrap_or_default());
                let target_dev = quote_shell_arg(target_dev.unwrap_or_default());
                let body = format!(
                    r#"home_dir={home_dir}
home_device={home_device}
home_mounted={home_mounted}
home_dev={home_dev}
target_dev={target_dev}
log_call mountpoint "$@"
if [ "$#" -ne 3 ] || [ "$2" != "--" ]; then
  exit 97
fi
case "$1" in
  -x)
    [ "$3" = "$home_device" ] || exit 97
    [ -n "$home_dev" ] || exit 1
    printf '%s\n' "$home_dev"
    ;;
  -q)
    [ "$3" = "$home_dir" ] || exit 97
    [ "$home_mounted" = 1 ]
    ;;
  -d)
    if [ "$3" != "$home_dir" ]; then
      case "$3" in
        /proc/[0-9]*/fd/3) ;;
        *) exit 97 ;;
      esac
      [ "$(/usr/bin/readlink -- "$3")" = "$home_dir" ] || exit 97
    fi
    [ -n "$target_dev" ] || exit 1
    printf '%s\n' "$target_dev"
    ;;
  *)
    exit 97
    ;;
esac
"#
                );
                self.write_fake("mountpoint", &body);
            }

            fn write_fsfreeze(&self, exit_code: i32, stderr: &str) {
                let home_dir = quoted_path(&self.home_dir);
                let stderr = quote_shell_arg(stderr);
                let body = format!(
                    r#"home_dir={home_dir}
error={stderr}
log_call fsfreeze "$@"
if [ "$#" -ne 2 ] || [ "$1" != "--freeze" ]; then
  exit 97
fi
case "$2" in
  /proc/[0-9]*/fd/3) ;;
  *) exit 97 ;;
esac
[ "$(/usr/bin/readlink -- "$2")" = "$home_dir" ] || exit 97
if [ -n "$error" ]; then
  printf '%s\n' "$error" >&2
fi
exit {exit_code}
"#
                );
                self.write_fake_path(&self.fsfreeze_path, &body);
            }

            fn run_freeze(&self) -> Output {
                let command = home_freeze_command_for(
                    self.home_dir.to_str().unwrap(),
                    self.home_device.to_str().unwrap(),
                    self.fsfreeze_path.to_str().unwrap(),
                );
                self.run(command)
            }

            fn run(&self, command: String) -> Output {
                Command::new("/bin/sh")
                    .arg("-c")
                    .arg(command)
                    .current_dir(self.temp.path())
                    .env_clear()
                    .env("PATH", &self.fake_bin)
                    .output()
                    .unwrap()
            }

            fn calls(&self) -> String {
                fs::read_to_string(&self.calls_path).unwrap()
            }

            fn write_fake(&self, name: &str, body: &str) {
                self.write_fake_path(&self.fake_bin.join(name), body);
            }

            fn write_fake_path(&self, path: &Path, body: &str) {
                let calls_path = quoted_path(&self.calls_path);
                let script = format!(
                    r#"#!/bin/sh
set -eu
calls_path={calls_path}
log_call() {{
  name=$1
  shift
  {{
    printf '%s' "$name"
    for arg in "$@"; do
      printf '\t%s' "$arg"
    done
    printf '\n'
  }} >> "$calls_path"
}}
{body}"#
                );
                write_executable(path, &script);
            }
        }

        fn quoted_path(path: &Path) -> String {
            quote_shell_arg(path.to_str().unwrap())
        }

        fn write_executable(path: &Path, content: &str) {
            fs::write(path, content).unwrap();
            let mut permissions = fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).unwrap();
        }

        fn assert_exit(output: &Output, expected: i32) -> String {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            assert_eq!(
                output.status.code(),
                Some(expected),
                "stdout={stdout} stderr={stderr}"
            );
            assert!(stdout.is_empty(), "unexpected stdout: {stdout}");
            stderr
        }

        fn assert_descriptor_path(path: &str) {
            let pid = path
                .strip_prefix("/proc/")
                .and_then(|path| path.strip_suffix("/fd/3"))
                .expect("descriptor path should be /proc/<pid>/fd/3");
            assert!(!pid.is_empty());
            assert!(pid.chars().all(|character| character.is_ascii_digit()));
        }

        #[test]
        fn freeze_script_rejects_unmounted_workspace() {
            let fixture = HomeScriptFixture::new();
            fixture.create_workspace();
            fixture.write_mountpoint(false, Some(HOME_DEV), None);

            let output = fixture.run_freeze();

            let stderr = assert_exit(&output, 65);
            assert!(stderr.contains("home drive is not mounted"));
            assert_eq!(
                fixture.calls(),
                format!(
                    "mountpoint\t-x\t--\t{}\nmountpoint\t-q\t--\t{}\n",
                    fixture.home_device.display(),
                    fixture.home_dir.display()
                )
            );
        }

        #[test]
        fn freeze_script_rejects_descriptor_device_mismatch() {
            let fixture = HomeScriptFixture::new();
            fixture.create_workspace();
            fixture.write_mountpoint(true, Some(HOME_DEV), Some("8:32"));

            let output = fixture.run_freeze();

            let stderr = assert_exit(&output, 64);
            assert!(stderr.contains("refusing to freeze non-home mountpoint"));
            let calls = fixture.calls();
            let lines: Vec<_> = calls.lines().collect();
            assert_eq!(lines.len(), 3);
            assert_eq!(
                lines[0],
                format!("mountpoint\t-x\t--\t{}", fixture.home_device.display())
            );
            assert_eq!(
                lines[1],
                format!("mountpoint\t-q\t--\t{}", fixture.home_dir.display())
            );
            let descriptor = lines[2]
                .strip_prefix("mountpoint\t-d\t--\t")
                .expect("descriptor mountpoint call");
            assert_descriptor_path(descriptor);
        }

        #[test]
        fn freeze_script_freezes_matching_descriptor() {
            let fixture = HomeScriptFixture::new();
            fixture.create_workspace();
            fixture.write_mountpoint(true, Some(HOME_DEV), Some(HOME_DEV));

            let output = fixture.run_freeze();

            assert_eq!(assert_exit(&output, 0), "");
            let calls = fixture.calls();
            let lines: Vec<_> = calls.lines().collect();
            assert_eq!(lines.len(), 4);
            let descriptor = lines[2]
                .strip_prefix("mountpoint\t-d\t--\t")
                .expect("descriptor mountpoint call");
            assert_descriptor_path(descriptor);
            assert_eq!(lines[3], format!("fsfreeze\t--freeze\t{descriptor}"));
        }

        #[test]
        fn freeze_script_propagates_fsfreeze_failure() {
            let fixture = HomeScriptFixture::new();
            fixture.create_workspace();
            fixture.write_mountpoint(true, Some(HOME_DEV), Some(HOME_DEV));
            fixture.write_fsfreeze(73, "freeze failed");

            let output = fixture.run_freeze();

            assert_eq!(assert_exit(&output, 73), "freeze failed\n");
            let calls = fixture.calls();
            let lines: Vec<_> = calls.lines().collect();
            assert_eq!(lines.len(), 4);
            let descriptor = lines[2]
                .strip_prefix("mountpoint\t-d\t--\t")
                .expect("descriptor mountpoint call");
            assert_descriptor_path(descriptor);
            assert_eq!(lines[3], format!("fsfreeze\t--freeze\t{descriptor}"));
        }
    }
}
