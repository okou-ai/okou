use std::fmt;

use crate::{CredentialError, Result};

/// Explicit, case-preserving principal identity, independent of a FILE name type.
///
/// Components are structured, not a slash/at-sign-delimited string. Native
/// consumers must escape them correctly and may impose additional target policy.
#[derive(Clone, Eq, PartialEq)]
pub struct Principal {
    realm: String,
    components: Vec<String>,
}

impl Principal {
    /// Validate nonempty UTF-8 parts, no controls, and finite component budgets.
    pub fn new(realm: String, components: Vec<String>) -> Result<Self> {
        if components.is_empty() || components.len() > 8 {
            return Err(CredentialError::Invalid);
        }
        let mut total = 0usize;
        for part in std::iter::once(&realm).chain(components.iter()) {
            if part.is_empty() || part.len() > 255 || part.chars().any(char::is_control) {
                return Err(CredentialError::Invalid);
            }
            total = total
                .checked_add(part.len())
                .ok_or(CredentialError::Invalid)?;
        }
        if total > 1024 {
            return Err(CredentialError::Invalid);
        }
        Ok(Self { realm, components })
    }

    /// Exact realm bytes; no realm discovery or case normalization occurs.
    pub fn realm(&self) -> &str {
        &self.realm
    }

    /// Exact ordered components, not an implicitly parsed native name.
    pub fn components(&self) -> &[String] {
        &self.components
    }

    pub(crate) fn is_vnc_service_for(&self, initiator: &Self) -> bool {
        self.realm == initiator.realm
            && self.components.len() == 2
            && self.components.first().is_some_and(|part| part == "vnc")
    }
}

impl fmt::Debug for Principal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Principal([REDACTED])")
    }
}
