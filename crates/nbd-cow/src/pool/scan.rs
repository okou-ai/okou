use std::collections::HashSet;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use crate::device_lock::{self, NbdDeviceClaim};
use crate::error::{NbdCowError, Result};
use crate::netlink;

use super::DeviceFreeCheck;

/// One process-local demand scan shared by concurrent blocking workers.
///
/// The shared cursor issues every logical offset at most once. Host-global
/// ownership still comes from the per-index lock and post-lock sysfs recheck.
#[derive(Clone)]
pub(super) struct ScanRequest {
    shared: Arc<SharedScan>,
}

struct SharedScan {
    max_devices: u32,
    start: u32,
    next_offset: AtomicU32,
    exclude: HashSet<u32>,
    lock_dir: PathBuf,
    device_appears_free: DeviceFreeCheck,
}

pub(super) struct ScannedDeviceClaim {
    claim: NbdDeviceClaim,
    duration: Duration,
}

impl ScannedDeviceClaim {
    pub(super) fn new(claim: NbdDeviceClaim, duration: Duration) -> Self {
        Self { claim, duration }
    }

    pub(super) fn into_parts(self) -> (NbdDeviceClaim, Duration) {
        (self.claim, self.duration)
    }
}

impl ScanRequest {
    pub(super) fn new(
        max_devices: u32,
        exclude: HashSet<u32>,
        lock_dir: PathBuf,
        device_appears_free: DeviceFreeCheck,
    ) -> Self {
        Self {
            shared: Arc::new(SharedScan {
                max_devices,
                start: netlink::random_offset(max_devices),
                next_offset: AtomicU32::new(0),
                exclude,
                lock_dir,
                device_appears_free,
            }),
        }
    }

    pub(super) fn run(self) -> Result<ScannedDeviceClaim> {
        let started_at = Instant::now();
        let claim = self.scan_and_claim()?;
        Ok(ScannedDeviceClaim::new(claim, started_at.elapsed()))
    }

    fn scan_and_claim(&self) -> Result<NbdDeviceClaim> {
        while let Some(index) = self.next_index() {
            if self.shared.exclude.contains(&index) {
                continue;
            }
            if !(self.shared.device_appears_free)(index) {
                continue;
            }
            match device_lock::try_acquire_device_claim_in(index, &self.shared.lock_dir) {
                Ok(Some(claim)) => {
                    if (self.shared.device_appears_free)(index) {
                        return Ok(claim);
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!(
                        device_index = index,
                        error = %e,
                        "cannot acquire NBD device lock, skipping index"
                    );
                }
            }
        }

        Err(NbdCowError::NoFreeDevice)
    }

    fn next_index(&self) -> Option<u32> {
        let offset = self
            .shared
            .next_offset
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |offset| {
                (offset < self.shared.max_devices).then(|| offset + 1)
            })
            .ok()?;
        let index =
            (u64::from(self.shared.start) + u64::from(offset)) % u64::from(self.shared.max_devices);
        Some(index as u32)
    }
}

/// Scan sysfs for a single free device and acquire its per-index lock.
///
/// Starts from a random offset to distribute usage across runners. The first
/// sysfs check is a cheap precheck; the post-lock sysfs check is the correctness
/// gate that prevents stale observations from becoming leases.
#[cfg(test)]
pub(super) fn scan_and_claim_with(
    max_devices: u32,
    exclude: &HashSet<u32>,
    lock_dir: &Path,
    device_appears_free: DeviceFreeCheck,
) -> Result<NbdDeviceClaim> {
    let request = ScanRequest::new(
        max_devices,
        exclude.clone(),
        lock_dir.to_path_buf(),
        device_appears_free,
    );
    request.scan_and_claim()
}
