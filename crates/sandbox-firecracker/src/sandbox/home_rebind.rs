//! Exclusive replacement of a blank VM's fixed Home filesystem.

use super::FirecrackerSandbox;
use crate::api::ApiClient;
use crate::park_coordinator::{DirtyReason, ParkCoordinator};
use guest_contracts::home_mount::HOME_DRIVE_MOUNT_REQUEST_DEADLINE;
use guest_control_client::NormalOperationFence;
use sandbox::{SandboxError, SandboxOperation, SandboxOperationReason};

struct ReplacementGuard {
    fence: NormalOperationFence,
    coordinator: ParkCoordinator,
    complete: bool,
}

impl Drop for ReplacementGuard {
    fn drop(&mut self) {
        if !self.complete {
            self.fence.invalidate();
            self.coordinator.mark_dirty(DirtyReason::new(
                "Home replacement did not complete; sandbox must be destroyed",
            ));
        }
    }
}

impl FirecrackerSandbox {
    pub(super) async fn replace_blank_home(
        &mut self,
        config: &sandbox::HomeDriveConfig,
    ) -> sandbox::Result<()> {
        let operation = SandboxOperation::MountHomeDrive;
        let failure = |message: String| SandboxError::Operation {
            operation,
            reason: SandboxOperationReason::Other,
            message,
        };
        let active_config = self
            .config
            .home_drive
            .as_ref()
            .ok_or_else(|| failure("sandbox has no Home drive".into()))?;
        if active_config.size_mb != config.size_mb || config.seed_image.is_none() {
            return Err(failure(
                "Home replacement requires a seed of the existing drive size".into(),
            ));
        }
        let guest = self.begin_guest_operation(operation).await?;
        let fence = guest.try_fence_normal_operations().map_err(|error| {
            failure(format!(
                "Home replacement requires an idle guest: {error:?}"
            ))
        })?;
        let mut guard = ReplacementGuard {
            fence,
            coordinator: self.park_coordinator.clone(),
            complete: false,
        };
        // Stage the selected seed without writing through the VMM's still-open
        // old backend. The ordinary cache handoff owns its source pins.
        let active = self.sandbox_paths.home_image();
        let staged = active.with_file_name("home-replacement.ext4");
        crate::home_drive_image::prepare_home_drive_image(&staged, config, None, None).await?;
        let detached = guest
            .home_drive_operation_with_fence(
                &guard.fence,
                guest_control_proto::HomeDriveOperation::Unmount,
                HOME_DRIVE_MOUNT_REQUEST_DEADLINE,
            )
            .await
            .map_err(|error| failure(format!("detach blank Home: {error}")))?;
        if detached.termination != (guest_control_proto::ExecTermination::Exited { exit_code: 0 }) {
            return Err(failure(format!(
                "detach blank Home failed: {:?}: {}",
                detached.termination,
                String::from_utf8_lossy(&detached.stderr)
            )));
        }
        // Synchronous rename has no cancellation boundary between the old
        // canonical path and the new active image. PATCH opens the new inode.
        std::fs::rename(&staged, &active)
            .map_err(|error| failure(format!("activate cached Home: {error}")))?;
        let path = active
            .to_str()
            .ok_or_else(|| failure("Home image path is not UTF-8".into()))?;
        ApiClient::new(&self.sock_paths.api_sock())
            .map_err(|error| failure(error.to_string()))?
            .patch_drive_path("home", path)
            .await
            .map_err(|error| failure(format!("replace Home backend: {error}")))?;
        let mounted = guest
            .home_drive_operation_with_fence(
                &guard.fence,
                guest_control_proto::HomeDriveOperation::Mount,
                HOME_DRIVE_MOUNT_REQUEST_DEADLINE,
            )
            .await
            .map_err(|error| failure(format!("mount cached Home: {error}")))?;
        if mounted.termination != (guest_control_proto::ExecTermination::Exited { exit_code: 0 }) {
            return Err(failure(format!(
                "mount cached Home failed: {:?}: {}",
                mounted.termination,
                String::from_utf8_lossy(&mounted.stderr)
            )));
        }
        guard.complete = true;
        Ok(())
    }
}
