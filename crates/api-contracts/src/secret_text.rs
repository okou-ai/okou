//! Bounded, non-Debug credential text for generated private response DTOs.

use serde::{Deserialize, Deserializer, de};
use zeroize::Zeroizing;

/// Credential text has one application-owned zeroizing allocation. It cannot
/// be cloned, serialized or printed through Debug. The limit matches Zod's
/// JavaScript UTF-16 string-length bound, without trimming secret whitespace.
pub struct SecretText<const MAX: usize>(Zeroizing<String>);

/// Credential text bounded by exact UTF-8 bytes for protocols whose limits are
/// defined on the wire rather than in JavaScript string units.
pub struct SecretUtf8Text<const MAX: usize>(Zeroizing<String>);

impl<const MAX: usize> SecretText<MAX> {
    /// Borrow only at the credential consumer boundary.
    pub fn expose(&self) -> &str {
        self.0.as_str()
    }
}

impl<'de, const MAX: usize> Deserialize<'de> for SecretText<MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor<const MAX: usize>;
        impl<const MAX: usize> de::Visitor<'_> for Visitor<MAX> {
            type Value = SecretText<MAX>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("bounded credential text")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                if value.is_empty() || value.encode_utf16().count() > MAX {
                    return Err(E::custom("credential text outside bounds"));
                }
                Ok(SecretText(Zeroizing::new(value.to_owned())))
            }

            fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
                let value = Zeroizing::new(value);
                if value.is_empty() || value.encode_utf16().count() > MAX {
                    return Err(E::custom("credential text outside bounds"));
                }
                Ok(SecretText(value))
            }
        }
        deserializer.deserialize_string(Visitor::<MAX>)
    }
}

impl<const MAX: usize> SecretUtf8Text<MAX> {
    /// Borrow only at the credential consumer boundary.
    pub fn expose(&self) -> &str {
        self.0.as_str()
    }

    /// Transfer the existing string allocation to the credential consumer
    /// without creating another plaintext copy.
    pub fn into_zeroizing(mut self) -> Zeroizing<String> {
        Zeroizing::new(std::mem::take(&mut *self.0))
    }
}

impl<'de, const MAX: usize> Deserialize<'de> for SecretUtf8Text<MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor<const MAX: usize>;
        impl<const MAX: usize> de::Visitor<'_> for Visitor<MAX> {
            type Value = SecretUtf8Text<MAX>;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("UTF-8-byte-bounded credential text")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                if value.is_empty() || value.len() > MAX {
                    return Err(E::custom("credential text outside UTF-8 byte bounds"));
                }
                Ok(SecretUtf8Text(Zeroizing::new(value.to_owned())))
            }

            fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
                let value = Zeroizing::new(value);
                if value.is_empty() || value.len() > MAX {
                    return Err(E::custom("credential text outside UTF-8 byte bounds"));
                }
                Ok(SecretUtf8Text(value))
            }
        }
        deserializer.deserialize_string(Visitor::<MAX>)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_secret_uses_exact_byte_bounds_without_exposing_values_in_errors() {
        let exact: SecretUtf8Text<6> = serde_json::from_str(r#""界界""#).unwrap();
        assert_eq!(exact.expose(), "界界");
        let allocation = exact.expose().as_ptr();
        let transferred = exact.into_zeroizing();
        assert_eq!(transferred.as_str(), "界界");
        assert_eq!(transferred.as_ptr(), allocation);
        for invalid in [r#"""#, r#""界界a""#, r#""secret-canary""#] {
            let error = serde_json::from_str::<SecretUtf8Text<6>>(invalid)
                .err()
                .unwrap();
            assert!(!error.to_string().contains("secret-canary"));
        }
    }
}
