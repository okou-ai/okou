//! Filesystem initialization for VM boot.
//!
//! The kernel mounts the ext4 rootfs via `root=/dev/vda rw` boot arg and
//! auto-mounts devtmpfs on `/dev` (`CONFIG_DEVTMPFS_MOUNT=y`).
//!
//! This module completes the ordered boot setup:
//! 1. Mount `/proc`.
//! 2. Configure TCP keepalive.
//! 3. Mount `/sys` and initialize cgroup v2 exec process containment.
//! 4. Mount `/dev/shm`.
//! 5. Load shared environment variables.
//! 6. Enter `/root`.

use nix::mount::{MsFlags, mount};
use std::fs;
use std::io;
use std::path::Path;

use guest_contracts::process_containment::{
    CGROUP_V2_MOUNT_PATH, CONTROL_MEMORY_MIN_BYTES, EXEC_CGROUP_BASE_PATH,
    REQUIRED_CGROUP_CONTROLLERS, REQUIRED_CGROUP_SUBTREE_CONTROL,
};

const CGROUP_CONTROLLERS_FILE: &str = "cgroup.controllers";
const CGROUP_PROCS_FILE: &str = "cgroup.procs";
const CGROUP_EVENTS_FILE: &str = "cgroup.events";
const CGROUP_KILL_FILE: &str = "cgroup.kill";
const CGROUP_SUBTREE_CONTROL_FILE: &str = "cgroup.subtree_control";
const CPU_WEIGHT_FILE: &str = "cpu.weight";
const MEMORY_MIN_FILE: &str = "memory.min";
const PIDS_MAX_FILE: &str = "pids.max";

/// Initialize guest boot filesystems, exec process containment, and environment.
///
/// The kernel has already mounted `/dev/vda` as root (`root=/dev/vda rw`)
/// and devtmpfs on `/dev` (`CONFIG_DEVTMPFS_MOUNT=y`).
/// Errors returned here are fatal to PID 1 before it forks `guest-control-server`.
pub fn init_filesystem() -> Result<(), InitError> {
    eprintln!("[guest-init] Starting filesystem initialization");

    // 1. Mount /proc.
    mount(
        Some("proc"),
        "/proc",
        Some("proc"),
        MsFlags::empty(),
        None::<&str>,
    )
    .map_err(|e| InitError::Mount {
        target: "/proc".into(),
        source: e,
    })?;

    // 2. Configure aggressive TCP keepalive for faster dead connection detection.
    // Default values (7200s/75s/9 probes = ~2h11m) exceed JOB_TIMEOUT (2h),
    // so dead connections are never detected. These values reduce detection to ~2min.
    for (param, value) in [
        ("tcp_keepalive_time", "60"),
        ("tcp_keepalive_intvl", "10"),
        ("tcp_keepalive_probes", "6"),
    ] {
        let path = format!("/proc/sys/net/ipv4/{param}");
        if let Err(e) = fs::write(&path, value) {
            eprintln!("[guest-init] Warning: failed to set {param}: {e}");
        }
    }

    // 3. Mount /sys and initialize exec process containment.
    mount(
        Some("sys"),
        "/sys",
        Some("sysfs"),
        MsFlags::empty(),
        None::<&str>,
    )
    .map_err(|e| InitError::Mount {
        target: "/sys".into(),
        source: e,
    })?;

    initialize_process_containment()?;

    // 4. Mount tmpfs on /dev/shm — required by Chromium for shared memory.
    // devtmpfs (CONFIG_DEVTMPFS_MOUNT=y) doesn't create /dev/shm.
    let _ = fs::create_dir_all("/dev/shm");
    mount(
        Some("tmpfs"),
        "/dev/shm",
        Some("tmpfs"),
        MsFlags::empty(),
        Some("mode=1777"),
    )
    .map_err(|e| InitError::Mount {
        target: "/dev/shm".into(),
        source: e,
    })?;

    eprintln!("[guest-init] Virtual filesystems mounted");

    // 5. Load environment variables.
    //
    // /etc/environment is baked into the rootfs by customize-rootfs.sh and
    // contains variables shared by ALL users (LANG, NODE_EXTRA_CA_CERTS, …).
    // PAM also reads it during sandbox-user transitions, but the init process
    // (root) and its direct children do not go through PAM, so we load it
    // explicitly here.
    //
    // SAFETY: We are the init process, no other threads are running yet
    unsafe {
        load_etc_environment();
        std::env::set_var("HOME", "/root");
        std::env::set_var("USER", "root");
        std::env::set_var("SHELL", "/bin/bash");
    }

    // 6. Change to root home directory. The command launcher selects the
    // sandbox user's home explicitly when it transitions users.
    let _ = std::env::set_current_dir("/root");

    eprintln!("[guest-init] Filesystem initialization complete");
    Ok(())
}

