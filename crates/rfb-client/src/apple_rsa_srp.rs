//! Apple RSA/SRP security type 33 on the exact macOS 26.6.2 wire profile.
//! The received RSA key is not an independent host identity; the caller must
//! provide a verified full-session transport terminating on the Mac.

use crypto_bigint::BoxedUint;
use rand::{
    SeedableRng,
    rngs::{StdRng, SysRng},
};
use rsa::{
    Pkcs1v15Encrypt, RsaPublicKey,
    pkcs8::{DecodePublicKey, EncodePublicKey},
    traits::PublicKeyParts,
};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    time::Instant,
};
use zeroize::Zeroizing;

use crate::{
    AppleRsaSrpCredentials, Authenticated, AuthenticatedStream, AuthenticationStage, Error,
    apple_srp::{expected_proof, parse_challenge_fields, write_message},
    authentication::{discard_reason, phase, read_security_result},
};

const APPLE_VERSION: &[u8; 12] = b"RFB 003.889\n";
const CLIENT_VERSION: &[u8; 12] = b"RFB 003.008\n";
const SECURITY_TYPE: u8 = 33;
const KEY_REPLY_LEN: usize = 301;
const KEY_DER_LEN: usize = 294;
const RSA_BYTES: usize = 256;
const CHALLENGE_LEN: usize = 1165;
const PROOF_LEN: usize = 64;
const FINAL_LEN: usize = 98;

pub(crate) async fn authenticate<S>(
    mut stream: S,
    credentials: AppleRsaSrpCredentials,
    deadline: Instant,
) -> Result<Authenticated<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    phase(
        AuthenticationStage::RfbVersion,
        deadline,
        exchange_version(&mut stream),
    )
    .await?;
    phase(
        AuthenticationStage::SecurityNegotiation,
        deadline,
        verify_offer(&mut stream),
    )
    .await?;
    phase(
        AuthenticationStage::AppleRsaSrpAuthentication,
        deadline,
        exchange_proofs(&mut stream, credentials, deadline),
    )
    .await?;
    Ok(Authenticated {
        stream: AuthenticatedStream::apple_rsa_srp_raw(stream),
    })
}

async fn exchange_version<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S) -> Result<(), Error> {
    let mut version = [0; 12];
    stream.read_exact(&mut version).await?;
    if &version != APPLE_VERSION {
        return Err(Error::UnsupportedRfbVersion);
    }
    stream.write_all(CLIENT_VERSION).await?;
    stream.flush().await?;
    Ok(())
}

async fn verify_offer<S: AsyncRead + Unpin>(stream: &mut S) -> Result<(), Error> {
    let count = stream.read_u8().await?;
    if count == 0 {
        discard_reason(stream).await?;
        return Err(Error::ServerRejected);
    }
    let mut types = [0u8; u8::MAX as usize];
    let types = types
        .get_mut(..usize::from(count))
        .ok_or(Error::InvalidAppleRsaSrpParameters)?;
    stream.read_exact(types).await?;
    if !types.contains(&SECURITY_TYPE) {
        return Err(Error::UnsupportedSecurity);
    }
    Ok(())
}

fn invalid() -> Error {
    Error::InvalidAppleRsaSrpParameters
}

fn parse_rsa_key(reply: &[u8; KEY_REPLY_LEN]) -> Result<RsaPublicKey, Error> {
    if reply.get(..2) != Some(&[0, 1][..])
        || reply.get(2..6) != Some(&(KEY_DER_LEN as u32).to_be_bytes()[..])
        || reply.last() != Some(&0)
    {
        return Err(invalid());
    }
    let der = reply.get(6..6 + KEY_DER_LEN).ok_or_else(invalid)?;
    let key = RsaPublicKey::from_public_key_der(der).map_err(|_| invalid())?;
    if key.n().bits() != 2048 || key.e() != &BoxedUint::from(65537u32) || key.size() != RSA_BYTES {
        return Err(invalid());
    }
    let canonical = key.to_public_key_der().map_err(|_| invalid())?;
    if canonical.as_bytes() != der {
        return Err(invalid());
    }
    Ok(key)
}

fn encrypted_username(key: &RsaPublicKey, username: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
    let mut plaintext = Zeroizing::new(Vec::with_capacity(11 + username.len()));
    plaintext.extend_from_slice(&((7 + username.len()) as u32).to_be_bytes());
    plaintext.extend_from_slice(&0u16.to_be_bytes());
    plaintext.extend_from_slice(&(username.len() as u16).to_be_bytes());
    plaintext.extend_from_slice(username);
    plaintext.extend_from_slice(&0u16.to_be_bytes());
    plaintext.push(0);
    let mut rng = StdRng::try_from_rng(&mut SysRng).map_err(|_| Error::Randomness)?;
    let ciphertext = Zeroizing::new(
        key.encrypt(&mut rng, Pkcs1v15Encrypt, &plaintext)
            .map_err(|_| invalid())?,
    );
    if ciphertext.len() != RSA_BYTES {
        return Err(invalid());
    }
    Ok(ciphertext)
}

