//! Apple Direct SRP (security type 36). Only the macOS 26.6.2 wire profile
//! verified on a dedicated test account is accepted. SRP authenticates the
//! server but does not encrypt subsequent RFB traffic.

use crypto_bigint::{
    BoxedUint, Odd,
    modular::{BoxedMontyForm, BoxedMontyParams},
};
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256, Sha512};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    time::Instant,
};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    AppleSrpCredentials, Authenticated, AuthenticatedStream, AuthenticationStage, Error,
    authentication::{discard_reason, phase, read_security_result},
};

const APPLE_VERSION: &[u8; 12] = b"RFB 003.889\n";
const CLIENT_VERSION: &[u8; 12] = b"RFB 003.008\n";
const DIRECT_SRP: u8 = 36;
const GROUP_BYTES: usize = 512;
const GROUP_BITS: u32 = 4096;
const PRIVATE_BYTES: usize = 64;
const HASH_BYTES: usize = 64;
const MAX_BLOB: u32 = 2048;
// RFC 5054 Appendix A, 4096-bit group. Pinning the digest avoids accepting a
// server-selected weak or malicious group while keeping the standard modulus
// out of protocol parsing logic.
const GROUP_SHA256: [u8; 32] = [
    0x4e, 0xe9, 0x51, 0x87, 0x68, 0x2b, 0xcb, 0x23, 0x0a, 0xd2, 0x6a, 0x95, 0x20, 0x5f, 0x69, 0x20,
    0xe8, 0x47, 0x08, 0xf6, 0x25, 0x1b, 0x38, 0x94, 0x32, 0x9b, 0x09, 0xec, 0x23, 0x91, 0x9e, 0x33,
];

type HmacSha512 = Hmac<Sha512>;

pub(crate) async fn authenticate<S>(
    mut stream: S,
    credentials: AppleSrpCredentials,
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
        select_direct_srp(&mut stream),
    )
    .await?;
    phase(
        AuthenticationStage::AppleSrpAuthentication,
        deadline,
        exchange_proofs(&mut stream, credentials, deadline),
    )
    .await?;
    Ok(Authenticated {
        stream: AuthenticatedStream::apple_srp_raw(stream),
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

async fn select_direct_srp<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S) -> Result<(), Error> {
    let count = stream.read_u8().await?;
    if count == 0 {
        discard_reason(stream).await?;
        return Err(Error::ServerRejected);
    }
    let mut offered = [0u8; u8::MAX as usize];
    let offered = offered
        .get_mut(..usize::from(count))
        .ok_or(Error::InvalidAppleSrpParameters)?;
    stream.read_exact(offered).await?;
    if !offered.contains(&DIRECT_SRP) {
        return Err(Error::UnsupportedSecurity);
    }
    stream.write_u8(DIRECT_SRP).await?;
    stream.flush().await?;
    Ok(())
}

struct Challenge<'a> {
    modulus: &'a [u8],
    salt: &'a [u8],
    server_public: &'a [u8],
    iterations: u32,
    options: &'a [u8],
}

fn take<'a>(bytes: &mut &'a [u8], len: usize) -> Result<&'a [u8], Error> {
    let (head, tail) = bytes
        .split_at_checked(len)
        .ok_or(Error::InvalidAppleSrpParameters)?;
    *bytes = tail;
    Ok(head)
}

fn take_u16(bytes: &mut &[u8]) -> Result<usize, Error> {
    let value = take(bytes, 2)?;
    Ok(usize::from(u16::from_be_bytes(
        value
            .try_into()
            .map_err(|_| Error::InvalidAppleSrpParameters)?,
    )))
}

