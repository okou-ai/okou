//! Bounded, no-I/O Kerberos FILE credential import.
//!
//! These constructors validate a deliberately limited binary format and retain
//! only explicitly selected material. They do not authenticate tickets, learn
//! their cryptographically verified expiry, acquire credentials, or grant access.
//! Callers must bound allocation before supplying an owned input buffer.
#![forbid(unsafe_code)]

mod cache;
mod cursor;
mod keytab;
mod principal;

pub use cache::ServiceTicketCache;
pub use keytab::ClientKeytab;
pub use principal::Principal;

use std::fmt;

/// Maximum accepted size of either owned FILE credential input, in bytes.
pub const MAX_INPUT_BYTES: usize = 64 * 1024;
/// Maximum accepted size of a selected opaque service ticket, in bytes.
pub const MAX_TICKET_BYTES: usize = 48 * 1024;
/// Maximum credentials or signed keytab records, including discarded records.
pub const MAX_RECORDS: usize = 64;
/// Maximum admitted keys for a single explicit keytab initiator.
pub const MAX_KEYS: usize = 16;

/// Static error categories; never contain credential bytes, names, or paths.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CredentialError {
    /// Malformed input, inconsistent fields, or exceeded finite budgets.
    Invalid,
    /// Unsupported FILE version, name type, enctype, or selected variant.
    Unsupported,
    /// A default/client/service identity mismatch or ambiguous selection.
    IdentityMismatch,
    /// Declared ticket time is outside the explicit caller's valid interval.
    OutsideLifetime,
}

impl fmt::Display for CredentialError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid => "invalid or oversized Kerberos credential",
            Self::Unsupported => "unsupported Kerberos credential format or variant",
            Self::IdentityMismatch => "Kerberos credential identity mismatch or ambiguity",
            Self::OutsideLifetime => "Kerberos credential is outside its declared lifetime",
        })
    }
}

impl std::error::Error for CredentialError {}

type Result<T> = std::result::Result<T, CredentialError>;

fn check_aes_key(enctype: u16, key: &[u8]) -> Result<()> {
    match (enctype, key.len()) {
        (17, 16) | (18, 32) => Ok(()),
        (17 | 18, _) => Err(CredentialError::Invalid),
        _ => Err(CredentialError::Unsupported),
    }
}

fn put_len32(out: &mut Vec<u8>, bytes: &[u8]) -> Result<()> {
    let length = u32::try_from(bytes.len()).map_err(|_| CredentialError::Invalid)?;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}
