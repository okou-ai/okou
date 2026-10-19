//! Optional host-cache reclamation; this never grants an allocation reservation.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::time::Duration;

/// Default foreground observation allowance. The caller creates one absolute
/// deadline for both provider and cache; accepted IO and the final space reread
/// are not bounded by this allowance.
pub const HOME_DRIVE_RECLAIM_OBSERVATION: Duration = Duration::from_millis(250);

/// Bounded observation of accepted reclamation. Dropping the observer must not
/// cancel physical work or release the work's locks before its IO completes.
pub type HomeDrivePressureFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

/// Factory-wide policy supplied by the host that owns disposable cache data.
pub trait HomeDrivePressurePolicy: Send + Sync {
    /// Offer reclamation only on `destination_device`. The caller supplies its
    /// reserve plus additional peak and must reread actual space afterward.
    /// Observe only until the caller's `deadline`, without restarting its budget.
    /// Expiry or cancellation must leave accepted physical work owned.
    fn reclaim(
        &self,
        destination_device: u64,
        required_available_bytes: u64,
        deadline: tokio::time::Instant,
    ) -> HomeDrivePressureFuture<'_>;
}

fn full_copy_peak(logical_bytes: u64, allocation_unit: u64) -> u64 {
    let unit = allocation_unit.max(1);
    logical_bytes.div_ceil(unit).saturating_mul(unit)
}

/// Bound copied data and extent metadata rather than source physical blocks.
/// The caller owns source stability and runs this filesystem work off-runtime.
/// Unsupported, changing or excessively fragmented observations use the full
/// logical bound; no source bytes are read to discover sparse regions.
pub fn home_drive_copy_peak_bytes(source: &Path, logical_bytes: u64, allocation_unit: u64) -> u64 {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        if let Ok(file) = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(source)
        {
            return home_drive_copy_peak_bytes_from_file(&file, logical_bytes, allocation_unit);
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = source;
    full_copy_peak(logical_bytes, allocation_unit)
}

/// Observe the actual held source image, preserving its file position.
/// The caller retains immutable-image authority; path replacement cannot select
/// a different image for this observation.
pub fn home_drive_copy_peak_bytes_from_file(
    file: &std::fs::File,
    logical_bytes: u64,
    allocation_unit: u64,
) -> u64 {
    let full = full_copy_peak(logical_bytes, allocation_unit);
    if allocation_unit == 0 {
        return full;
    }
    let unit = allocation_unit;
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        if !file
            .metadata()
            .is_ok_and(|m| m.is_file() && m.len() == logical_bytes)
        {
            return full;
        }
        // SAFETY: file owns this descriptor; lseek writes no memory.
        let initial_position = unsafe { libc::lseek(file.as_raw_fd(), 0, libc::SEEK_CUR) };
        if initial_position < 0 {
            return full;
        }
        struct RestorePosition<'a> {
            file: &'a std::fs::File,
            position: libc::off_t,
        }
        impl Drop for RestorePosition<'_> {
            fn drop(&mut self) {
                // SAFETY: the borrowed file remains open through this guard.
                unsafe {
                    libc::lseek(self.file.as_raw_fd(), self.position, libc::SEEK_SET);
                }
            }
        }
        let _restore = RestorePosition {
            file,
            position: initial_position,
        };
        let mut position = 0_u64;
        let mut bytes = 0_u64;
        for _ in 0..4096 {
            if position >= logical_bytes {
                return bytes.min(full);
            }
            let Ok(offset) = libc::off_t::try_from(position) else {
                return full;
            };
            // SAFETY: the owned descriptor and representable nonnegative offset.
            let data = unsafe { libc::lseek(file.as_raw_fd(), offset, libc::SEEK_DATA) };
            if data < 0 {
                return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENXIO) {
                    bytes.min(full)
                } else {
                    full
                };
            }
            // SAFETY: the same live descriptor and a nonnegative seek offset.
            let hole = unsafe { libc::lseek(file.as_raw_fd(), data, libc::SEEK_HOLE) };
            if hole <= data || hole as u64 > logical_bytes || (data as u64) < position {
                return full;
            }
            // A sparse destination also allocates extent-index blocks. Charge
            // one allocation unit per observed extent instead of assuming the
            // caller's fixed inode/directory allowance covers fragmentation.
            // The full logical estimate remains the conservative upper choice.
            bytes = bytes
                .saturating_add(
                    full_copy_peak(hole as u64, unit).saturating_sub(data as u64 / unit * unit),
                )
                .saturating_add(unit);
            position = hole as u64;
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = file;
    full
}