/// Errors that can occur during filesystem initialization
#[derive(Debug)]
pub enum InitError {
    Mount {
        target: String,
        source: nix::Error,
    },
    Filesystem {
        operation: &'static str,
        path: String,
        source: io::Error,
    },
    InvalidProcessContainment(String),
}

impl std::fmt::Display for InitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InitError::Mount { target, source } => {
                write!(f, "Failed to mount {}: {}", target, source)
            }
            InitError::Filesystem {
                operation,
                path,
                source,
            } => write!(f, "Failed to {operation} {path}: {source}"),
            InitError::InvalidProcessContainment(message) => {
                write!(f, "Invalid process containment: {message}")
            }
        }
    }
}

impl std::error::Error for InitError {}

/// Mount cgroup v2 and validate the canonical exec process-containment base.
///
/// Cgroup v2 is mounted at `CGROUP_V2_MOUNT_PATH`. The exec base at
/// `EXEC_CGROUP_BASE_PATH` must be empty, distribute the `cpu`, `memory`, and
/// `pids` controllers, and carry the ancestor `memory.min` required for
/// effective control-process protection. `guest-control-server` creates an empty
/// operation parent and two controlled leaves beneath it for each exec
/// operation.
fn initialize_process_containment() -> Result<(), InitError> {
    create_dir_all(Path::new(CGROUP_V2_MOUNT_PATH))?;
    // CLI children and managed tools migrate before exec. Favor these dynamic
    // placements over fork/exit throughput; this policy applies only to the guest.
    mount(
        Some("cgroup2"),
        CGROUP_V2_MOUNT_PATH,
        Some("cgroup2"),
        MsFlags::MS_NODEV | MsFlags::MS_NOEXEC | MsFlags::MS_NOSUID,
        Some("favordynmods"),
    )
    .map_err(|source| InitError::Mount {
        target: CGROUP_V2_MOUNT_PATH.into(),
        source,
    })?;

    let mount = Path::new(CGROUP_V2_MOUNT_PATH);
    enable_required_controllers(mount)?;

    let base = Path::new(EXEC_CGROUP_BASE_PATH);
    create_dir_all(base)?;
    enable_required_controllers(base)?;
    let memory_min_path = base.join(MEMORY_MIN_FILE);
    fs::write(
        &memory_min_path,
        CONTROL_MEMORY_MIN_BYTES.to_string().as_bytes(),
    )
    .map_err(|source| InitError::Filesystem {
        operation: "configure control memory protection in",
        path: memory_min_path.display().to_string(),
        source,
    })?;
    verify_process_containment_base(base)?;
    eprintln!("[guest-init] Exec process containment initialized");
    Ok(())
}

fn enable_required_controllers(cgroup: &Path) -> Result<(), InitError> {
    let controllers_path = cgroup.join(CGROUP_CONTROLLERS_FILE);
    let controllers =
        fs::read_to_string(&controllers_path).map_err(|source| InitError::Filesystem {
            operation: "read",
            path: controllers_path.display().to_string(),
            source,
        })?;
    verify_required_controllers(&controllers, "available")?;

    let subtree_control_path = cgroup.join(CGROUP_SUBTREE_CONTROL_FILE);
    fs::write(
        &subtree_control_path,
        REQUIRED_CGROUP_SUBTREE_CONTROL.as_bytes(),
    )
    .map_err(|source| InitError::Filesystem {
        operation: "enable required controllers in",
        path: subtree_control_path.display().to_string(),
        source,
    })?;

    let enabled =
        fs::read_to_string(&subtree_control_path).map_err(|source| InitError::Filesystem {
            operation: "read",
            path: subtree_control_path.display().to_string(),
            source,
        })?;
    verify_required_controllers(&enabled, "enabled")
}

