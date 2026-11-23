use super::*;
use rsa::{RsaPrivateKey, pkcs8::DecodePrivateKey};

#[test]
fn maximum_username_fits_the_rsa_plaintext_without_truncation() {
    let der = include_bytes!("../../../tests/data/synthetic_rsa2048_pkcs8.der");
    let private = RsaPrivateKey::from_pkcs8_der(der).expect("synthetic RSA key");
    let username = vec![b'a'; 234];
    let encrypted = encrypted_username(&RsaPublicKey::from(&private), &username)
        .expect("exact PKCS#1 v1.5 bound");
    let plaintext = private
        .decrypt(Pkcs1v15Encrypt, &encrypted)
        .expect("decrypt");
    assert_eq!(plaintext.len(), 245);
    assert_eq!(plaintext.get(8..242), Some(username.as_slice()));
    assert_eq!(plaintext.get(242..), Some(&[0, 0, 0][..]));
}