fn parse_challenge(bytes: &[u8]) -> Result<Challenge<'_>, Error> {
    let mut rest = bytes;
    let inner = take(&mut rest, 4)?;
    if u32::from_be_bytes(
        inner
            .try_into()
            .map_err(|_| Error::InvalidAppleSrpParameters)?,
    ) != u32::try_from(bytes.len() - 4).map_err(|_| Error::InvalidAppleSrpParameters)?
    {
        return Err(Error::InvalidAppleSrpParameters);
    }
    if take(&mut rest, 1)? != [0] {
        return Err(Error::InvalidAppleSrpParameters);
    }
    let n_len = take_u16(&mut rest)?;
    if n_len != GROUP_BYTES {
        return Err(Error::InvalidAppleSrpParameters);
    }
    let modulus = take(&mut rest, n_len)?;
    let digest = Sha256::digest(modulus);
    if digest.as_slice() != GROUP_SHA256 {
        return Err(Error::InvalidAppleSrpParameters);
    }
    let g_len = take_u16(&mut rest)?;
    if g_len != 1 || take(&mut rest, g_len)? != [5] {
        return Err(Error::InvalidAppleSrpParameters);
    }
    let salt_len = usize::from(
        *take(&mut rest, 1)?
            .first()
            .ok_or(Error::InvalidAppleSrpParameters)?,
    );
    if salt_len != 32 {
        return Err(Error::InvalidAppleSrpParameters);
    }
    let salt = take(&mut rest, salt_len)?;
    let b_len = take_u16(&mut rest)?;
    if b_len != GROUP_BYTES {
        return Err(Error::InvalidAppleSrpParameters);
    }
    let server_public = take(&mut rest, b_len)?;
    let iteration_bytes = take(&mut rest, 8)?;
    let iterations = u64::from_be_bytes(
        iteration_bytes
            .try_into()
            .map_err(|_| Error::InvalidAppleSrpParameters)?,
    );
    if !(10_000..=250_000).contains(&iterations) {
        return Err(Error::InvalidAppleSrpParameters);
    }
    let options_len = take_u16(&mut rest)?;
    if options_len != 80 {
        return Err(Error::InvalidAppleSrpParameters);
    }
    let options = take(&mut rest, options_len)?;
    if !rest.is_empty() {
        return Err(Error::InvalidAppleSrpParameters);
    }
    Ok(Challenge {
        modulus,
        salt,
        server_public,
        iterations: iterations as u32,
        options,
    })
}

async fn read_blob<S: AsyncRead + Unpin>(stream: &mut S) -> Result<Vec<u8>, Error> {
    let len = stream.read_u32().await?;
    if !(4..=MAX_BLOB).contains(&len) {
        return Err(Error::InvalidAppleSrpParameters);
    }
    let mut bytes = vec![0u8; len as usize];
    stream.read_exact(&mut bytes).await?;
    Ok(bytes)
}

fn hash(parts: &[&[u8]]) -> Zeroizing<[u8; HASH_BYTES]> {
    let mut hasher = Sha512::new();
    for part in parts {
        hasher.update(part);
    }
    let mut digest = hasher.finalize();
    let mut result = Zeroizing::new([0u8; HASH_BYTES]);
    result.copy_from_slice(&digest);
    digest.as_mut_slice().zeroize();
    result
}

fn prf(password: &[u8], input: &[u8]) -> Result<Zeroizing<[u8; HASH_BYTES]>, Error> {
    let mut mac =
        HmacSha512::new_from_slice(password).map_err(|_| Error::InvalidAppleSrpParameters)?;
    mac.update(input);
    let mut bytes = mac.finalize().into_bytes();
    let mut result = Zeroizing::new([0u8; HASH_BYTES]);
    result.copy_from_slice(&bytes);
    bytes.as_mut_slice().zeroize();
    Ok(result)
}

async fn derive_password(
    password: &[u8],
    salt: &[u8],
    iterations: u32,
    deadline: Instant,
) -> Result<Zeroizing<[u8; 128]>, Error> {
    let mut output = Zeroizing::new([0u8; 128]);
    for block in 1u32..=2 {
        let mut first_input = [0u8; 36];
        first_input[..32].copy_from_slice(salt);
        first_input[32..].copy_from_slice(&block.to_be_bytes());
        let mut u = prf(password, &first_input)?;
        let chunk = output
            .get_mut(((block - 1) as usize * HASH_BYTES)..(block as usize * HASH_BYTES))
            .ok_or(Error::InvalidAppleSrpParameters)?;
        chunk.copy_from_slice(&*u);
        for iteration in 1..iterations {
            u = prf(password, &*u)?;
            for (target, byte) in chunk.iter_mut().zip(u.iter()) {
                *target ^= byte;
            }
            if iteration % 256 == 0 {
                tokio::task::yield_now().await;
                if deadline <= Instant::now() {
                    return Err(Error::AuthenticationDeadlineExceeded {
                        stage: AuthenticationStage::AppleSrpAuthentication,
                    });
                }
            }
        }
    }
    Ok(output)
}

