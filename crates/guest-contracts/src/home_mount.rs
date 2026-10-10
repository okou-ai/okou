//! Fixed home-drive mount contract shared by Runner and guest ownership.

use std::time::Duration;

use crate::exec_terminal::EXEC_OUTPUT_DRAIN_DEADLINE;
use crate::file_write::GUEST_FRAME_WRITE_DEADLINE;

/// Paired Guest/Runner filesystem layout identity; no old image interpretation.
pub const HOME_DRIVE_LAYOUT: &str = "home-drive-v1";
/// Writable home device, distinct from the kernel's `/dev/vda` root drive.
pub const HOME_DEVICE: &str = "/dev/vdb";
/// Fixed writable home mount, independent of the execution cwd.
pub const HOME_DIR: &str = "/home/user";
/// Execution cwd remains workspace beneath the home drive.
pub const WORKSPACE_DIR: &str = "/home/user/workspace";
/// Fixed privileged helper included in the paired rootfs inventory.
pub const HOME_MOUNT_PATH: &str = "/sbin/guest-home-mount";

/// Maximum time the guest waits for the fixed home-mount helper process.
pub const HOME_DRIVE_MOUNT_TIMEOUT_MS: u32 = 30_000;

const HOME_DRIVE_MOUNT_HELPER_TIMEOUT: Duration = Duration::from_secs(30);
// A terminal frame can first wait behind another producer's bounded writer
// lock. Reserve one complete competing frame deadline plus scheduling and
// transport slack beyond this operation's own configured guest phases.
const HOME_DRIVE_MOUNT_TRANSPORT_HEADROOM: Duration = Duration::from_secs(15);

/// End-to-end host deadline for one home-drive mount request and result.
pub const HOME_DRIVE_MOUNT_REQUEST_DEADLINE: Duration = HOME_DRIVE_MOUNT_HELPER_TIMEOUT
    .saturating_add(EXEC_OUTPUT_DRAIN_DEADLINE)
    .saturating_add(GUEST_FRAME_WRITE_DEADLINE)
    .saturating_add(HOME_DRIVE_MOUNT_TRANSPORT_HEADROOM);

const _: () = assert!(
    HOME_DRIVE_MOUNT_HELPER_TIMEOUT.as_millis() == HOME_DRIVE_MOUNT_TIMEOUT_MS as u128,
    "home-mount helper duration and millisecond arguments must stay aligned"
);

const _: () = assert!(
    HOME_DRIVE_MOUNT_REQUEST_DEADLINE.as_secs() == 60,
    "home-mount request deadline changed; review the complete guest lifecycle budget"
);
