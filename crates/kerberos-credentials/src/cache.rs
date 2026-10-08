use std::fmt;

use zeroize::Zeroizing;

use crate::{
    CredentialError, MAX_INPUT_BYTES, MAX_RECORDS, MAX_TICKET_BYTES, Principal, Result,
    check_aes_key,
    cursor::{Cursor, put_cache_principal},
    put_len32,
};

/// A canonical FILEccache4 containing exactly one explicitly selected service.
///
/// Owns secret bytes without Clone or byte-exposing Debug. Declared lifetime is
/// untrusted upload metadata, not the server's cryptographically verified expiry.
pub struct ServiceTicketCache {
    bytes: Zeroizing<Vec<u8>>,
    expires_at: u32,
}

impl ServiceTicketCache {
    /// Consume and zeroize a bounded upload, checking identity and declared time.
    ///
    /// No I/O, native calls, clock lookup, renewal, or credential fallback occurs.
    /// The initial selected service must be addressless/no credential authdata,
    /// same-realm `vnc/hostname`, with one AES17/18 session key and no user-user
    /// or secondary ticket. Discarded records are still fully parsed and bounded.
    pub fn parse(
        input: Vec<u8>,
        initiator: &Principal,
        server: &Principal,
        now: u32,
    ) -> Result<Self> {
        let input = Zeroizing::new(input);
        if input.len() > MAX_INPUT_BYTES {
            return Err(CredentialError::Invalid);
        }
        if !server.is_vnc_service_for(initiator) {
            return Err(CredentialError::IdentityMismatch);
        }
        let mut reader = Cursor::new(&input);
        if reader.take(2)? != [5, 4] {
            return Err(CredentialError::Unsupported);
        }
        read_header(&mut reader)?;
        if reader.principal(false)? != *initiator {
            return Err(CredentialError::IdentityMismatch);
        }
        let mut selected = None;
        let mut records = 0;
        while !reader.done() {
            records += 1;
            if records > MAX_RECORDS {
                return Err(CredentialError::Invalid);
            }
            let entry = Entry::read(&mut reader)?;
            if entry.client != *initiator {
                return Err(CredentialError::IdentityMismatch);
            }
            if entry.server == *server {
                if selected.is_some() {
                    return Err(CredentialError::IdentityMismatch);
                }
                entry.validate(now)?;
                selected = Some(entry);
            }
        }
        let entry = selected.ok_or(CredentialError::IdentityMismatch)?;
        let bytes = entry.encode(initiator, server)?;
        Ok(Self {
            bytes,
            expires_at: entry.times.end,
        })
    }

    /// Borrow canonical secret bytes for private native/KMS consumption only.
    pub fn canonical_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Uploader-declared expiry, not a cryptographic ticket-lifetime attestation.
    pub fn declared_expires_at(&self) -> u32 {
        self.expires_at
    }
}

impl fmt::Debug for ServiceTicketCache {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ServiceTicketCache([REDACTED])")
    }
}

fn read_header(reader: &mut Cursor<'_>) -> Result<()> {
    let size = usize::from(reader.u16()?);
    if size > 1024 {
        return Err(CredentialError::Invalid);
    }
    let mut header = Cursor::new(reader.take(size)?);
    let mut fields = 0;
    while !header.done() {
        fields += 1;
        if fields > 16 {
            return Err(CredentialError::Invalid);
        }
        let tag = header.u16()?;
        let size = usize::from(header.u16()?);
        if tag == 1 && size != 8 {
            return Err(CredentialError::Invalid);
        }
        header.take(size)?;
    }
    Ok(())
}

struct Times {
    auth: u32,
    start: u32,
    end: u32,
    renew: u32,
}

impl Times {
    fn validate(&self, now: u32) -> Result<()> {
        let start = if self.start == 0 {
            self.auth
        } else {
            self.start
        };
        if self.auth == 0
            || self.auth > start
            || start >= self.end
            || [self.auth, self.start, self.end, self.renew]
                .into_iter()
                .any(|v| v > i32::MAX as u32)
            || (self.renew != 0 && self.renew < self.end)
        {
            return Err(CredentialError::Invalid);
        }
        if now < start || now >= self.end {
            return Err(CredentialError::OutsideLifetime);
        }
        Ok(())
    }
}

struct Entry<'a> {
    client: Principal,
    server: Principal,
    enctype: u16,
    key: &'a [u8],
    times: Times,
    is_skey: u8,
    flags: u32,
    addresses: u32,
    authdata: u32,
    ticket: &'a [u8],
    second: &'a [u8],
}

impl<'a> Entry<'a> {
    fn read(reader: &mut Cursor<'a>) -> Result<Self> {
        let client = reader.principal(false)?;
        let server = reader.principal(false)?;
        let enctype = reader.u16()?;
        let key = reader.data32(MAX_INPUT_BYTES)?;
        let times = Times {
            auth: reader.u32()?,
            start: reader.u32()?,
            end: reader.u32()?,
            renew: reader.u32()?,
        };
        let is_skey = reader.u8()?;
        if is_skey > 1 {
            return Err(CredentialError::Invalid);
        }
        let flags = reader.u32()?;
        let addresses = read_items(reader)?;
        let authdata = read_items(reader)?;
        let ticket = reader.data32(MAX_TICKET_BYTES)?;
        let second = reader.data32(MAX_TICKET_BYTES)?;
        Ok(Self {
            client,
            server,
            enctype,
            key,
            times,
            is_skey,
            flags,
            addresses,
            authdata,
            ticket,
            second,
        })
    }

    fn validate(&self, now: u32) -> Result<()> {
        check_aes_key(self.enctype, self.key)?;
        if self.addresses != 0 || self.authdata != 0 || self.is_skey != 0 || !self.second.is_empty()
        {
            return Err(CredentialError::Unsupported);
        }
        if self.ticket.is_empty() {
            return Err(CredentialError::Invalid);
        }
        self.times.validate(now)
    }

    fn encode(&self, client: &Principal, server: &Principal) -> Result<Zeroizing<Vec<u8>>> {
        let mut out = Zeroizing::new(Vec::with_capacity(MAX_INPUT_BYTES));
        out.extend_from_slice(&[5, 4, 0, 0]);
        put_cache_principal(&mut out, client, 1)?;
        put_cache_principal(&mut out, client, 1)?;
        put_cache_principal(&mut out, server, 2)?;
        out.extend_from_slice(&self.enctype.to_be_bytes());
        put_len32(&mut out, self.key)?;
        for v in [
            self.times.auth,
            self.times.start,
            self.times.end,
            self.times.renew,
        ] {
            out.extend_from_slice(&v.to_be_bytes());
        }
        out.push(0);
        out.extend_from_slice(&self.flags.to_be_bytes());
        out.extend_from_slice(&[0; 8]);
        put_len32(&mut out, self.ticket)?;
        out.extend_from_slice(&[0; 4]);
        Ok(out)
    }
}

fn read_items(reader: &mut Cursor<'_>) -> Result<u32> {
    let count = reader.u32()?;
    if count > 16 {
        return Err(CredentialError::Invalid);
    }
    for _ in 0..count {
        reader.u16()?;
        reader.data32(8192)?;
    }
    Ok(count)
}