async fn expected_proof(
    challenge: &Challenge<'_>,
    password: &[u8],
    deadline: Instant,
) -> Result<(Vec<u8>, Zeroizing<[u8; HASH_BYTES]>), Error> {
    let n = BoxedUint::from_be_slice(challenge.modulus, GROUP_BITS)
        .map_err(|_| Error::InvalidAppleSrpParameters)?;
    let one =
        BoxedUint::from_be_slice(&[1], GROUP_BITS).map_err(|_| Error::InvalidAppleSrpParameters)?;
    let b = BoxedUint::from_be_slice(challenge.server_public, GROUP_BITS)
        .map_err(|_| Error::InvalidAppleSrpParameters)?;
    if b < one || b >= n {
        return Err(Error::InvalidAppleSrpParameters);
    }
    let g =
        BoxedUint::from_be_slice(&[5], GROUP_BITS).map_err(|_| Error::InvalidAppleSrpParameters)?;
    let params = BoxedMontyParams::new_vartime(
        Option::<Odd<BoxedUint>>::from(Odd::new(n)).ok_or(Error::InvalidAppleSrpParameters)?,
    );
    let mut a_bytes = Zeroizing::new([0u8; PRIVATE_BYTES]);
    getrandom::fill(&mut *a_bytes).map_err(|_| Error::Randomness)?;
    *a_bytes.first_mut().ok_or(Error::Randomness)? |= 0x80;
    *a_bytes.last_mut().ok_or(Error::Randomness)? |= 1;
    let a = Zeroizing::new(
        BoxedUint::from_be_slice(&*a_bytes, GROUP_BITS)
            .map_err(|_| Error::InvalidAppleSrpParameters)?,
    );
    drop(a_bytes);
    let a_public = Zeroizing::new(
        BoxedMontyForm::new(g.clone(), &params)
            .pow_bounded_exp(&a, 512)
            .retrieve()
            .to_be_bytes(),
    );
    tokio::task::yield_now().await;
    if deadline <= Instant::now() {
        return Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::AppleSrpAuthentication,
        });
    }
    let derived = derive_password(password, challenge.salt, challenge.iterations, deadline).await?;
    let inner_x = hash(&[b":", &*derived]);
    drop(derived);
    let x_hash = hash(&[challenge.salt, &*inner_x]);
    drop(inner_x);
    let x = Zeroizing::new(
        BoxedUint::from_be_slice(&*x_hash, GROUP_BITS)
            .map_err(|_| Error::InvalidAppleSrpParameters)?,
    );
    drop(x_hash);
    let mut g_padded = [0u8; GROUP_BYTES];
    g_padded[GROUP_BYTES - 1] = 5;
    let k_hash = hash(&[challenge.modulus, &g_padded]);
    let k = Zeroizing::new(
        BoxedUint::from_be_slice(&*k_hash, GROUP_BITS)
            .map_err(|_| Error::InvalidAppleSrpParameters)?,
    );
    drop(k_hash);
    let u_hash = hash(&[&a_public, challenge.server_public]);
    let u = Zeroizing::new(
        BoxedUint::from_be_slice(&*u_hash, GROUP_BITS)
            .map_err(|_| Error::InvalidAppleSrpParameters)?,
    );
    drop(u_hash);
    if bool::from(u.is_zero()) {
        return Err(Error::InvalidAppleSrpParameters);
    }
    let v = Zeroizing::new(BoxedMontyForm::new(g, &params).pow_bounded_exp(&x, 512));
    let kv = Zeroizing::new(&BoxedMontyForm::new((*k).clone(), &params) * &*v);
    let base = Zeroizing::new(&BoxedMontyForm::new(b, &params) - &*kv);
    if bool::from(base.is_zero()) {
        return Err(Error::InvalidAppleSrpParameters);
    }
    let ux = Zeroizing::new(u.wrapping_mul(&x));
    let exp = Zeroizing::new(a.wrapping_add(&*ux));
    drop(ux);
    drop(a);
    drop(u);
    drop(x);
    let shared = Zeroizing::new(base.pow_bounded_exp(&exp, 1088).retrieve().to_be_bytes());
    drop(exp);
    tokio::task::yield_now().await;
    if deadline <= Instant::now() {
        return Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::AppleSrpAuthentication,
        });
    }
    let session_key = hash(&[&shared]);
    drop(shared);
    let h_n = hash(&[challenge.modulus]);
    let h_g = hash(&[&g_padded]);
    let mut xor_ng = [0u8; HASH_BYTES];
    for (out, (n, g)) in xor_ng.iter_mut().zip(h_n.iter().zip(h_g.iter())) {
        *out = n ^ g;
    }
    let h_empty = hash(&[b""]);
    let m1 = hash(&[
        &xor_ng,
        &*h_empty,
        challenge.salt,
        &a_public,
        challenge.server_public,
        &*session_key,
    ]);
    let m2 = hash(&[&a_public, &*m1, &*session_key]);
    let mut response = Vec::with_capacity(2 + GROUP_BYTES + 1 + HASH_BYTES + 2 + 80 + 1 + 16);
    response.extend_from_slice(&(GROUP_BYTES as u16).to_be_bytes());
    response.extend_from_slice(&a_public);
    response.push(HASH_BYTES as u8);
    response.extend_from_slice(&*m1);
    response.extend_from_slice(&(challenge.options.len() as u16).to_be_bytes());
    response.extend_from_slice(challenge.options);
    response.push(16);
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| Error::Randomness)?;
    response.extend_from_slice(&nonce);
    Ok((response, m2))
}

