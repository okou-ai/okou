use std::sync::Arc;

use async_trait::async_trait;
use tracing::{info, warn};

use sandbox::{
    FactoryConfig, RuntimeProvider, SandboxError, SandboxFactory, SandboxInitializationPhase,
    SandboxRuntime, SnapshotRef,
};

use nbd_cow::pool::{DevicePoolConfig, DevicePoolHandle};

use crate::config::{FirecrackerConfig, SnapshotConfig};
use crate::duration::duration_ms;
use crate::factory::FirecrackerFactory;
use crate::host_cpu_cgroup::HostCpuCgroupManager;
use crate::network::{NetnsPoolConfig, NetnsPoolHandle};
use crate::paths::{RuntimePaths, SandboxPaths, SnapshotOutputPaths, SockPaths};
use crate::runtime_dirs::checked_runtime_sock_dir;

/// Firecracker-backed sandbox runtime.
///
/// Manages shared network namespace and device pools, then creates
/// sandbox factories that share those resources.
pub struct FirecrackerRuntime {
    netns_pool: NetnsPoolHandle,
    device_pool: DevicePoolHandle,
    proxy_port: Option<u16>,
    dns_port: Option<u16>,
    host_cpu_cgroup: Option<Arc<HostCpuCgroupManager>>,
}

impl FirecrackerRuntime {
    #[cfg(feature = "test-support")]
    /// Create an actual factory with an invocation-owned accepted-home checkpoint.
    pub async fn create_factory_with_home_checkpoint_for_test(
        &self,
        config: FactoryConfig,
        checkpoint: crate::HomeCreateCheckpoint,
    ) -> sandbox::Result<Box<dyn SandboxFactory>> {
        Ok(crate::factory::checkpoint_factory(
            self.start_factory(config).await?,
            checkpoint,
        ))
    }

    #[cfg(feature = "test-support")]
    /// Create an actual factory with an invocation-owned after-success Guest checkpoint.
    pub async fn create_factory_with_guest_checkpoint_for_test(
        &self,
        config: FactoryConfig,
        checkpoint: crate::GuestPreparationCheckpoint,
    ) -> sandbox::Result<Box<dyn SandboxFactory>> {
        Ok(crate::factory::guest_checkpoint_factory(
            self.start_factory(config).await?,
            checkpoint,
        ))
    }

    async fn start_factory(&self, config: FactoryConfig) -> sandbox::Result<FirecrackerFactory> {
        let pressure = config.home_drive_pressure.clone();
        let fc_config = self.to_firecracker_config(config)?;
        FirecrackerFactory::start(
            fc_config,
            Some(self.netns_pool.clone()),
            self.device_pool.clone(),
            self.host_cpu_cgroup.clone(),
            pressure,
        )
        .await
    }
    /// Create a new runtime with shared resources.
    ///
    /// This allocates network namespace and NBD device pools.
    /// All factories created via [`SandboxRuntime::create_factory`] share these
    /// resources.
    pub async fn new(config: sandbox::RuntimeConfig) -> Result<Self, SandboxError> {
        let host_cpu_cgroup = match config.host_cpu_placement {
            Some(placement) => HostCpuCgroupManager::initialize(placement)?,
            None => None,
        };
        let t = std::time::Instant::now();
        let netns_config = NetnsPoolConfig {
            proxy_port: config.proxy_port,
            dns_port: config.dns_port,
        }
        .into_checked()
        .await?;
        let netns_pool = match NetnsPoolHandle::create_checked(netns_config).await {
            Ok(pool) => pool,
            Err(e) => {
                return Err(SandboxError::Initialization {
                    phase: SandboxInitializationPhase::Runtime,
                    message: format!("netns pool: {e}"),
                });
            }
        };
        info!(
            elapsed_ms = duration_ms(t.elapsed()),
            "runtime netns pool created"
        );

        let t = std::time::Instant::now();
        let device_pool = DevicePoolHandle::new(DevicePoolConfig::default());
        info!(
            elapsed_ms = duration_ms(t.elapsed()),
            "runtime device pool created"
        );

        Ok(Self {
            netns_pool,
            device_pool,
            proxy_port: config.proxy_port,
            dns_port: config.dns_port,
            host_cpu_cgroup,
        })
    }

    fn to_firecracker_config(&self, config: FactoryConfig) -> sandbox::Result<FirecrackerConfig> {
        let snapshot = match config.snapshot.as_ref() {
            Some(snapshot_ref) => Some(Self::resolve_snapshot(snapshot_ref)?),
            None => None,
        };
        Ok(FirecrackerConfig {
            binary_path: config.binary_path,
            kernel_path: config.kernel_path,
            rootfs_path: config.rootfs_path,
            base_dir: config.base_dir,
            profile: config.profile,
            proxy_port: self.proxy_port,
            dns_port: self.dns_port,
            snapshot,
        })
    }

    fn resolve_snapshot(snapshot_ref: &SnapshotRef) -> sandbox::Result<SnapshotConfig> {
        let output = SnapshotOutputPaths::new(snapshot_ref.output_dir.clone());
        let work = SandboxPaths::new(output.work_dir());
        let runtime = RuntimePaths::new();
        let sock_dir = checked_runtime_sock_dir(&runtime, &snapshot_ref.hash).map_err(|e| {
            SandboxError::Configuration {
                message: format!("snapshot socket id: {e}"),
            }
        })?;
        let sock = SockPaths::new(sock_dir);
        Ok(SnapshotConfig {
            snapshot_path: output.snapshot(),
            memory_path: output.memory(),
            cow_path: output.cow(),
            drive_bind_path: work.cow_device_bind(),
            home_drive_bind_path: work.home_device_bind(),
            vsock_bind_dir: sock.vsock_dir(),
        })
    }
}

#[async_trait]
impl SandboxRuntime for FirecrackerRuntime {
    async fn create_factory(
        &self,
        config: FactoryConfig,
    ) -> sandbox::Result<Box<dyn SandboxFactory>> {
        let factory = self.start_factory(config).await?;
        Ok(Box::new(factory))
    }

    async fn dns_interface_pattern(&self) -> Option<String> {
        if self.dns_port.is_some() {
            Some(self.netns_pool.host_device_pattern().await)
        } else {
            None
        }
    }

    async fn activate_dns_readiness(&self) -> sandbox::Result<()> {
        if self.dns_port.is_none() {
            return Ok(());
        }
        self.netns_pool
            .activate_dns_readiness()
            .await
            .map_err(|e| SandboxError::Initialization {
                phase: SandboxInitializationPhase::Runtime,
                message: format!("netns DNS readiness: {e}"),
            })
    }

    async fn shutdown(&mut self) {
        // Clean up shared netns pool.
        if let Err(e) = self.netns_pool.cleanup().await {
            warn!(error = %e, "failed to cleanup shared netns pool");
        }

        // Clean up shared device pool.
        self.device_pool.cleanup().await;

        info!("runtime shutdown complete");
    }
}

/// Factory for creating [`FirecrackerRuntime`] instances.
pub struct FirecrackerRuntimeProvider;

#[async_trait]
impl RuntimeProvider for FirecrackerRuntimeProvider {
    async fn create_runtime(
        &self,
        config: sandbox::RuntimeConfig,
    ) -> sandbox::Result<Box<dyn SandboxRuntime>> {
        Ok(Box::new(FirecrackerRuntime::new(config).await?))
    }
}

#[cfg(test)]
mod tests;
