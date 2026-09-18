use std::io;
use std::path::PathBuf;
use std::process::Command;
#[cfg(not(any(debug_assertions, feature = "test-support")))]
use std::sync::{Mutex, OnceLock};

#[cfg(not(any(debug_assertions, feature = "test-support")))]
const SANDBOX_USER: &str = "user";
#[cfg(not(any(debug_assertions, feature = "test-support")))]
static SANDBOX_USER_CREDENTIALS: OnceLock<UserCredentials> = OnceLock::new();
#[cfg(not(any(debug_assertions, feature = "test-support")))]
static SANDBOX_USER_CREDENTIALS_INIT: Mutex<()> = Mutex::new(());

const SANDBOX_USER_BASE_PATH: &str = "/usr/local/bin:/usr/bin:/bin:/usr/local/games:/usr/games";
const AGENT_SHELL: &str = "/bin/bash";
// [sync:etc-environment] Keep in sync with:
// - crates/runner/scripts/customize-rootfs.sh
// - .github/scripts/runner-behavior-exec-remote.sh (Test 10)
const TRUSTED_ROOTFS_ENVIRONMENT: [(&str, &str); 7] = [
    ("LANG", "C.UTF-8"),
    ("RUSTUP_HOME", "/usr/local/rustup"),
    ("NPM_CONFIG_UPDATE_NOTIFIER", "false"),
    (
        "NODE_EXTRA_CA_CERTS",
        "/usr/local/share/ca-certificates/vm0-proxy-ca.crt",
    ),
    ("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt"),
    ("REQUESTS_CA_BUNDLE", "/etc/ssl/certs/ca-certificates.crt"),
    ("CARGO_HTTP_CAINFO", "/etc/ssl/certs/ca-certificates.crt"),
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct UserCredentials {
    pub(crate) username: String,
    pub(crate) uid: u32,
    pub(crate) gid: u32,
    pub(crate) home: PathBuf,
    pub(crate) groups: Vec<u32>,
}

#[cfg(not(any(debug_assertions, feature = "test-support")))]
pub(crate) fn sandbox_user_home() -> io::Result<PathBuf> {
    cached_system_user_credentials().map(|credentials| credentials.home.clone())
}

pub(crate) fn sandbox_user_gid() -> io::Result<libc::gid_t> {
    #[cfg(any(debug_assertions, feature = "test-support"))]
    {
        Err(io::Error::other(
            "sandbox user gid is unavailable in debug/test-support builds",
        ))
    }

    #[cfg(not(any(debug_assertions, feature = "test-support")))]
    {
        cached_system_user_credentials().map(|credentials| credentials.gid as libc::gid_t)
    }
}

pub(crate) fn shell_command_uid(sudo: bool) -> io::Result<libc::uid_t> {
    if sudo {
        // SAFETY: geteuid is a simple scalar getter with no preconditions.
        return Ok(unsafe { libc::geteuid() });
    }

    #[cfg(any(debug_assertions, feature = "test-support"))]
    {
        // SAFETY: geteuid is a simple scalar getter with no preconditions.
        Ok(unsafe { libc::geteuid() })
    }

    #[cfg(not(any(debug_assertions, feature = "test-support")))]
    {
        cached_system_user_credentials().map(|credentials| credentials.uid as libc::uid_t)
    }
}

pub(crate) fn apply_command_identity(command: &mut Command, sudo: bool) -> io::Result<()> {
    if let Some(credentials) = command_credentials(sudo)? {
        apply_credentials(command, credentials)?;
    }
    Ok(())
}

/// Install the trusted Guest Agent environment without sourcing sandbox-owned
/// shell state during fixed launch.
pub(crate) fn configure_guest_agent_command_environment(
    command: &mut crate::contained_command::ContainedCommand,
) -> io::Result<()> {
    command
        .envs(TRUSTED_ROOTFS_ENVIRONMENT)
        .env("SHELL", AGENT_SHELL);

    #[cfg(any(debug_assertions, feature = "test-support"))]
    {
        command.env("PATH", SANDBOX_USER_BASE_PATH);
        Ok(())
    }

    #[cfg(not(any(debug_assertions, feature = "test-support")))]
    {
        let home = sandbox_user_home()?;
        command.env("PATH", sandbox_user_path(&home));
        Ok(())
    }
}

#[cfg(any(test, not(any(debug_assertions, feature = "test-support"))))]
fn sandbox_user_path(home: &std::path::Path) -> String {
    // Keep system and existing language-tool precedence, while also finding
    // user tools installed after the agent starts without sourcing profiles.
    format!(
        "{SANDBOX_USER_BASE_PATH}:{}/go/bin:{}/.cargo/bin:{}/.local/bin:{}/bin",
        home.display(),
        home.display(),
        home.display(),
        home.display()
    )
}

pub(crate) fn command_credentials(sudo: bool) -> io::Result<Option<&'static UserCredentials>> {
    if sudo {
        return Ok(None);
    }

    #[cfg(any(debug_assertions, feature = "test-support"))]
    {
        // Local guest-control tests run without the production rootfs user account.
        // Production release builds below resolve and drop to the sandbox user.
        Ok(None)
    }

    #[cfg(not(any(debug_assertions, feature = "test-support")))]
    {
        cached_system_user_credentials().map(Some)
    }
}

