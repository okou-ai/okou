use crate::{CredentialError, Principal, Result, put_len32};

pub(crate) struct Cursor<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    pub(crate) fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    pub(crate) fn done(&self) -> bool {
        self.position == self.data.len()
    }

    pub(crate) fn remaining(&self) -> usize {
        // take() commits position only after an in-range slice succeeds.
        self.data.len() - self.position
    }

    pub(crate) fn take(&mut self, size: usize) -> Result<&'a [u8]> {
        let end = self
            .position
            .checked_add(size)
            .ok_or(CredentialError::Invalid)?;
        let value = self
            .data
            .get(self.position..end)
            .ok_or(CredentialError::Invalid)?;
        self.position = end;
        Ok(value)
    }

    pub(crate) fn u8(&mut self) -> Result<u8> {
        self.take(1)?
            .first()
            .copied()
            .ok_or(CredentialError::Invalid)
    }

    pub(crate) fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_be_bytes(
            self.take(2)?
                .try_into()
                .map_err(|_| CredentialError::Invalid)?,
        ))
    }

    pub(crate) fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| CredentialError::Invalid)?,
        ))
    }

    pub(crate) fn i32(&mut self) -> Result<i32> {
        Ok(i32::from_be_bytes(
            self.take(4)?
                .try_into()
                .map_err(|_| CredentialError::Invalid)?,
        ))
    }

    pub(crate) fn data32(&mut self, cap: usize) -> Result<&'a [u8]> {
        let size = usize::try_from(self.u32()?).map_err(|_| CredentialError::Invalid)?;
        if size > cap {
            return Err(CredentialError::Invalid);
        }
        self.take(size)
    }

    fn text(&mut self, short: bool) -> Result<String> {
        let data = if short {
            let size = usize::from(self.u16()?);
            if size > 255 {
                return Err(CredentialError::Invalid);
            }
            self.take(size)?
        } else {
            self.data32(255)?
        };
        std::str::from_utf8(data)
            .map(str::to_owned)
            .map_err(|_| CredentialError::Invalid)
    }

    pub(crate) fn principal(&mut self, keytab: bool) -> Result<Principal> {
        if !keytab {
            self.name_type()?;
        }
        let count = if keytab {
            usize::from(self.u16()?)
        } else {
            usize::try_from(self.u32()?).map_err(|_| CredentialError::Invalid)?
        };
        if count == 0 || count > 8 {
            return Err(CredentialError::Invalid);
        }
        let realm = self.text(keytab)?;
        let mut components = Vec::with_capacity(count);
        for _ in 0..count {
            components.push(self.text(keytab)?);
        }
        if keytab {
            self.name_type()?;
        }
        Principal::new(realm, components)
    }

    fn name_type(&mut self) -> Result<()> {
        if self.u32()? > 3 {
            return Err(CredentialError::Unsupported);
        }
        Ok(())
    }
}

pub(crate) fn put_cache_principal(out: &mut Vec<u8>, name: &Principal, kind: u32) -> Result<()> {
    out.extend_from_slice(&kind.to_be_bytes());
    out.extend_from_slice(
        &u32::try_from(name.components().len())
            .map_err(|_| CredentialError::Invalid)?
            .to_be_bytes(),
    );
    put_len32(out, name.realm().as_bytes())?;
    for part in name.components() {
        put_len32(out, part.as_bytes())?;
    }
    Ok(())
}