fn verify_required_controllers(content: &str, state: &str) -> Result<(), InitError> {
    let controllers = content.split_ascii_whitespace().collect::<Vec<_>>();
    let missing = REQUIRED_CGROUP_CONTROLLERS
        .into_iter()
        .filter(|required| !controllers.contains(required))
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }
    Err(InitError::InvalidProcessContainment(format!(
        "required cgroup controllers are not {state}: {}",
        missing.join(",")
    )))
}

fn create_dir_all(path: &Path) -> Result<(), InitError> {
    fs::create_dir_all(path).map_err(|source| InitError::Filesystem {
        operation: "create directory",
        path: path.display().to_string(),
        source,
    })
}

fn verify_process_containment_base(base: &Path) -> Result<(), InitError> {
    for filename in [
        CGROUP_CONTROLLERS_FILE,
        CGROUP_PROCS_FILE,
        CGROUP_EVENTS_FILE,
        CGROUP_KILL_FILE,
        CGROUP_SUBTREE_CONTROL_FILE,
        CPU_WEIGHT_FILE,
        MEMORY_MIN_FILE,
        PIDS_MAX_FILE,
    ] {
        let path = base.join(filename);
        let metadata = fs::metadata(&path).map_err(|source| InitError::Filesystem {
            operation: "inspect",
            path: path.display().to_string(),
            source,
        })?;
        if !metadata.is_file() {
            return Err(InitError::InvalidProcessContainment(format!(
                "{} is not a file",
                path.display()
            )));
        }
    }

    let subtree_control =
        fs::read_to_string(base.join(CGROUP_SUBTREE_CONTROL_FILE)).map_err(|source| {
            InitError::Filesystem {
                operation: "read",
                path: base.join(CGROUP_SUBTREE_CONTROL_FILE).display().to_string(),
                source,
            }
        })?;
    verify_required_controllers(&subtree_control, "enabled")?;

    let direct_processes = fs::read_to_string(base.join(CGROUP_PROCS_FILE)).map_err(|source| {
        InitError::Filesystem {
            operation: "read",
            path: base.join(CGROUP_PROCS_FILE).display().to_string(),
            source,
        }
    })?;
    if !direct_processes.trim().is_empty() {
        return Err(InitError::InvalidProcessContainment(
            "exec cgroup base contains direct processes".into(),
        ));
    }
    let memory_min =
        fs::read_to_string(base.join(MEMORY_MIN_FILE)).map_err(|source| InitError::Filesystem {
            operation: "read",
            path: base.join(MEMORY_MIN_FILE).display().to_string(),
            source,
        })?;
    if memory_min.trim() != CONTROL_MEMORY_MIN_BYTES.to_string() {
        return Err(InitError::InvalidProcessContainment(format!(
            "exec cgroup base {MEMORY_MIN_FILE} does not preserve control memory"
        )));
    }
    Ok(())
}

/// Parse environment file content into key-value pairs.
///
/// Skips blank lines, comments, and lines without `=`.
/// Values may be optionally wrapped in double quotes which are stripped.
fn parse_env_content(content: &str) -> Vec<(&str, &str)> {
    let mut pairs = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim();
            let value = value.trim().trim_matches('"');
            if !key.is_empty() {
                pairs.push((key, value));
            }
        }
    }
    pairs
}