fn parse_rsa_challenge(bytes: &[u8]) -> Result<crate::apple_srp::Challenge<'_>, Error> {
    if bytes.len() != CHALLENGE_LEN
        || bytes.get(..4) != Some(&2u32.to_be_bytes()[..])
        || bytes.get(4..6) != Some(&1159u16.to_be_bytes()[..])
        || bytes.get(6..8) != Some(&[0, 0][..])
        || bytes.get(8..10) != Some(&1155u16.to_be_bytes()[..])
    {
        return Err(invalid());
    }
    parse_challenge_fields(bytes.get(10..).ok_or_else(invalid)?).map_err(|_| invalid())
}

fn valid_final_token(token: &[u8], expected: &[u8; PROOF_LEN]) -> bool {
    token.len() == FINAL_LEN
        && token.get(..4) == Some(&2u32.to_be_bytes()[..])
        && token.get(4..6) == Some(&92u16.to_be_bytes()[..])
        && token.get(6..8) == Some(&[0, 0][..])
        && token.get(8..10) == Some(&88u16.to_be_bytes()[..])
        && token.get(10) == Some(&64)
        && token.get(75) == Some(&16)
        && token.get(92..94) == Some(&[0, 0][..])
        && token.get(94..98) == Some(&[0, 0, 0, 0][..])
        && token
            .get(11..75)
            .is_some_and(|proof| bool::from(proof.ct_eq(expected)))
}

async fn exchange_proofs<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    credentials: AppleRsaSrpCredentials,
    deadline: Instant,
) -> Result<(), Error> {
    // The Mac parser must see the selection and RSA1 request in one socket write.
    let mut request = [0u8; 15];
    request[0] = SECURITY_TYPE;
    request[1..5].copy_from_slice(&10u32.to_be_bytes());
    request[5..7].copy_from_slice(&0x0100u16.to_be_bytes());
    request[7..11].copy_from_slice(b"RSA1");
    write_message(stream, &request).await?;

    let key_len = stream.read_u32().await?;
    if key_len != KEY_REPLY_LEN as u32 {
        return Err(invalid());
    }
    let mut key_reply = [0u8; KEY_REPLY_LEN];
    stream.read_exact(&mut key_reply).await?;
    let key = parse_rsa_key(&key_reply)?;
    let ciphertext = encrypted_username(&key, &credentials.username)?;
    let mut init = Zeroizing::new(Vec::with_capacity(654));
    init.extend_from_slice(&650u32.to_be_bytes());
    init.extend_from_slice(&0x0100u16.to_be_bytes());
    init.extend_from_slice(b"RSA1");
    init.extend_from_slice(&2u16.to_be_bytes());
    init.extend_from_slice(&0x0100u16.to_be_bytes());
    init.extend_from_slice(&ciphertext);
    init.resize(654, 0);
    write_message(stream, &init).await?;
    drop(init);
    drop(ciphertext);

    let challenge_len = stream.read_u32().await?;
    if challenge_len != CHALLENGE_LEN as u32 {
        return Err(invalid());
    }
    let mut challenge_bytes = vec![0u8; CHALLENGE_LEN];
    stream.read_exact(&mut challenge_bytes).await?;
    let challenge = parse_rsa_challenge(&challenge_bytes)?;
    let (response, expected_m2) = expected_proof(&challenge, &credentials.password, deadline)
        .await
        .map_err(|error| match error {
            Error::InvalidAppleSrpParameters => invalid(),
            Error::AuthenticationDeadlineExceeded { .. } => Error::AuthenticationDeadlineExceeded {
                stage: AuthenticationStage::AppleRsaSrpAuthentication,
            },
            other => other,
        })?;
    drop(credentials);
    let response = Zeroizing::new(response);
    let inner_len = u16::try_from(response.len()).map_err(|_| invalid())?;
    if inner_len != 678 {
        return Err(invalid());
    }
    let mut proof_packet = Zeroizing::new(Vec::with_capacity(1080));
    proof_packet.extend_from_slice(&1076u32.to_be_bytes());
    proof_packet.extend_from_slice(&0x0100u16.to_be_bytes());
    proof_packet.extend_from_slice(b"RSA1");
    proof_packet.extend_from_slice(&2u16.to_be_bytes());
    proof_packet.extend_from_slice(&682u16.to_be_bytes());
    proof_packet.extend_from_slice(&0u16.to_be_bytes());
    proof_packet.extend_from_slice(&inner_len.to_be_bytes());
    proof_packet.extend_from_slice(&response);
    proof_packet.resize(1080, 0);
    write_message(stream, &proof_packet).await?;
    drop(proof_packet);
    drop(response);

    let final_len = stream.read_u32().await?;
    // A rejected proof can be returned in place of the expected final blob.
    if final_len == 1 || final_len == 6 {
        return Err(Error::AuthenticationFailed);
    }
    if final_len != FINAL_LEN as u32 {
        return Err(invalid());
    }
    let mut final_token = [0u8; FINAL_LEN];
    stream.read_exact(&mut final_token).await?;
    if !valid_final_token(&final_token, &expected_m2) {
        return Err(Error::AuthenticationFailed);
    }
    read_security_result(stream).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::RsaPrivateKey;

    #[test]
    fn maximum_username_fits_the_rsa_plaintext_without_truncation() {
        let mut rng = StdRng::try_from_rng(&mut SysRng).expect("OS entropy");
        let private = RsaPrivateKey::new(&mut rng, 2048).expect("synthetic RSA key");
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
}