async fn exchange_proofs<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    credentials: AppleSrpCredentials,
    deadline: Instant,
) -> Result<(), Error> {
    let username = &credentials.username;
    let entry_len = 11 + username.len();
    stream.write_u8(DIRECT_SRP).await?;
    stream.write_u32(entry_len as u32).await?;
    stream.write_u32((entry_len - 4) as u32).await?;
    stream.write_u16(0).await?;
    stream.write_u16(username.len() as u16).await?;
    stream.write_all(username).await?;
    stream.write_u16(0).await?;
    stream.write_u8(0).await?;
    stream.flush().await?;

    let challenge_bytes = read_blob(stream).await?;
    let challenge = parse_challenge(&challenge_bytes)?;
    let (response, expected_m2) =
        expected_proof(&challenge, &credentials.password, deadline).await?;
    drop(credentials);
    let inner_len = u32::try_from(response.len()).map_err(|_| Error::InvalidAppleSrpParameters)?;
    stream.write_u32(inner_len + 4).await?;
    stream.write_u32(inner_len).await?;
    stream.write_all(&response).await?;
    stream.flush().await?;

    let final_token = read_blob(stream).await?;
    if !valid_final_token(&final_token, &expected_m2) {
        return Err(Error::AuthenticationFailed);
    }
    read_security_result(stream).await
}

fn valid_final_token(token: &[u8], expected_m2: &[u8; HASH_BYTES]) -> bool {
    token.len() == 92
        && token.get(..4) == Some(&(88u32).to_be_bytes()[..])
        && token.get(4) == Some(&64)
        && token.get(69) == Some(&16)
        && token.get(86..88) == Some(&[0, 0][..])
        && token.get(88..92) == Some(&[0, 0, 0, 0][..])
        && token
            .get(5..69)
            .is_some_and(|proof| bool::from(proof.ct_eq(expected_m2)))
}

#[cfg(test)]
mod tests {
    use super::{derive_password, expected_proof, parse_challenge, valid_final_token};
    use crate::{AuthenticationStage, Error};
    use tokio::time::Instant;

