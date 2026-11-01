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
// - crates/runner/tests/behavior/exec/inventory.sh
const TRUSTED_ROOTFS_ENVIRONMENT: [(&str, &str); 8] = [
    ("LANG", "C.UTF-8"),
    ("RUSTUP_HOME", "/usr/local/rustup"),
    ("NPM_CONFIG_UPDATE_NOTIFIER", "false"),
    (
        "NODE_EXTRA_CA_CERTS",
        "/usr/local/share/ca-certificates/vm0-proxy-ca.crt",
    ),
    ("AGENT_BROWSER_USE_SYSTEM_CA", "1"),
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
mod tests;
