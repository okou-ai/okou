use std::ffi::CStr;
use std::fs::File;
use std::io;

use rustix::fs::{MemfdFlags, SealFlags, fcntl_add_seals, memfd_create};

pub(crate) fn create(name: &CStr) -> io::Result<File> {
    let flags = MemfdFlags::CLOEXEC | MemfdFlags::ALLOW_SEALING | MemfdFlags::NOEXEC_SEAL;
    Ok(File::from(memfd_create(name, flags)?))
}

pub(crate) fn seal(file: &File) -> io::Result<()> {
    let seals = SealFlags::WRITE | SealFlags::SHRINK | SealFlags::GROW | SealFlags::SEAL;
    Ok(fcntl_add_seals(file, seals)?)
}
