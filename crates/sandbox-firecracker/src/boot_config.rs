use std::num::NonZeroU64;

use crate::config::{FirecrackerDeviceRateLimits, RateLimiterConfig};
use crate::factory::InvariantConfig;

pub(crate) const ROOTFS_DRIVE_ID: &str = "rootfs";
pub(crate) const HOME_DRIVE_ID: &str = "home";

pub(crate) fn nonzero_drive_count(count: usize) -> Result<NonZeroU64, String> {
    let count = u64::try_from(count)
        .map_err(|_| "block drive count exceeds the Firecracker limit".to_string())?;
    NonZeroU64::new(count).ok_or_else(|| "block drive count must be non-zero".to_string())
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct MachineConfig {
    pub(crate) vcpu_count: u32,
    pub(crate) mem_size_mib: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct BootSourceConfig {
    pub(crate) kernel_image_path: String,
    pub(crate) boot_args: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct DriveConfig {
    pub(crate) drive_id: String,
    pub(crate) path_on_host: String,
    pub(crate) is_root_device: bool,
    pub(crate) is_read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rate_limiter: Option<RateLimiterConfig>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct NetworkInterfaceConfig {
    pub(crate) iface_id: String,
    pub(crate) guest_mac: String,
    pub(crate) host_dev_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rx_rate_limiter: Option<RateLimiterConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tx_rate_limiter: Option<RateLimiterConfig>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct VsockConfig {
    pub(crate) guest_cid: u32,
    pub(crate) uds_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct BalloonConfig {
    pub(crate) amount_mib: u32,
    pub(crate) deflate_on_oom: bool,
    pub(crate) free_page_reporting: bool,
    pub(crate) stats_polling_interval_s: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct FirecrackerBootConfig {
    #[serde(rename = "boot-source")]
    pub(crate) boot_source: BootSourceConfig,
    pub(crate) drives: Vec<DriveConfig>,
    #[serde(rename = "machine-config")]
    pub(crate) machine_config: MachineConfig,
    #[serde(rename = "network-interfaces")]
    pub(crate) network_interfaces: [NetworkInterfaceConfig; 1],
    pub(crate) vsock: VsockConfig,
    pub(crate) balloon: BalloonConfig,
}

pub(crate) struct BootConfigInput<'a> {
    pub(crate) invariant: &'a InvariantConfig,
    pub(crate) vcpu_count: u32,
    pub(crate) memory_mb: u32,
    pub(crate) kernel_path: String,
    pub(crate) rootfs_path: String,
    pub(crate) home_path: Option<String>,
    pub(crate) vsock_path: String,
}

impl FirecrackerBootConfig {
    pub(crate) fn new(input: BootConfigInput<'_>) -> Self {
        let BootConfigInput {
            invariant,
            vcpu_count,
            memory_mb,
            kernel_path,
            rootfs_path,
            home_path,
            vsock_path,
        } = input;
        let mut drives = vec![DriveConfig {
            drive_id: ROOTFS_DRIVE_ID.to_owned(),
            path_on_host: rootfs_path,
            is_root_device: true,
            is_read_only: false,
            rate_limiter: None,
        }];
        if let Some(home_path) = home_path {
            drives.push(DriveConfig {
                drive_id: HOME_DRIVE_ID.to_owned(),
                path_on_host: home_path,
                is_root_device: false,
                is_read_only: false,
                rate_limiter: None,
            });
        }

        Self {
            boot_source: BootSourceConfig {
                kernel_image_path: kernel_path,
                boot_args: invariant.boot_args.clone(),
            },
            drives,
            machine_config: MachineConfig {
                vcpu_count,
                mem_size_mib: memory_mb,
            },
            network_interfaces: [NetworkInterfaceConfig {
                iface_id: invariant.iface_id.to_owned(),
                guest_mac: invariant.guest_mac.to_owned(),
                host_dev_name: invariant.tap_name.to_owned(),
                rx_rate_limiter: None,
                tx_rate_limiter: None,
            }],
            vsock: VsockConfig {
                guest_cid: invariant.guest_cid,
                uds_path: vsock_path,
            },
            balloon: invariant.balloon.clone(),
        }
    }

    pub(crate) fn with_device_rate_limits(
        mut self,
        rate_limits: &FirecrackerDeviceRateLimits,
    ) -> Result<Self, String> {
        let drive_count = nonzero_drive_count(self.drives.len())?;
        let drive_rate_limiter = rate_limits.block_drive_limiter(drive_count)?;
        for drive in &mut self.drives {
            drive.rate_limiter = Some(drive_rate_limiter.clone());
        }
        let [network_interface] = &mut self.network_interfaces;
        network_interface.rx_rate_limiter = Some(rate_limits.net_rx.clone());
        network_interface.tx_rate_limiter = Some(rate_limits.net_tx.clone());
        Ok(self)
    }
}
