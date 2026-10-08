//! Strict format and resource preflight before expensive credential decoding.

use std::sync::Arc;

use base64::Engine;
use pkcs8::der::Decode;
use rsa::pkcs1::DecodeRsaPrivateKey;
use russh::keys::{PrivateKey, PublicKey, ssh_key};
use zeroize::Zeroizing;

use super::FailureReason;

const MAX_RSA_BYTES: usize = 1024;

pub(super) struct SigningKey(pub(super) Arc<PrivateKey>);

pub(super) fn decode(text: &str, passphrase: Option<&str>) -> Result<SigningKey, FailureReason> {
    let text = text.trim();
    let mut lines = text.lines();
    let header = lines.next().ok_or(FailureReason::InvalidCredential)?;
    let footer = match header {
        "-----BEGIN OPENSSH PRIVATE KEY-----" => "-----END OPENSSH PRIVATE KEY-----",
        "-----BEGIN PRIVATE KEY-----" => "-----END PRIVATE KEY-----",
        "-----BEGIN ENCRYPTED PRIVATE KEY-----" => "-----END ENCRYPTED PRIVATE KEY-----",
        "-----BEGIN RSA PRIVATE KEY-----" => "-----END RSA PRIVATE KEY-----",
        _ => return Err(FailureReason::UnsupportedCredential),
    };
    let mut encoded = Zeroizing::new(String::with_capacity(text.len()));
    let mut ended = false;
    for line in lines {
        if line == footer && !ended {
            ended = true;
        } else if ended
            || line.is_empty()
            || !line
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
        {
            return Err(FailureReason::InvalidCredential);
        } else {
            encoded.push_str(line);
        }
    }
    if !ended {
        return Err(FailureReason::InvalidCredential);
    }
    let mut der = Zeroizing::new(vec![0u8; encoded.len()]);
    let size = base64::engine::general_purpose::STANDARD
        .decode_slice(encoded.as_bytes(), &mut der)
        .map_err(|_| FailureReason::InvalidCredential)?;
    der.truncate(size);
    let key = match header {
        "-----BEGIN OPENSSH PRIVATE KEY-----" => {
            let key = PrivateKey::from_bytes(&der).map_err(|_| FailureReason::InvalidCredential)?;
            validate_public(key.public_key())?;
            if key.is_encrypted() {
                match key.kdf() {
                    ssh_key::Kdf::Bcrypt { salt, rounds }
                        if (1..=64).contains(rounds) && (16..=64).contains(&salt.len()) => {}
                    _ => return Err(FailureReason::CredentialResourceLimit),
                }
                if !matches!(
                    key.cipher(),
                    ssh_key::Cipher::Aes128Ctr
                        | ssh_key::Cipher::Aes192Ctr
                        | ssh_key::Cipher::Aes256Ctr
                        | ssh_key::Cipher::Aes128Cbc
                        | ssh_key::Cipher::Aes192Cbc
                        | ssh_key::Cipher::Aes256Cbc
                        | ssh_key::Cipher::Aes128Gcm
                        | ssh_key::Cipher::Aes256Gcm
                ) {
                    return Err(FailureReason::UnsupportedCredential);
                }
                key.decrypt(passphrase.ok_or(FailureReason::InvalidCredential)?)
                    .map_err(|_| FailureReason::InvalidCredential)?
            } else {
                key
            }
        }
        "-----BEGIN ENCRYPTED PRIVATE KEY-----" => {
            let info = pkcs8::EncryptedPrivateKeyInfoRef::try_from(der.as_slice())
                .map_err(|_| FailureReason::InvalidCredential)?;
            preflight_pbes(&info.encryption_algorithm)?;
            let secret = info
                .decrypt(passphrase.ok_or(FailureReason::InvalidCredential)?)
                .map_err(|_| FailureReason::InvalidCredential)?;
            decode_pkcs8(secret.as_bytes())?
        }
        "-----BEGIN PRIVATE KEY-----" => decode_pkcs8(&der)?,
        "-----BEGIN RSA PRIVATE KEY-----" => {
            preflight_rsa(&der)?;
            let key = rsa::RsaPrivateKey::from_pkcs1_der(&der)
                .map_err(|_| FailureReason::InvalidCredential)?;
            let key = ssh_key::private::RsaKeypair::try_from(key)
                .map_err(|_| FailureReason::InvalidCredential)?;
            PrivateKey::from(key)
        }
        _ => return Err(FailureReason::UnsupportedCredential),
    };
    validate_public(key.public_key())?;
    if let ssh_key::private::KeypairData::Rsa(rsa) = key.key_data() {
        let private = rsa.private();
        for part in [private.d(), private.p(), private.q(), private.iqmp()] {
            if part
                .as_positive_bytes()
                .is_none_or(|bytes| bytes.len() > MAX_RSA_BYTES)
            {
                return Err(FailureReason::CredentialResourceLimit);
            }
        }
    }
    Ok(SigningKey(Arc::new(key)))
}

