//! Read-only, immutable input shared with Guest helpers.

use std::io;
use std::os::fd::{AsRawFd, BorrowedFd};
use std::ptr::NonNull;

use nix::fcntl::{FcntlArg, SealFlag, fcntl};
use nix::sys::stat::fstat;

/// A mapping of immutable helper input.
pub struct SealedInput {
    address: NonNull<u8>,
    length: usize,
}

impl SealedInput {
    /// Map input only after the kernel guarantees its contents and length.
    pub fn map(input: BorrowedFd<'_>, max_bytes: usize) -> io::Result<Self> {
        let required = SealFlag::F_SEAL_WRITE | SealFlag::F_SEAL_SHRINK | SealFlag::F_SEAL_GROW;
        if !fcntl(input, FcntlArg::F_GET_SEALS)
            .is_ok_and(|seals| SealFlag::from_bits_retain(seals).contains(required))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "expected immutable batch input",
            ));
        }
        let length = usize::try_from(fstat(input)?.st_size)
            .ok()
            .filter(|length| (1..=max_bytes.min(isize::MAX as usize)).contains(length))
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "invalid batch input size")
            })?;

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
        Ok(Self { address, length })
    }

    /// The payload bytes, valid for the lifetime of the immutable mapping.
    pub fn as_bytes(&self) -> &[u8] {
        // SAFETY: This owner retains the mapping. The seals prevent mutation
        // or truncation, and the constructor bounds length to isize::MAX.
        unsafe { std::slice::from_raw_parts(self.address.as_ptr(), self.length) }
    }
}

impl Drop for SealedInput {
    fn drop(&mut self) {
        // SAFETY: This guard owns the live mapping.
        unsafe { libc::munmap(self.address.as_ptr().cast(), self.length) };
    }
}
