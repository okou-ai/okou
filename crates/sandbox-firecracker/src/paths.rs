//! Canonical path helpers for sandbox-firecracker on-disk and runtime layout.
//!
//! Factory workspaces live under the configured factory base directory, while
//! runtime sockets live under `/run/vm0/sock/<id>/`. Snapshot outputs use fixed
//! artifact names such as `snapshot.bin`, `memory.bin`, `cow.img`, and the
//! `cow.img.bitmap` dirty-bitmap sidecar.

use std::path::{Path, PathBuf};

use crate::SnapshotConfig;

/// Base directory for runtime sockets under `/run`.
/// Created and validated as an owner-writable runtime namespace by `prerequisites.rs`.
pub const RUNTIME_DIR: &str = "/run/vm0";

/// Runtime paths under `/run/vm0/`.
pub struct RuntimePaths {
    base_dir: PathBuf,
}

impl Default for RuntimePaths {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimePaths {
    /// Creates runtime path helpers rooted at `RUNTIME_DIR`.
    ///
    /// This only records the runtime root; it does not create, validate, or
    /// canonicalize filesystem entries.
    pub fn new() -> Self {
        Self {
            base_dir: PathBuf::from(RUNTIME_DIR),
        }
    }

    #[cfg(test)]
    pub fn with_dir_for_test(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// Socket base directory: `/run/vm0/sock/`.
    pub fn sock_base(&self) -> PathBuf {
        self.base_dir.join("sock")
    }

    /// Socket directory: `/run/vm0/sock/<id>/`.
    pub fn sock_dir(&self, id: &str) -> PathBuf {
        self.sock_base().join(id)
    }
}

/// Lock file paths under `/var/lock` for flock-based coordination.
///
/// `/var/lock` is the FHS-standard location for lock files (mode 1777).
pub struct LockPaths {
    base_dir: PathBuf,
}

impl Default for LockPaths {
    fn default() -> Self {
        Self::new()
    }
}

impl LockPaths {
    /// Creates lock path helpers rooted at `/var/lock`.
    ///
    /// This only records the lock root; it does not create, validate, or
    /// canonicalize filesystem entries.
    pub fn new() -> Self {
        Self {
            base_dir: PathBuf::from("/var/lock"),
        }
    }

    #[cfg(test)]
    pub fn with_dir(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// Lock file for netns pool index allocation.
    pub fn netns_pool(&self, index: u32) -> PathBuf {
        self.base_dir.join(format!("vm0-netns-pool-{index}.lock"))
    }
}

/// Factory-level paths derived from the base directory.
pub struct FactoryPaths {
    base_dir: PathBuf,
}

impl FactoryPaths {
    /// Creates factory path helpers rooted at `base_dir`.
    ///
    /// This only stores the root path; it does not create, validate, or
    /// canonicalize filesystem entries.
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// Directory containing per-sandbox workspace directories.
    pub fn workspaces(&self) -> PathBuf {
        self.base_dir.join("workspaces")
    }

    /// Workspace directory for one sandbox or snapshot work tree.
    pub fn workspace(&self, id: &str) -> PathBuf {
        self.workspaces().join(id)
    }
}

/// Per-sandbox workspace paths (persistent data: config, COW, home image).
pub struct SandboxPaths {
    workspace: PathBuf,
}

impl SandboxPaths {
    /// Creates per-sandbox path helpers rooted at `workspace`.
    ///
    /// This only stores the workspace path; it does not create, validate, or
    /// canonicalize filesystem entries.
    pub fn new(workspace: PathBuf) -> Self {
        Self { workspace }
    }

    /// Returns the sandbox workspace root directory.
    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    /// Serialized Firecracker configuration for this sandbox workspace.
    pub fn config(&self) -> PathBuf {
        self.workspace.join("config.json")
    }

    /// Bind mount target for the COW device during snapshot restore.
    /// Must be a regular file (not a block device) so bind mount works.
    pub fn cow_device_bind(&self) -> PathBuf {
        self.workspace.join("cow-device-bind")
    }

    /// Active home block image for this sandbox.
    pub fn home_image(&self) -> PathBuf {
        self.workspace.join("home.ext4")
    }