pub(crate) fn apply_credentials(
    command: &mut Command,
    credentials: &'static UserCredentials,
) -> io::Result<()> {
    command
        .current_dir(&credentials.home)
        .env("HOME", &credentials.home)
        .env("USER", &credentials.username)
        .env("LOGNAME", &credentials.username);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        let uid = credentials.uid as libc::uid_t;
        let gid = credentials.gid as libc::gid_t;
        let groups = &credentials.groups;

        // SAFETY: The closure only calls async-signal-safe credential syscalls
        // in the child immediately before exec. It does not allocate or touch
        // shared Rust state after fork.
        unsafe {
            command.pre_exec(move || {
                if !groups.is_empty() && libc::setgroups(groups.len(), groups.as_ptr()) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::setgid(gid) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::setuid(uid) != 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    #[cfg(not(unix))]
    {
        let _ = command;
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "sandbox user credential drop requires Unix",
        ));
    }

    Ok(())
}

#[cfg(not(any(debug_assertions, feature = "test-support")))]
fn system_user_credentials(username: &str) -> io::Result<UserCredentials> {
    let passwd = std::fs::read_to_string("/etc/passwd")?;
    let group = std::fs::read_to_string("/etc/group")?;
    parse_user_credentials(&passwd, &group, username)
}

#[cfg(not(any(debug_assertions, feature = "test-support")))]
fn cached_system_user_credentials() -> io::Result<&'static UserCredentials> {
    if let Some(credentials) = SANDBOX_USER_CREDENTIALS.get() {
        return Ok(credentials);
    }

    let _guard = SANDBOX_USER_CREDENTIALS_INIT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(credentials) = SANDBOX_USER_CREDENTIALS.get() {
        return Ok(credentials);
    }

    let credentials = system_user_credentials(SANDBOX_USER)?;
    let _ = SANDBOX_USER_CREDENTIALS.set(credentials);
    SANDBOX_USER_CREDENTIALS
        .get()
        .ok_or_else(|| io::Error::other("sandbox user credential cache unavailable"))
}

#[cfg(any(test, not(any(debug_assertions, feature = "test-support"))))]
fn parse_user_credentials(
    passwd: &str,
    group: &str,
    username: &str,
) -> io::Result<UserCredentials> {
    let mut credentials = None;

    for line in passwd.lines() {
        let Some(candidate) = parse_passwd_line(line, username)? else {
            continue;
        };
        credentials = Some(candidate);
        break;
    }

    let mut credentials = credentials.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!("sandbox user {username:?} not found in /etc/passwd"),
        )
    })?;
    credentials.groups = parse_supplementary_groups(group, username, credentials.gid)?;
    Ok(credentials)
}

#[cfg(any(test, not(any(debug_assertions, feature = "test-support"))))]
fn parse_passwd_line(line: &str, username: &str) -> io::Result<Option<UserCredentials>> {
    if line.trim().is_empty() || line.starts_with('#') {
        return Ok(None);
    }

    let mut fields = line.split(':');
    let name = fields.next().unwrap_or_default();
    if name != username {
        return Ok(None);
    }
    let _passwd = fields.next();
    let uid = parse_required_u32(fields.next(), "uid")?;
    let gid = parse_required_u32(fields.next(), "gid")?;
    let _gecos = fields.next();
    let home = fields.next().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("passwd entry for {username:?} missing home"),
        )
    })?;

    Ok(Some(UserCredentials {
        username: name.to_string(),
        uid,
        gid,
        home: PathBuf::from(home),
        groups: Vec::new(),
    }))
}

#[cfg(any(test, not(any(debug_assertions, feature = "test-support"))))]
fn parse_supplementary_groups(
    group: &str,
    username: &str,
    primary_gid: u32,
) -> io::Result<Vec<u32>> {
    let mut groups = vec![primary_gid];

    for line in group.lines() {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }

        let mut fields = line.split(':');
        let _name = fields.next();
        let _passwd = fields.next();
        let gid = parse_required_u32(fields.next(), "group gid")?;
        let members = fields.next().unwrap_or_default();
        if gid == primary_gid || members.split(',').any(|member| member == username) {
            groups.push(gid);
        }
    }

    groups.sort_unstable();
    groups.dedup();
    Ok(groups)
}

