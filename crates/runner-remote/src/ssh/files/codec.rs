//! Bounded SFTP v3 fields; peer messages and opaque handles are never formatted.

use super::sftp::Error;

pub(super) struct Fields<'a>(&'a [u8]);

impl<'a> Fields<'a> {
    pub(super) fn new(bytes: &'a [u8]) -> Self {
        Self(bytes)
    }
    pub(super) fn take(&mut self, size: usize) -> Result<&'a [u8], Error> {
        let (value, rest) = self.0.split_at_checked(size).ok_or(Error::Protocol)?;
        self.0 = rest;
        Ok(value)
    }
    pub(super) fn byte(&mut self) -> Result<u8, Error> {
        self.take(1)?.first().copied().ok_or(Error::Protocol)
    }
    pub(super) fn u32(&mut self) -> Result<u32, Error> {
        Ok(u32::from_be_bytes(
            self.take(4)?.try_into().map_err(|_| Error::Protocol)?,
        ))
    }
    pub(super) fn u64(&mut self) -> Result<u64, Error> {
        Ok(u64::from_be_bytes(
            self.take(8)?.try_into().map_err(|_| Error::Protocol)?,
        ))
    }
    pub(super) fn string(&mut self, limit: usize) -> Result<&'a [u8], Error> {
        let size = self.u32()? as usize;
        if size > limit {
            return Err(Error::Protocol);
        }
        self.take(size)
    }
    pub(super) fn empty(&self) -> bool {
        self.0.is_empty()
    }
    pub(super) fn finish(self) -> Result<(), Error> {
        if self.empty() {
            Ok(())
        } else {
            Err(Error::Protocol)
        }
    }
    pub(super) fn attrs(&mut self) -> Result<Attrs, Error> {
        let flags = self.u32()?;
        if flags & !0x8000000f != 0 {
            return Err(Error::Protocol);
        }
        let size = if flags & 1 != 0 {
            Some(self.u64()?)
        } else {
            None
        };
        if flags & 2 != 0 {
            self.take(8)?;
        }
        let mode = if flags & 4 != 0 {
            Some(self.u32()?)
        } else {
            None
        };
        let mtime = if flags & 8 != 0 {
            self.u32()?;
            Some(self.u32()?)
        } else {
            None
        };
        if flags & 0x80000000 != 0 {
            let count = self.u32()?;
            if count > 16 {
                return Err(Error::Protocol);
            }
            for _ in 0..count {
                self.string(4096)?;
                self.string(4096)?;
            }
        }
        Ok(Attrs { size, mode, mtime })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Attrs {
    pub(super) size: Option<u64>,
    pub(super) mode: Option<u32>,
    pub(super) mtime: Option<u32>,
}

impl Attrs {
    pub(super) fn regular(&self) -> bool {
        self.mode.is_some_and(|m| m & 0o170000 == 0o100000)
    }
    pub(super) fn directory(&self) -> bool {
        self.mode.is_some_and(|m| m & 0o170000 == 0o040000)
    }
}

pub(super) fn string(out: &mut Vec<u8>, value: &[u8]) -> Result<(), Error> {
    let size = u32::try_from(value.len()).map_err(|_| Error::Protocol)?;
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(value);
    Ok(())
}