fn decode_pkcs8(der: &[u8]) -> Result<PrivateKey, FailureReason> {
    let info =
        pkcs8::PrivateKeyInfoRef::try_from(der).map_err(|_| FailureReason::InvalidCredential)?;
    if info.algorithm.oid.as_bytes() == rsa::pkcs1::ALGORITHM_OID.as_bytes() {
        preflight_rsa(info.private_key.as_bytes())?;
    }
    russh::keys::pkcs8::decode_pkcs8(der, None).map_err(|_| FailureReason::InvalidCredential)
}

fn preflight_rsa(der: &[u8]) -> Result<(), FailureReason> {
    let key =
        rsa::pkcs1::RsaPrivateKey::from_der(der).map_err(|_| FailureReason::InvalidCredential)?;
    if key.public_exponent.as_bytes().len() > 4 || key.other_prime_infos.is_some() {
        return Err(FailureReason::UnsupportedCredential);
    }
    let modulus = key.modulus.as_bytes();
    if modulus.len() < 256
        || (modulus.len() == 256 && modulus.first().is_some_and(|byte| *byte < 128))
    {
        return Err(FailureReason::UnsupportedCredential);
    }
    for part in [
        key.modulus,
        key.private_exponent,
        key.prime1,
        key.prime2,
        key.exponent1,
        key.exponent2,
        key.coefficient,
    ] {
        if part.as_bytes().len() > MAX_RSA_BYTES {
            return Err(FailureReason::CredentialResourceLimit);
        }
    }
    Ok(())
}

pub(super) fn validate_public(key: &PublicKey) -> Result<(), FailureReason> {
    match key.key_data() {
        ssh_key::public::KeyData::Ed25519(_) | ssh_key::public::KeyData::Ecdsa(_) => Ok(()),
        ssh_key::public::KeyData::Rsa(key)
            if (2048..=8192).contains(&key.key_size())
                && key.e().as_positive_bytes().is_some_and(|e| e.len() <= 4) =>
        {
            Ok(())
        }
        _ => Err(FailureReason::UnsupportedCredential),
    }
}

fn preflight_pbes(scheme: &pkcs5::EncryptionScheme) -> Result<(), FailureReason> {
    use pkcs5::pbes2::{EncryptionScheme, Kdf, Pbkdf2Prf};
    let pkcs5::EncryptionScheme::Pbes2(params) = scheme else {
        return Err(FailureReason::UnsupportedCredential);
    };
    if !matches!(
        params.encryption,
        EncryptionScheme::Aes128Cbc { .. }
            | EncryptionScheme::Aes192Cbc { .. }
            | EncryptionScheme::Aes256Cbc { .. }
            | EncryptionScheme::Aes128Gcm { .. }
            | EncryptionScheme::Aes256Gcm { .. }
    ) {
        return Err(FailureReason::UnsupportedCredential);
    }
    let valid = match &params.kdf {
        Kdf::Pbkdf2(p) => {
            (1..=600_000).contains(&p.iteration_count)
                && matches!(
                    p.prf,
                    Pbkdf2Prf::HmacWithSha256
                        | Pbkdf2Prf::HmacWithSha384
                        | Pbkdf2Prf::HmacWithSha512
                )
                && p.key_length
                    .is_none_or(|len| usize::from(len) == params.encryption.key_size())
        }
        Kdf::Scrypt(p) => {
            let n = p.cost_parameter;
            let r = u64::from(p.block_size);
            n.is_power_of_two()
                && n > 1
                && (1..=8).contains(&r)
                && p.parallelization == 1
                && n.checked_mul(r).is_some_and(|work| work <= 262_144)
                && p.key_length
                    .is_none_or(|len| usize::from(len) == params.encryption.key_size())
        }
        _ => false,
    };
    if !valid {
        return Err(FailureReason::CredentialResourceLimit);
    }
    Ok(())
}
