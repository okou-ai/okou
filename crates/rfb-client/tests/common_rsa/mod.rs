//! Public synthetic server identity for RSA protocol fixtures, never a production key.

use rsa::{RsaPrivateKey, pkcs8::DecodePrivateKey};

// The fixture stores the existing 2048-bit/e65537 identity. The client still
// provides the real authentication exchange, proofs and random values.
pub fn server_key() -> Result<RsaPrivateKey, Box<dyn std::error::Error + Send + Sync>> {
    let der = include_bytes!("../data/synthetic_rsa2048_pkcs8.der");
    Ok(RsaPrivateKey::from_pkcs8_der(der)?)
}
