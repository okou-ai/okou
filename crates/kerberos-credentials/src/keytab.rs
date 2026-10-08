use std::fmt;

use zeroize::Zeroizing;

use crate::{
    CredentialError, MAX_INPUT_BYTES, MAX_KEYS, MAX_RECORDS, Principal, Result, check_aes_key,
    cursor::Cursor,
};

/// Canonical FILEkeytab2 with explicit AES keys for exactly one initiator.
///
/// No Clone or byte-exposing Debug; importing this type does not acquire tickets.
pub struct ClientKeytab {
    bytes: Zeroizing<Vec<u8>>,
}

impl ClientKeytab {
    /// Consume/zeroize a bounded keytab and normalize its records and versions.
    ///
    /// Admits name types0–3, AES17/18, positive effective kvno and at most16 keys.
    /// Rejects mixed principal, duplicates, unsupported formats and malformed
    /// signed holes. Positive entry padding is discarded; end marker must be EOF.
    pub fn parse(input: Vec<u8>, initiator: &Principal) -> Result<Self> {
        let input = Zeroizing::new(input);
        if input.len() > MAX_INPUT_BYTES {
            return Err(CredentialError::Invalid);
        }
        let mut reader = Cursor::new(&input);
        if reader.take(2)? != [5, 2] {
            return Err(CredentialError::Unsupported);
        }
        let mut keys = Vec::new();
        let mut records = 0;
        while !reader.done() {
            records += 1;
            if records > MAX_RECORDS {
                return Err(CredentialError::Invalid);
            }
            let signed = reader.i32()?;
            if signed == 0 {
                if !reader.done() {
                    return Err(CredentialError::Invalid);
                }
                break;
            }
            let size =
                usize::try_from(signed.unsigned_abs()).map_err(|_| CredentialError::Invalid)?;
            let data = reader.take(size)?;
            if signed < 0 {
                if data.iter().any(|byte| *byte != 0) {
                    return Err(CredentialError::Invalid);
                }
                continue;
            }
            if keys.len() >= MAX_KEYS {
                return Err(CredentialError::Invalid);
            }
            let entry = Key::read(data, initiator)?;
            if keys
                .iter()
                .any(|key: &Key<'_>| key.kvno == entry.kvno && key.enctype == entry.enctype)
            {
                return Err(CredentialError::IdentityMismatch);
            }
            keys.push(entry);
        }
        if keys.is_empty() {
            return Err(CredentialError::Invalid);
        }
        keys.sort_by_key(|key| (key.kvno, key.enctype));
        let mut bytes = Zeroizing::new(Vec::with_capacity(MAX_INPUT_BYTES));
        bytes.extend_from_slice(&[5, 2]);
        for key in keys {
            key.encode(&mut bytes, initiator)?;
        }
        Ok(Self { bytes })
    }

    /// Borrow canonical secret bytes for future private native/KMS use only.
    pub fn canonical_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl fmt::Debug for ClientKeytab {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ClientKeytab([REDACTED])")
    }
}

struct Key<'a> {
    kvno: u32,
    enctype: u16,
    bytes: &'a [u8],
}

impl<'a> Key<'a> {
    fn read(data: &'a [u8], initiator: &Principal) -> Result<Self> {
        let mut reader = Cursor::new(data);
        if reader.principal(true)? != *initiator {
            return Err(CredentialError::IdentityMismatch);
        }
        reader.u32()?; // Informational timestamp is not credential lifetime.
        let kvno8 = u32::from(reader.u8()?);
        let enctype = reader.u16()?;
        let size = usize::from(reader.u16()?);
        let bytes = reader.take(size)?;
        check_aes_key(enctype, bytes)?;
        let mut kvno = kvno8;
        if reader.remaining() >= 4 {
            let wide = reader.u32()?;
            if wide != 0 {
                kvno = wide;
            }
        }
        if kvno == 0 {
            return Err(CredentialError::Invalid);
        }
        Ok(Self {
            kvno,
            enctype,
            bytes,
        })
    }

    fn encode(&self, out: &mut Vec<u8>, initiator: &Principal) -> Result<()> {
        // The validated principal is at most1024 bytes; fixed framing/key
        // fields fit well below2048, so secret construction need not reallocate.
        let mut record = Zeroizing::new(Vec::with_capacity(2048));
        let count =
            u16::try_from(initiator.components().len()).map_err(|_| CredentialError::Invalid)?;
        record.extend_from_slice(&count.to_be_bytes());
        put_text(&mut record, initiator.realm())?;
        for part in initiator.components() {
            put_text(&mut record, part)?;
        }
        record.extend_from_slice(&1u32.to_be_bytes());
        record.extend_from_slice(&0u32.to_be_bytes());
        record.push((self.kvno & 0xff) as u8);
        record.extend_from_slice(&self.enctype.to_be_bytes());
        record.extend_from_slice(
            &u16::try_from(self.bytes.len())
                .map_err(|_| CredentialError::Invalid)?
                .to_be_bytes(),
        );
        record.extend_from_slice(self.bytes);
        record.extend_from_slice(&self.kvno.to_be_bytes());
        let size = i32::try_from(record.len()).map_err(|_| CredentialError::Invalid)?;
        out.extend_from_slice(&size.to_be_bytes());
        out.extend_from_slice(&record);
        Ok(())
    }
}

fn put_text(out: &mut Vec<u8>, text: &str) -> Result<()> {
    let size = u16::try_from(text.len()).map_err(|_| CredentialError::Invalid)?;
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(text.as_bytes());
    Ok(())
}