/// Parse `/etc/environment` and set each `KEY=VALUE` pair via `set_var`.
///
/// SAFETY: caller must ensure no other threads are running.
unsafe fn load_etc_environment() {
    let content = match fs::read_to_string("/etc/environment") {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[guest-init] Warning: failed to read /etc/environment: {e}");
            return;
        }
    };
    for (key, value) in parse_env_content(&content) {
        unsafe { std::env::set_var(key, value) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_cgroup_core_files(base: &Path, subtree_control: &str) {
        fs::create_dir_all(base).unwrap();
        for (filename, content) in [
            (CGROUP_CONTROLLERS_FILE, "cpu memory pids\n"),
            (CGROUP_PROCS_FILE, ""),
            (CGROUP_EVENTS_FILE, "populated 0\nfrozen 0\n"),
            (CGROUP_KILL_FILE, ""),
            (CGROUP_SUBTREE_CONTROL_FILE, subtree_control),
            (CPU_WEIGHT_FILE, "100\n"),
            (PIDS_MAX_FILE, "max\n"),
        ] {
            fs::write(base.join(filename), content).unwrap();
        }
        fs::write(
            base.join(MEMORY_MIN_FILE),
            CONTROL_MEMORY_MIN_BYTES.to_string(),
        )
        .unwrap();
    }

    #[test]
    fn parse_env_basic() {
        let content = "LANG=en_US.UTF-8\nPATH=/usr/bin:/bin";
        let pairs = parse_env_content(content);
        assert_eq!(
            pairs,
            vec![("LANG", "en_US.UTF-8"), ("PATH", "/usr/bin:/bin")]
        );
    }

    #[test]
    fn parse_env_quoted_values() {
        let content = r#"FOO="bar baz""#;
        let pairs = parse_env_content(content);
        assert_eq!(pairs, vec![("FOO", "bar baz")]);
    }

    #[test]
    fn parse_env_skips_comments_and_blanks() {
        let content = "# comment\n\nKEY=value\n  \n# another comment\n";
        let pairs = parse_env_content(content);
        assert_eq!(pairs, vec![("KEY", "value")]);
    }

    #[test]
    fn parse_env_skips_lines_without_equals() {
        let content = "no_equals_sign\nGOOD=yes";
        let pairs = parse_env_content(content);
        assert_eq!(pairs, vec![("GOOD", "yes")]);
    }

    #[test]
    fn parse_env_trims_whitespace() {
        let content = "  KEY  =  value  ";
        let pairs = parse_env_content(content);
        assert_eq!(pairs, vec![("KEY", "value")]);
    }

    #[test]
    fn parse_env_empty_value() {
        let content = "EMPTY=";
        let pairs = parse_env_content(content);
        assert_eq!(pairs, vec![("EMPTY", "")]);
    }

    #[test]
    fn parse_env_value_with_equals() {
        // Values may legitimately contain `=`; only the first one separates key/value.
        let content = "TOKEN=abc=def==";
        let pairs = parse_env_content(content);
        assert_eq!(pairs, vec![("TOKEN", "abc=def==")]);
    }

    #[test]
    fn parse_env_empty_key_skipped() {
        let content = "=value";
        let pairs = parse_env_content(content);
        assert!(pairs.is_empty());
    }

    #[test]
    fn init_error_display() {
        let err = InitError::Mount {
            target: "/proc".into(),
            source: nix::Error::EACCES,
        };
        let msg = err.to_string();
        assert!(msg.contains("/proc"));
        assert!(msg.contains("EACCES"));
    }

    #[test]
    fn process_containment_base_requires_core_files() {
        let dir = tempfile::tempdir().unwrap();
        write_cgroup_core_files(dir.path(), "");
        fs::remove_file(dir.path().join(CGROUP_KILL_FILE)).unwrap();

        let error = verify_process_containment_base(dir.path()).unwrap_err();

        assert!(error.to_string().contains(CGROUP_KILL_FILE));
    }

    #[test]
    fn process_containment_base_rejects_missing_controller() {
        let dir = tempfile::tempdir().unwrap();
        write_cgroup_core_files(dir.path(), "cpu memory\n");

        let error = verify_process_containment_base(dir.path()).unwrap_err();

        assert!(error.to_string().contains("pids"));
    }

    #[test]
    fn process_containment_base_accepts_required_controllers() {
        let dir = tempfile::tempdir().unwrap();
        write_cgroup_core_files(dir.path(), "cpu memory pids\n");

        verify_process_containment_base(dir.path()).unwrap();
    }

    #[test]
    fn process_containment_base_rejects_direct_processes() {
        let dir = tempfile::tempdir().unwrap();
        write_cgroup_core_files(dir.path(), "cpu memory pids\n");
        fs::write(dir.path().join(CGROUP_PROCS_FILE), "123\n").unwrap();

        let error = verify_process_containment_base(dir.path()).unwrap_err();

        assert!(error.to_string().contains("direct processes"));
    }

    #[test]
    fn process_containment_base_rejects_missing_ancestor_memory_protection() {
        let dir = tempfile::tempdir().unwrap();
        write_cgroup_core_files(dir.path(), "cpu memory pids\n");
        fs::write(dir.path().join(MEMORY_MIN_FILE), "0\n").unwrap();

        let error = verify_process_containment_base(dir.path()).unwrap_err();

        assert!(error.to_string().contains("preserve control memory"));
    }
}
