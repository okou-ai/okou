use std::io::{self, Write};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd};
use std::ptr::NonNull;

use rustix::fs::{SealFlags, fcntl_get_seals};

use super::{MAX_BATCH_PAYLOAD_BYTES, write_batch};

struct Mapping {
    address: NonNull<u8>,
    length: usize,
}

impl Drop for Mapping {
    fn drop(&mut self) {
        // SAFETY: This guard owns the live mapping.
        unsafe { libc::munmap(self.address.as_ptr().cast(), self.length) };
    }
}

fn write_sealed_batch(input: BorrowedFd<'_>) -> io::Result<()> {
    let required = SealFlags::WRITE | SealFlags::SHRINK | SealFlags::GROW;
    if !fcntl_get_seals(input).is_ok_and(|seals| seals.contains(required)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected immutable batch input",
        ));
    }
    let length = usize::try_from(nix::sys::stat::fstat(input)?.st_size)
        .ok()
        .filter(|length| (1..=MAX_BATCH_PAYLOAD_BYTES).contains(length))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid batch input size"))?;

    // SAFETY: The complete read-only mapping lies inside the immutable file.
    let raw = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            length,
            libc::PROT_READ,
            libc::MAP_PRIVATE,
            input.as_raw_fd(),
            0,
        )
    };
    if raw == libc::MAP_FAILED {
        return Err(io::Error::last_os_error());
    }
    let Some(address) = NonNull::new(raw.cast::<u8>()) else {
        // SAFETY: mmap succeeded and returned this address and length.
        unsafe { libc::munmap(raw, length) };
        return Err(io::Error::other("batch mapping has a null address"));
    };
    let mapping = Mapping { address, length };
    // SAFETY: The guard keeps the mapping alive through write_batch. The seals
    // prevent mutation or truncation and length fits within isize.
    let bytes = unsafe { std::slice::from_raw_parts(mapping.address.as_ptr(), mapping.length) };
    write_batch(bytes, false)
}

/// Write an ordinary batch from an immutable stdin descriptor supplied by guest control.
/// Returns the process exit code.
pub fn run_sealed_batch(mut stderr: impl Write) -> i32 {
    match write_sealed_batch(io::stdin().as_fd()) {
        Ok(()) => 0,
        Err(error) => {
            let _ = writeln!(stderr, "guest-write-file: {error}");
            1
        }
    }
}

#[cfg(test)]
mod tests;