#[cfg(any(test, not(any(debug_assertions, feature = "test-support"))))]
fn parse_required_u32(value: Option<&str>, field: &str) -> io::Result<u32> {
    let value = value.ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, format!("missing {field} field"))
    })?;
    value.parse::<u32>().map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid {field} {value:?}: {e}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    fn write_executable(path: &Path, output: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("#!/bin/sh\nprintf '%s' '{output}'\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn sandbox_user_path_finds_tools_installed_after_launch() {
        for relative_dir in [".local/bin", "bin"] {
            let home = tempfile::tempdir().unwrap();
            let path = sandbox_user_path(home.path());
            write_executable(
                &home.path().join(relative_dir).join("okou-user-path-test"),
                "user tool found",
            );

            let output = Command::new("okou-user-path-test")
                .env_clear()
                .env("PATH", path)
                .output()
                .unwrap_or_else(|error| panic!("tool in {relative_dir} was not found: {error}"));
            assert!(output.status.success());
            assert_eq!(output.stdout, b"user tool found");
        }
    }

    #[test]
    fn sandbox_user_path_preserves_command_precedence() {
        let home = tempfile::tempdir().unwrap();
        let path = sandbox_user_path(home.path());
        let user_dirs = ["go/bin", ".cargo/bin", ".local/bin", "bin"];
        for relative_dir in user_dirs {
            let dir = home.path().join(relative_dir);
            write_executable(&dir.join("okou-user-path-test"), relative_dir);
            write_executable(&dir.join("cat"), "shadowed system command");
        }

        let input = home.path().join("input");
        std::fs::write(&input, "system command found").unwrap();
        let output = Command::new("cat")
            .arg(&input)
            .env_clear()
            .env("PATH", &path)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"system command found");

        for relative_dir in user_dirs {
            let output = Command::new("okou-user-path-test")
                .env_clear()
                .env("PATH", &path)
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(output.stdout, relative_dir.as_bytes());
            std::fs::remove_file(home.path().join(relative_dir).join("okou-user-path-test"))
                .unwrap();
        }
    }

    #[test]
    fn guest_agent_environment_preserves_trusted_defaults() {
        let mut command = crate::contained_command::ContainedCommand::new("true");
        configure_guest_agent_command_environment(&mut command).unwrap();

        for (key, expected) in TRUSTED_ROOTFS_ENVIRONMENT {
            let actual = command.environment.get(std::ffi::OsStr::new(key));
            assert_eq!(
                actual.map(|value| value.as_os_str()),
                Some(std::ffi::OsStr::new(expected))
            );
        }
        let shell = command.environment.get(std::ffi::OsStr::new("SHELL"));
        assert_eq!(
            shell.map(|value| value.as_os_str()),
            Some(std::ffi::OsStr::new(AGENT_SHELL))
        );
    }

    #[test]
    fn parse_user_credentials_includes_primary_and_supplementary_groups() {
        let passwd = "root:x:0:0:root:/root:/bin/bash\nuser:x:1000:1000::/home/user:/bin/bash\n";
        let group = "user:x:1000:\nsudo:x:27:user\npostgres:x:113:user,other\n";

        let credentials = parse_user_credentials(passwd, group, "user").unwrap();

        assert_eq!(credentials.uid, 1000);
        assert_eq!(credentials.gid, 1000);
        assert_eq!(credentials.home, PathBuf::from("/home/user"));
        assert_eq!(credentials.groups, vec![27, 113, 1000]);
    }

    #[test]
    fn parse_user_credentials_uses_passwd_primary_gid_without_group_entry() {
        let passwd = "user:x:1000:2000::/home/user:/bin/bash\n";

        let credentials = parse_user_credentials(passwd, "", "user").unwrap();

        assert_eq!(credentials.gid, 2000);
        assert_eq!(credentials.groups, vec![2000]);
    }

    #[cfg(any(debug_assertions, feature = "test-support"))]
    #[test]
    fn sandbox_user_gid_is_unavailable_in_local_builds() {
        let err = sandbox_user_gid().unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::Other);
        assert!(err.to_string().contains("sandbox user gid is unavailable"));
    }

    #[test]
    fn parse_user_credentials_fails_when_user_missing() {
        let err =
            parse_user_credentials("root:x:0:0:root:/root:/bin/bash\n", "", "user").unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn parse_user_credentials_fails_on_invalid_uid() {
        let err =
            parse_user_credentials("user:x:not-a-uid:1000::/home/user:/bin/bash\n", "", "user")
                .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn parse_user_credentials_fails_on_invalid_gid() {
        let err =
            parse_user_credentials("user:x:1000:not-a-gid::/home/user:/bin/bash\n", "", "user")
                .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }
}