    #[allow(
        clippy::expect_used,
        clippy::indexing_slicing,
        reason = "fixed public protocol fixture"
    )]
    fn challenge() -> Vec<u8> {
        let hex_group: String = include_str!("../tests/data/rfc5054_4096.hex")
            .chars()
            .filter(|c| !c.is_ascii_whitespace())
            .collect();
        let group = hex::decode(hex_group).expect("RFC 5054 test group");
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(1155u32).to_be_bytes());
        bytes.push(0);
        bytes.extend_from_slice(&(512u16).to_be_bytes());
        bytes.extend_from_slice(&group);
        bytes.extend_from_slice(&(1u16).to_be_bytes());
        bytes.push(5);
        bytes.push(32);
        bytes.extend_from_slice(&[0x13; 32]);
        bytes.extend_from_slice(&(512u16).to_be_bytes());
        let mut public = [0u8; 512];
        public[511] = 5;
        bytes.extend_from_slice(&public);
        bytes.extend_from_slice(&(131_578u64).to_be_bytes());
        bytes.extend_from_slice(&(80u16).to_be_bytes());
        bytes.extend_from_slice(&[0x31; 80]);
        assert_eq!(bytes.len(), 1159);
        bytes
    }

    #[test]
    #[allow(
        clippy::indexing_slicing,
        reason = "fixed public protocol fixture offsets"
    )]
    fn challenge_rejects_modified_group_lengths_and_work_factor() {
        let valid = challenge();
        assert!(parse_challenge(&valid).is_ok());
        let mut changed = valid.clone();
        changed[7] ^= 1;
        assert!(matches!(
            parse_challenge(&changed),
            Err(Error::InvalidAppleSrpParameters)
        ));
        let mut changed = valid.clone();
        changed[521] = 2;
        assert!(matches!(
            parse_challenge(&changed),
            Err(Error::InvalidAppleSrpParameters)
        ));
        let mut changed = valid.clone();
        changed[1069..1077].copy_from_slice(&(u64::MAX).to_be_bytes());
        assert!(matches!(
            parse_challenge(&changed),
            Err(Error::InvalidAppleSrpParameters)
        ));
        let mut changed = valid.clone();
        changed[1069..1077].copy_from_slice(&(9_999u64).to_be_bytes());
        assert!(matches!(
            parse_challenge(&changed),
            Err(Error::InvalidAppleSrpParameters)
        ));
        let mut changed = valid.clone();
        changed[1077..1079].copy_from_slice(&(81u16).to_be_bytes());
        assert!(matches!(
            parse_challenge(&changed),
            Err(Error::InvalidAppleSrpParameters)
        ));
        assert!(matches!(
            parse_challenge(&valid[..valid.len() - 1]),
            Err(Error::InvalidAppleSrpParameters)
        ));
    }

    #[tokio::test]
    #[allow(clippy::expect_used, reason = "fixed public protocol fixture")]
    async fn zero_server_public_is_rejected_before_password_derivation() {
        let mut bytes = challenge();
        bytes.get_mut(557..1069).expect("B fixture").fill(0);
        let parsed = parse_challenge(&bytes).expect("valid lengths");
        assert!(matches!(
            expected_proof(&parsed, b"password", Instant::now()).await,
            Err(Error::InvalidAppleSrpParameters)
        ));
    }

    #[tokio::test]
    async fn password_kdf_checks_deadline_during_work() {
        assert!(matches!(
            derive_password(b"password", &[0; 32], 10_000, Instant::now()).await,
            Err(Error::AuthenticationDeadlineExceeded {
                stage: AuthenticationStage::AppleSrpAuthentication
            })
        ));
    }

    #[test]
    fn final_token_requires_exact_shape_and_server_proof() {
        let proof = [0x5a; 64];
        let mut token = [0u8; 92];
        token[..4].copy_from_slice(&(88u32).to_be_bytes());
        token[4] = 64;
        token[5..69].copy_from_slice(&proof);
        token[69] = 16;
        assert!(valid_final_token(&token, &proof));
        token[5] ^= 1;
        assert!(!valid_final_token(&token, &proof));
        token[5] ^= 1;
        token[88] = 1;
        assert!(!valid_final_token(&token, &proof));
        assert!(!valid_final_token(&token[..91], &proof));
    }
}