    /// Bind mount target for the home image during snapshot restore.
    /// Must be a regular file (not a directory) so bind mount works.
    pub fn home_device_bind(&self) -> PathBuf {
        self.workspace.join("home-device-bind")
    }
}

/// Per-sandbox runtime socket paths.
pub struct SockPaths {
    dir: PathBuf,
}

impl SockPaths {
    /// Creates socket path helpers rooted at `dir`.
    ///
    /// This only stores the socket directory path; it does not create,
    /// validate, or canonicalize filesystem entries.
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// Returns the runtime socket root directory.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Firecracker API Unix-domain socket, `api.sock`.
    pub fn api_sock(&self) -> PathBuf {
        self.dir.join("api.sock")
    }

    /// Directory used as the base for guest vsock Unix-domain sockets.
    pub fn vsock_dir(&self) -> PathBuf {
        self.dir.join("vsock")
    }

    /// Host-side vsock listener socket, `vsock/vsock.sock`.
    pub fn vsock(&self) -> PathBuf {
        self.vsock_dir().join("vsock.sock")
    }

    /// Dedicated Guest-to-Runner RPC within the private vsock directory.
    pub(crate) fn guest_rpc(&self) -> PathBuf {
        self.vsock_dir()
            .join(format!("vsock.sock_{}", runner_rpc_proto::VSOCK_PORT))
    }

    /// Okou control server Unix-domain socket, `control.sock`.
    pub fn control_sock(&self) -> PathBuf {
        self.dir.join("control.sock")
    }
}

/// Paths for snapshot output artifacts within an output directory.
pub struct SnapshotOutputPaths {
    output_dir: PathBuf,
}

impl SnapshotOutputPaths {
    /// Creates snapshot output path helpers rooted at `output_dir`.
    ///
    /// This only stores the output directory path; it does not create,
    /// validate, or canonicalize filesystem entries.
    pub fn new(output_dir: PathBuf) -> Self {
        Self { output_dir }
    }

    /// Returns the snapshot output root directory.
    pub fn dir(&self) -> &Path {
        &self.output_dir
    }

    /// Firecracker VM state snapshot, `snapshot.bin`.
    pub fn snapshot(&self) -> PathBuf {
        self.output_dir.join("snapshot.bin")
    }

    /// Firecracker guest memory snapshot, `memory.bin`.
    pub fn memory(&self) -> PathBuf {
        self.output_dir.join("memory.bin")
    }

    /// Root drive COW image captured for the snapshot, `cow.img`.
    pub fn cow(&self) -> PathBuf {
        self.output_dir.join("cow.img")
    }

    /// Dirty-bitmap sidecar for `cow.img`, stored as `cow.img.bitmap`.
    pub fn cow_bitmap(&self) -> PathBuf {
        self.output_dir.join("cow.img.bitmap")
    }

    /// Returns the four regular files required for a reusable snapshot.
    ///
    /// The completion marker is intentionally separate because it is the
    /// publication commit signal rather than a snapshot data artifact.
    pub fn required_artifacts(&self) -> [PathBuf; 4] {
        [
            self.snapshot(),
            self.memory(),
            self.cow(),
            self.cow_bitmap(),
        ]
    }

    /// Commit marker written only after all snapshot artifacts are published.
    pub fn complete_marker(&self) -> PathBuf {
        self.output_dir.join(".snapshot-complete")
    }

    /// Work directory used during snapshot creation.
    /// Its layout is preserved as bind-mount targets during restore.
    pub fn work_dir(&self) -> PathBuf {
        self.output_dir.join("work")
    }

    /// Build a [`SnapshotConfig`] combining the output artifacts with
    /// the work directory paths recorded during snapshot creation.
    ///
    /// `sock_id` identifies the socket directory under `/run/vm0/sock/` —
    /// typically the config hash so each snapshot gets a unique path. It must
    /// satisfy the Firecracker socket-ID requirements documented on
    /// [`sandbox::SnapshotCreateConfig::id`], including room for the
    /// `_52000` control and `_52001` RPC listener suffixes.
    ///
    /// This helper only constructs paths; it does not validate `sock_id`.
    /// Callers must ensure these requirements are met before using the returned
    /// config.
    pub fn snapshot_config(&self, sock_id: &str) -> SnapshotConfig {
        let work = SandboxPaths::new(self.work_dir());
        let runtime = RuntimePaths::new();
        let sock = SockPaths::new(runtime.sock_dir(sock_id));
        SnapshotConfig {
            snapshot_path: self.snapshot(),
            memory_path: self.memory(),
            cow_path: self.cow(),
            drive_bind_path: work.cow_device_bind(),
            home_drive_bind_path: work.home_device_bind(),
            vsock_bind_dir: sock.vsock_dir(),
        }
    }
}

#[cfg(test)]
mod tests;
