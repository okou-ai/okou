use std::os::fd::{AsFd, AsRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::boot_config::{
    BalloonConfig, BootSourceConfig, DriveConfig, MachineConfig, NetworkInterfaceConfig,
    VsockConfig,
};
use crate::config::RateLimiterConfig;
use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use reqwest::Method;
use tokio::io::unix::AsyncFd;

use super::http;

/// Error from Firecracker API calls.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    /// Failed to connect to the Unix domain socket.
    #[error("connect: {0}")]
    Connect(#[source] std::io::Error),
    /// Firecracker returned a non-2xx HTTP response.
    #[error("HTTP {status}: {body}")]
    Http { status: u16, body: String },
    /// HTTP client construction, protocol, or response-body failure.
    #[error("HTTP transport: {0}")]
    Transport(#[source] reqwest::Error),
    /// Other failure (readiness setup, timeout, serialization, parsing, or size limits).
    #[error("{0}")]
    Other(String),
}

impl ApiError {
    /// Whether this error is transient and worth retrying during readiness polling.
    pub(super) fn is_retryable(&self) -> bool {
        match self {
            Self::Connect(e) => e.kind() == std::io::ErrorKind::ConnectionRefused,
            Self::Http { .. } | Self::Transport(_) | Self::Other(_) => true,
        }
    }
}

/// Statistics returned by Firecracker's balloon device.
///
/// Requires `stats_polling_interval_s > 0` configured pre-boot.
/// Fields beyond `target_mib`/`actual_mib` depend on the guest kernel version.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct BalloonStatistics {
    /// Target balloon size in MiB (set by host).
    pub target_mib: u32,
    /// Actual balloon size in MiB (reported by guest driver).
    pub actual_mib: u32,
    /// Target balloon size in 4 KiB pages.
    pub target_pages: u64,
    /// Actual balloon size in 4 KiB pages.
    pub actual_pages: u64,
    /// Memory not used for any purpose (bytes).
    #[serde(default)]
    pub free_memory: Option<i64>,
    /// Estimate of memory available for new applications (bytes).
    #[serde(default)]
    pub available_memory: Option<i64>,
    /// Total memory visible to guest (bytes).
    #[serde(default)]
    pub total_memory: Option<i64>,
    /// Memory swapped in from disk (bytes).
    #[serde(default)]
    pub swap_in: Option<i64>,
    /// Memory swapped out to disk (bytes).
    #[serde(default)]
    pub swap_out: Option<i64>,
    /// Major page fault count.
    #[serde(default)]
    pub major_faults: Option<i64>,
    /// Minor page fault count.
    #[serde(default)]
    pub minor_faults: Option<i64>,
    /// Memory used for disk caching (bytes).
    #[serde(default)]
    pub disk_caches: Option<i64>,
}

/// Per-request timeout matching the TS client (30s).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Extended timeout for snapshot creation. Writing a full memory dump
/// (up to 4 GiB for browser profile) can exceed the default 30s timeout.
const SNAPSHOT_CREATE_TIMEOUT: Duration = Duration::from_secs(120);

/// HTTP-over-Unix-socket client for the Firecracker API.
pub struct ApiClient {
    socket_path: PathBuf,
    http: reqwest::Client,
    #[cfg(test)]
    pub(super) socket_wait_started: Option<std::sync::Arc<tokio::sync::Notify>>,
}

impl ApiClient {
    /// Construct a client configured for the Firecracker API Unix socket.
    ///
    /// This configures the HTTP transport for `socket_path` without checking
    /// whether the socket exists or connecting to Firecracker. The constructor
    /// can therefore succeed before the socket is created or the API is ready.
    /// Missing, unavailable, or not-yet-ready sockets are reported when
    /// [`Self::wait_for_ready`] or another request method is awaited.
    ///
    /// Call [`Self::wait_for_ready`] before issuing Firecracker API operations
    /// when a readiness guarantee is required.
    pub fn new(socket_path: &Path) -> Result<Self, ApiError> {
        Ok(Self {
            socket_path: socket_path.to_owned(),
            http: http::build_client(socket_path)?,
            #[cfg(test)]
            socket_wait_started: None,
        })
    }

    /// Wait for the Firecracker API socket to accept connections.
    ///
    /// Uses inotify to wait for the socket file, then polls GET / until it succeeds.
    pub async fn wait_for_ready(&self, timeout: Duration) -> Result<(), ApiError> {
        let deadline = tokio::time::Instant::now() + timeout;

        // Phase 1: wait for socket file via inotify.
        if !tokio::fs::try_exists(&self.socket_path)
            .await
            .unwrap_or(false)
        {
            tokio::time::timeout_at(
                deadline,
                wait_for_socket_file(
                    &self.socket_path,
                    #[cfg(test)]
                    self.socket_wait_started.as_deref(),
                ),
            )
            .await
            .map_err(|_| {
                ApiError::Other(format!(
                    "timed out after {timeout:?} waiting for socket file"
                ))
            })??;
        }

        // Phase 2: poll GET / until the API responds with success.
        // Non-retryable errors (e.g. PermissionDenied on connect) fail immediately
        // instead of spinning until timeout.
        loop {
            match tokio::time::timeout_at(
                deadline,
                http::send_request(
                    &self.http,
                    Method::GET,
                    "/",
                    None,
                    http::ResponseMode::StatusOnly,
                ),
            )
            .await
            {
                Ok(Ok(_)) => return Ok(()),
                Ok(Err(e)) if e.is_retryable() => {
                    let retry_at = tokio::time::Instant::now() + Duration::from_millis(10);
                    tokio::time::sleep_until(retry_at.min(deadline)).await;
                }
                Ok(Err(e)) => return Err(e),
                Err(_) => {
                    return Err(ApiError::Other(format!(
                        "timed out after {timeout:?} waiting for API ready"
                    )));
                }
            }
        }
    }

    /// Load a snapshot via PUT /snapshot/load.
    pub async fn load_snapshot(
        &self,
        snapshot_path: &str,
        mem_path: &str,
        resume_vm: bool,
    ) -> Result<(), ApiError> {
        self.send_json(
            Method::PUT,
            "/snapshot/load",
            &serde_json::json!({
                "snapshot_path": snapshot_path,
                "mem_backend": {
                    "backend_type": "File",
                    "backend_path": mem_path,
                },
                "resume_vm": resume_vm,
            }),
            REQUEST_TIMEOUT,
        )
        .await
    }

    /// Pause the VM via PATCH /vm.
    ///
    /// The VM must be paused before creating a snapshot.
    pub async fn pause(&self) -> Result<(), ApiError> {
        self.send_json(
            Method::PATCH,
            "/vm",
            &serde_json::json!({ "state": "Paused" }),
            REQUEST_TIMEOUT,
        )
        .await
    }

    /// Resume a paused VM via PATCH /vm.
    ///
    /// Must be called before any guest interaction after a [`Self::pause`].
    pub async fn resume(&self) -> Result<(), ApiError> {
        self.send_json(
            Method::PATCH,
            "/vm",
            &serde_json::json!({ "state": "Resumed" }),
            REQUEST_TIMEOUT,
        )
        .await
    }

    /// Create a snapshot via PUT /snapshot/create.
    ///
    /// The VM must be paused first (see [`Self::pause`]).
    /// Uses an extended timeout because writing a full memory dump to disk
    /// can take well over 30s for large VMs (e.g. 4 GiB for browser profile).
    pub async fn create_snapshot(
        &self,
        snapshot_path: &str,
        mem_path: &str,
    ) -> Result<(), ApiError> {
        self.send_json(
            Method::PUT,
            "/snapshot/create",
            &serde_json::json!({
                "snapshot_type": "Full",
                "snapshot_path": snapshot_path,
                "mem_file_path": mem_path,
            }),
            SNAPSHOT_CREATE_TIMEOUT,
        )
        .await
    }

    /// Configure the machine (vCPU count and memory) via PUT /machine-config.
    pub async fn configure_machine(
        &self,
        vcpu_count: u32,
        mem_size_mib: u32,
    ) -> Result<(), ApiError> {
        self.configure_machine_payload(&MachineConfig {
            vcpu_count,
            mem_size_mib,
        })
        .await
    }

    pub(crate) async fn configure_machine_payload(
        &self,
        config: &MachineConfig,
    ) -> Result<(), ApiError> {
        self.send_json(Method::PUT, "/machine-config", config, REQUEST_TIMEOUT)
            .await
    }

    /// Configure the boot source via PUT /boot-source.
    pub async fn configure_boot_source(
        &self,
        kernel_image_path: &str,
        boot_args: &str,
    ) -> Result<(), ApiError> {
        self.configure_boot_source_payload(&BootSourceConfig {
            kernel_image_path: kernel_image_path.to_owned(),
            boot_args: boot_args.to_owned(),
        })
        .await
    }

    pub(crate) async fn configure_boot_source_payload(
        &self,
        config: &BootSourceConfig,
    ) -> Result<(), ApiError> {
        self.send_json(Method::PUT, "/boot-source", config, REQUEST_TIMEOUT)
            .await
    }

    /// Configure a drive via PUT /drives/{drive_id}.
    pub async fn configure_drive(
        &self,
        drive_id: &str,
        path_on_host: &str,
        is_root_device: bool,
        is_read_only: bool,
        rate_limiter: Option<&RateLimiterConfig>,
    ) -> Result<(), ApiError> {
        self.configure_drive_payload(&DriveConfig {
            drive_id: drive_id.to_owned(),
            path_on_host: path_on_host.to_owned(),
            is_root_device,
            is_read_only,
            rate_limiter: rate_limiter.cloned(),
        })
        .await
    }

    pub(crate) async fn configure_drive_payload(
        &self,
        config: &DriveConfig,
    ) -> Result<(), ApiError> {
        let path = format!("/drives/{}", config.drive_id);
        self.send_json(Method::PUT, &path, config, REQUEST_TIMEOUT)
            .await
    }

    /// Update a drive rate limiter via PATCH /drives/{drive_id}.
    pub async fn patch_drive_rate_limiter(
        &self,
        drive_id: &str,
        rate_limiter: &RateLimiterConfig,
    ) -> Result<(), ApiError> {
        let path = format!("/drives/{drive_id}");
        self.send_json(
            Method::PATCH,
            &path,
            &serde_json::json!({
                "drive_id": drive_id,
                "rate_limiter": rate_limiter,
            }),
            REQUEST_TIMEOUT,
        )
        .await
    }

    /// Configure a network interface via PUT /network-interfaces/{iface_id}.
    pub async fn configure_network_interface(
        &self,
        iface_id: &str,
        guest_mac: &str,
        host_dev_name: &str,
        rx_rate_limiter: Option<&RateLimiterConfig>,
        tx_rate_limiter: Option<&RateLimiterConfig>,
    ) -> Result<(), ApiError> {
        self.configure_network_interface_payload(&NetworkInterfaceConfig {
            iface_id: iface_id.to_owned(),
            guest_mac: guest_mac.to_owned(),
            host_dev_name: host_dev_name.to_owned(),
            rx_rate_limiter: rx_rate_limiter.cloned(),
            tx_rate_limiter: tx_rate_limiter.cloned(),
        })
        .await
    }

    pub(crate) async fn configure_network_interface_payload(
        &self,
        config: &NetworkInterfaceConfig,
    ) -> Result<(), ApiError> {
        let path = format!("/network-interfaces/{}", config.iface_id);
        self.send_json(Method::PUT, &path, config, REQUEST_TIMEOUT)
            .await
    }

    /// Update network interface rate limiters via PATCH /network-interfaces/{iface_id}.
    pub async fn patch_network_rate_limiters(
        &self,
        iface_id: &str,
        rx_rate_limiter: &RateLimiterConfig,
        tx_rate_limiter: &RateLimiterConfig,
    ) -> Result<(), ApiError> {
        let path = format!("/network-interfaces/{iface_id}");
        self.send_json(
            Method::PATCH,
            &path,
            &serde_json::json!({
                "iface_id": iface_id,
                "rx_rate_limiter": rx_rate_limiter,
                "tx_rate_limiter": tx_rate_limiter,
            }),
            REQUEST_TIMEOUT,
        )
        .await
    }

    /// Configure the vsock device via PUT /vsock.
    pub async fn configure_vsock(&self, guest_cid: u32, uds_path: &str) -> Result<(), ApiError> {
        self.configure_vsock_payload(&VsockConfig {
            guest_cid,
            uds_path: uds_path.to_owned(),
        })
        .await
    }

    pub(crate) async fn configure_vsock_payload(
        &self,
        config: &VsockConfig,
    ) -> Result<(), ApiError> {
        self.send_json(Method::PUT, "/vsock", config, REQUEST_TIMEOUT)
            .await
    }

    /// Update balloon target size at runtime via PATCH /balloon.
    ///
    /// Unlike [`Self::configure_balloon`] (PUT, pre-boot only), this can be called
    /// while the VM is running to dynamically inflate or deflate the balloon.
    pub async fn patch_balloon(&self, amount_mib: u32) -> Result<(), ApiError> {
        self.send_json(
            Method::PATCH,
            "/balloon",
            &serde_json::json!({ "amount_mib": amount_mib }),
            REQUEST_TIMEOUT,
        )
        .await
    }

    /// Retrieve balloon device statistics via GET /balloon/statistics.
    ///
    /// Requires `stats_polling_interval_s > 0` configured pre-boot via
    /// [`Self::configure_balloon`]. Returns an error if statistics were not enabled.
    pub async fn get_balloon_statistics(&self) -> Result<BalloonStatistics, ApiError> {
        let body = self
            .send_body(Method::GET, "/balloon/statistics", REQUEST_TIMEOUT)
            .await?;
        serde_json::from_slice(&body)
            .map_err(|e| ApiError::Other(format!("parse balloon statistics: {e}")))
    }

    /// Configure the balloon device via PUT /balloon.
    ///
    /// Must be called before starting the instance.
    ///
    /// With `deflate_on_oom` enabled, the balloon can return memory to the guest
    /// to mitigate OOM pressure. This does not guarantee protection from OOM kills:
    /// an empty or exhausted balloon has no pages to return, and an allocation
    /// can exceed the remaining releasable pages. See [Firecracker's balloon
    /// documentation][balloon-docs] for other allocation restrictions.
    ///
    /// [balloon-docs]: https://github.com/firecracker-microvm/firecracker/blob/v1.16.2/docs/ballooning.md#what-is-the-balloon-device
    pub async fn configure_balloon(
        &self,
        amount_mib: u32,
        deflate_on_oom: bool,
        free_page_reporting: bool,
        stats_polling_interval_s: u32,
    ) -> Result<(), ApiError> {
        self.configure_balloon_payload(&BalloonConfig {
            amount_mib,
            deflate_on_oom,
            free_page_reporting,
            stats_polling_interval_s,
        })
        .await
    }

    pub(crate) async fn configure_balloon_payload(
        &self,
        config: &BalloonConfig,
    ) -> Result<(), ApiError> {
        self.send_json(Method::PUT, "/balloon", config, REQUEST_TIMEOUT)
            .await
    }

    /// Start the VM instance via PUT /actions.
    pub async fn start_instance(&self) -> Result<(), ApiError> {
        self.send_json(
            Method::PUT,
            "/actions",
            &serde_json::json!({ "action_type": "InstanceStart" }),
            REQUEST_TIMEOUT,
        )
        .await
    }

    async fn send_status(
        &self,
        method: Method,
        path: &str,
        body: Option<&serde_json::Value>,
        timeout: Duration,
    ) -> Result<(), ApiError> {
        tokio::time::timeout(
            timeout,
            http::send_request(
                &self.http,
                method,
                path,
                body,
                http::ResponseMode::StatusOnly,
            ),
        )
        .await
        .map_err(|_| ApiError::Other(format!("request timed out after {timeout:?}")))??;
        Ok(())
    }

    async fn send_body(
        &self,
        method: Method,
        path: &str,
        timeout: Duration,
    ) -> Result<Vec<u8>, ApiError> {
        tokio::time::timeout(
            timeout,
            http::send_request(&self.http, method, path, None, http::ResponseMode::Collect),
        )
        .await
        .map_err(|_| ApiError::Other(format!("request timed out after {timeout:?}")))?
    }

    async fn send_json<T: serde::Serialize + ?Sized>(
        &self,
        method: Method,
        path: &str,
        value: &T,
        timeout: Duration,
    ) -> Result<(), ApiError> {
        let value = serde_json::to_value(value)
            .map_err(|error| ApiError::Other(format!("json: {error}")))?;
        self.send_status(method, path, Some(&value), timeout).await
    }
}

/// Wait for a file to appear using inotify (event-driven, no polling).
async fn wait_for_socket_file(
    socket_path: &Path,
    #[cfg(test)] socket_wait_started: Option<&tokio::sync::Notify>,
) -> Result<(), ApiError> {
    let dir = socket_path
        .parent()
        .ok_or_else(|| ApiError::Other("socket path has no parent directory".into()))?;

    let inotify = Inotify::init(InitFlags::IN_NONBLOCK)
        .map_err(|e| ApiError::Other(format!("inotify init: {e}")))?;

    inotify
        .add_watch(dir, AddWatchFlags::IN_CREATE | AddWatchFlags::IN_MOVED_TO)
        .map_err(|e| ApiError::Other(format!("inotify watch: {e}")))?;

    // Re-check after watch is set (race: file may have appeared between the
    // caller's try_exists and our add_watch — same pattern as TS client).
    if tokio::fs::try_exists(socket_path).await.unwrap_or(false) {
        return Ok(());
    }

    // Inotify implements AsFd but not AsRawFd; convert to OwnedFd for AsyncFd.
    let fd: OwnedFd = inotify.into();
    let async_fd = AsyncFd::new(fd).map_err(|e| ApiError::Other(format!("AsyncFd: {e}")))?;

    // Keep this milestone after the post-watch absence check so deferred-socket
    // tests cannot pass through either existing-file fast path.
    #[cfg(test)]
    if let Some(started) = socket_wait_started {
        started.notify_one();
    }

    loop {
        let mut guard = async_fd
            .readable()
            .await
            .map_err(|e| ApiError::Other(format!("inotify readable: {e}")))?;

        // Drain inotify events to avoid a busy-loop on level-triggered epoll.
        drain_inotify_fd(async_fd.get_ref().as_fd());
        guard.clear_ready();

        // Check if our target file exists now (same as TS `checkAndResolve`).
        if tokio::fs::try_exists(socket_path).await.unwrap_or(false) {
            return Ok(());
        }
    }
}

/// Drain all pending bytes from a non-blocking inotify fd.
fn drain_inotify_fd(fd: std::os::fd::BorrowedFd<'_>) {
    let mut buf = [0u8; 4096];
    loop {
        // SAFETY: `fd` is a valid non-blocking inotify file descriptor borrowed
        // from AsyncFd. `buf` is a stack-allocated array with known length.
        // Non-blocking mode guarantees read returns immediately with EAGAIN when empty.
        let rc = unsafe { libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if rc <= 0 {
            break;
        }
    }
}
