//! Public RSA-AES entry/stream tests against a controlled protocol peer.
//! Independent TigerVNC evidence is a separate opt-in target.
use aes::{Aes128, Aes256};
use crypto_bigint::BoxedUint;
use eax::{AeadInOut, Eax, KeyInit, Nonce, Tag, cipher::consts::U16};
use rand::{
    SeedableRng,
    rngs::{StdRng, SysRng},
};
use rfb_client::{Error, RsaAesCredentials, RsaAesSecurity, RsaServerKeyPin, authenticate_rsa_aes};
use rsa::{Pkcs1v15Encrypt, RsaPrivateKey, RsaPublicKey, traits::PublicKeyParts};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream},
    time::Instant,
};
type TestResult<T = ()> = Result<T, Box<dyn std::error::Error + Send + Sync>>;
fn key() -> TestResult<RsaPrivateKey> {
    Ok(RsaPrivateKey::new(
        &mut StdRng::try_from_rng(&mut SysRng)?,
        2048,
    )?)
}
fn wire(key: &RsaPublicKey) -> Vec<u8> {
    let size = key.size();
    let mut b = key.n().bits().to_be_bytes().to_vec();
    for x in [key.n().as_ref(), key.e()] {
        let v = x.to_be_bytes();
        b.resize(b.len() + size - v.len(), 0);
        b.extend_from_slice(&v);
    }
    b
}
fn hash(wide: bool, a: &[u8], b: &[u8]) -> Vec<u8> {
    if wide {
        let mut h = Sha256::new();
        h.update(a);
        h.update(b);
        h.finalize().to_vec()
    } else {
        let mut h = Sha1::new();
        h.update(a);
        h.update(b);
        h.finalize().to_vec()
    }
}
fn username() -> String {
    "界".repeat(85)
}
fn password() -> String {
    format!(" {} ", "p".repeat(253))
}
struct Peer {
    io: DuplexStream,
    read_key: Vec<u8>,
    write_key: Vec<u8>,
    read_count: u128,
    write_count: u128,
}
impl Peer {
    async fn send(&mut self, plain: &[u8], corrupt: bool) -> TestResult {
        let header = (plain.len() as u16).to_be_bytes();
        let mut data = plain.to_vec();
        let nonce: Nonce<U16> = self.write_count.to_le_bytes().into();
        let tag = if self.write_key.len() == 16 {
            Eax::<Aes128>::new_from_slice(&self.write_key)?.encrypt_inout_detached(
                &nonce,
                &header,
                data.as_mut_slice().into(),
            )
        } else {
            Eax::<Aes256>::new_from_slice(&self.write_key)?.encrypt_inout_detached(
                &nonce,
                &header,
                data.as_mut_slice().into(),
            )
        }?;
        let mut tag: [u8; 16] = tag.into();
        if corrupt {
            tag[0] ^= 1;
        }
        let mut frame = header.to_vec();
        frame.extend_from_slice(&data);
        frame.extend_from_slice(&tag);
        // Deliberate fragmentation is a peer condition, not a timer/sleep.
        for chunk in frame.chunks(3) {
            self.io.write_all(chunk).await?;
        }
        self.write_count += 1;
        Ok(())
    }
    async fn recv(&mut self) -> TestResult<Vec<u8>> {
        let size = self.io.read_u16().await?;
        let header = size.to_be_bytes();
        let mut data = vec![0; usize::from(size)];
        self.io.read_exact(&mut data).await?;
        let mut tag = [0; 16];
        self.io.read_exact(&mut tag).await?;
        let tag: Tag<U16> = tag.into();
        let nonce: Nonce<U16> = self.read_count.to_le_bytes().into();
        if self.read_key.len() == 16 {
            Eax::<Aes128>::new_from_slice(&self.read_key)?.decrypt_inout_detached(
                &nonce,
                &header,
                data.as_mut_slice().into(),
                &tag,
            )
        } else {
            Eax::<Aes256>::new_from_slice(&self.read_key)?.decrypt_inout_detached(
                &nonce,
                &header,
                data.as_mut_slice().into(),
                &tag,
            )
        }?;
        self.read_count += 1;
        Ok(data)
    }
    async fn closed(&mut self) -> TestResult<bool> {
        Ok(self.io.read(&mut [0]).await? == 0)
    }
}
#[derive(Clone, Copy, Debug)]
enum Fault {
    None,
    Proof,
    Mac,
    Subtype,
    AlternateSubtype,
    CiphertextLength,
    RandomLength,
    Extra,
    Password,
}
async fn peer(
    mut io: DuplexStream,
    private: RsaPrivateKey,
    mode: RsaAesSecurity,
    user: bool,
    fault: Fault,
) -> TestResult<bool> {
    let raw = wire(&private.to_public_key());
    let wide = matches!(mode, RsaAesSecurity::Ra2_256 | RsaAesSecurity::Ra2ne256);
    let full = matches!(mode, RsaAesSecurity::Ra2 | RsaAesSecurity::Ra2_256);
    io.write_all(b"RFB 003.008\n").await?;
    let mut banner = [0; 12];
    io.read_exact(&mut banner).await?;
    assert_eq!(&banner, b"RFB 003.008\n");
    io.write_all(&[2, mode as u8, 1]).await?;
    assert_eq!(io.read_u8().await?, mode as u8);
    io.write_all(&raw).await?;
    let bits = io.read_u32().await?;
    assert_eq!(bits, 2048);
    let mut pubwire = bits.to_be_bytes().to_vec();
    let mut parts = vec![0; 512];
    io.read_exact(&mut parts).await?;
    pubwire.extend_from_slice(&parts);
    let (n, e) = parts
        .split_at_checked(256)
        .ok_or("fixed client components missing")?;
    let pubkey = RsaPublicKey::new(
        BoxedUint::from_be_slice(n, 2048)?,
        BoxedUint::from_be_slice(e, 2048)?,
    )?;
    assert_eq!(io.read_u16().await?, 256);
    let mut ciphertext = vec![0; 256];
    io.read_exact(&mut ciphertext).await?;
    let client_random = private.decrypt(Pkcs1v15Encrypt, &ciphertext)?;
    let amount = if wide { 32 } else { 16 };
    assert_eq!(client_random.len(), amount);
    let random = vec![
        0x65;
        if matches!(fault, Fault::RandomLength) {
            amount + 1
        } else {
            amount
        }
    ];
    let encrypted = pubkey.encrypt(
        &mut StdRng::try_from_rng(&mut SysRng)?,
        Pkcs1v15Encrypt,
        &random,
    )?;
    if matches!(fault, Fault::CiphertextLength) {
        io.write_u16(255).await?;
        return Ok(io.read(&mut [0]).await? == 0);
    }
    io.write_u16(256).await?;
    io.write_all(&encrypted).await?;
    if matches!(fault, Fault::RandomLength) {
        return Ok(io.read(&mut [0]).await? == 0);
    }
    let mut read_key = hash(wide, &random, &client_random);
    read_key.truncate(amount);
    let mut write_key = hash(wide, &client_random, &random);
    write_key.truncate(amount);
    let mut p = Peer {
        io,
        read_key,
        write_key,
        read_count: 0,
        write_count: 0,
    };
    assert_eq!(p.recv().await?, hash(wide, &pubwire, &raw));
    let mut proof = hash(wide, &raw, &pubwire);
    if matches!(fault, Fault::Proof) {
        *proof.first_mut().ok_or("nonempty hash required")? ^= 1;
    }
    // Proof and subtype share a record: record != RFB message.
    proof.push(if matches!(fault, Fault::Subtype) {
        3
    } else if matches!(fault, Fault::AlternateSubtype) {
        if user { 2 } else { 1 }
    } else if user {
        1
    } else {
        2
    });
    if matches!(fault, Fault::Extra) {
        proof.push(9);
    }
    p.send(&proof, matches!(fault, Fault::Mac)).await?;
    if matches!(
        fault,
        Fault::Proof | Fault::Mac | Fault::Subtype | Fault::AlternateSubtype
    ) {
        return p.closed().await;
    }
    let creds = p.recv().await?;
    let name = if user { username() } else { String::new() };
    let secret = password();
    let mut expected = vec![name.len() as u8];
    expected.extend_from_slice(name.as_bytes());
    expected.push(secret.len() as u8);
    expected.extend_from_slice(secret.as_bytes());
    assert_eq!(creds, expected);
    if matches!(fault, Fault::Extra) {
        return p.closed().await;
    }
    let result = if matches!(fault, Fault::Password) {
        vec![0, 0, 0, 1, 0, 0, 0, 0]
    } else {
        vec![0, 0, 0, 0]
    };
    if full {
        p.send(&result, false).await?;
    } else {
        p.io.write_all(&result).await?;
    }
    if matches!(fault, Fault::Password) {
        return p.closed().await;
    }
    if full {
        assert_eq!(p.recv().await?, b"hello");
        p.send(b"reply", false).await?;
    } else {
        let mut b = [0; 5];
        p.io.read_exact(&mut b).await?;
        assert_eq!(&b, b"hello");
        p.io.write_all(b"reply").await?;
    }
    Ok(true)
}
fn credential(user: bool) -> Result<RsaAesCredentials, Error> {
    if user {
        RsaAesCredentials::username_password(username(), password())
    } else {
        RsaAesCredentials::password(password())
    }
}
#[tokio::test]
async fn all_four_exact_modes_and_both_credential_subtypes_keep_the_selected_post_auth_transport()
-> TestResult {
    let private = key()?;
    let pin = RsaServerKeyPin::new(Sha256::digest(wire(&private.to_public_key())).into());
    for mode in [
        RsaAesSecurity::Ra2,
        RsaAesSecurity::Ra2_256,
        RsaAesSecurity::Ra2ne,
        RsaAesSecurity::Ra2ne256,
    ] {
        for user in [false, true] {
            let (a, b) = tokio::io::duplex(512);
            let server = tokio::spawn(peer(b, private.clone(), mode, user, Fault::None));
            let mut authenticated = authenticate_rsa_aes(
                a,
                mode,
                credential(user)?,
                pin,
                Instant::now() + Duration::from_secs(30),
            )
            .await?
            .into_stream();
            authenticated.write_all(b"hello").await?;
            authenticated.flush().await?;
            let mut reply = [0; 5];
            authenticated.read_exact(&mut reply).await?;
            assert_eq!(&reply, b"reply");
            assert!(server.await??);
        }
    }
    Ok(())
}
#[tokio::test]
async fn wrong_proof_mac_subtype_raw_transition_and_security_result_never_return_a_session()
-> TestResult {
    let private = key()?;
    let pin = RsaServerKeyPin::new(Sha256::digest(wire(&private.to_public_key())).into());
    // Keep related negative exchanges in one matrix: separate concurrently
    // running crypto-heavy tests must not compete for the engine's two-job limit.
    for (mode, user, fault) in [
        (RsaAesSecurity::Ra2ne, false, Fault::Proof),
        (RsaAesSecurity::Ra2ne, false, Fault::Mac),
        (RsaAesSecurity::Ra2ne, false, Fault::Subtype),
        (RsaAesSecurity::Ra2ne, false, Fault::AlternateSubtype),
        (RsaAesSecurity::Ra2ne, false, Fault::CiphertextLength),
        (RsaAesSecurity::Ra2ne, false, Fault::RandomLength),
        (RsaAesSecurity::Ra2ne, false, Fault::Extra),
        (RsaAesSecurity::Ra2ne, false, Fault::Password),
        (RsaAesSecurity::Ra2_256, false, Fault::AlternateSubtype),
        (RsaAesSecurity::Ra2_256, true, Fault::AlternateSubtype),
    ] {
        let (a, b) = tokio::io::duplex(512);
        let server = tokio::spawn(peer(b, private.clone(), mode, user, fault));
        let result = authenticate_rsa_aes(
            a,
            mode,
            credential(user)?,
            pin,
            Instant::now() + Duration::from_secs(30),
        )
        .await;
        let rejected = match fault {
            Fault::Subtype | Fault::AlternateSubtype => {
                matches!(result, Err(Error::InvalidRsaAesCredential))
            }
            Fault::Mac => matches!(result, Err(Error::Io(_))),
            Fault::Password => matches!(result, Err(Error::AuthenticationFailed)),
            Fault::Proof | Fault::CiphertextLength | Fault::RandomLength | Fault::Extra => {
                matches!(result, Err(Error::InvalidRsaAesExchange))
            }
            Fault::None => false,
        };
        assert!(
            rejected,
            "expected exact rejection for {mode:?}/{user}/{fault:?}"
        );
        assert!(server.await??);
    }
    Ok(())
}
async fn prefix<S: AsyncRead + AsyncWrite + Unpin>(io: &mut S, offered: u8) -> TestResult {
    io.write_all(b"RFB 003.008\n").await?;
    let mut b = [0; 12];
    io.read_exact(&mut b).await?;
    io.write_all(&[1, offered]).await?;
    Ok(())
}
#[tokio::test]
async fn missing_exact_offer_and_wrong_pin_close_without_client_key_or_credentials() -> TestResult {
    let raw = wire(&key()?.to_public_key());
    for wrong_pin in [false, true] {
        let (a, mut b) = tokio::io::duplex(2048);
        let raw = raw.clone();
        let server = tokio::spawn(async move {
            prefix(&mut b, if wrong_pin { 5 } else { 129 }).await?;
            if wrong_pin {
                assert_eq!(b.read_u8().await?, 5);
                b.write_all(&raw).await?;
            }
            assert_eq!(b.read(&mut [0]).await?, 0);
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
        });
        assert!(matches!(
            authenticate_rsa_aes(
                a,
                RsaAesSecurity::Ra2,
                credential(false)?,
                RsaServerKeyPin::new([0; 32]),
                Instant::now() + Duration::from_secs(30)
            )
            .await,
            Err(Error::RsaServerKeyMismatch | Error::UnsupportedSecurity)
        ));
        server.await??;
    }
    Ok(())
}
#[tokio::test]
async fn peer_key_size_is_rejected_before_body_or_crypto_and_deadlines_drop_the_stream()
-> TestResult {
    for bits in [0u32, 1024, 2049, 8192, u32::MAX] {
        let (a, mut b) = tokio::io::duplex(64);
        let server = tokio::spawn(async move {
            prefix(&mut b, 5).await?;
            assert_eq!(b.read_u8().await?, 5);
            b.write_u32(bits).await?;
            assert_eq!(b.read(&mut [0]).await?, 0);
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
        });
        assert!(matches!(
            authenticate_rsa_aes(
                a,
                RsaAesSecurity::Ra2,
                credential(false)?,
                RsaServerKeyPin::new([0; 32]),
                Instant::now() + Duration::from_secs(30)
            )
            .await,
            Err(Error::InvalidRsaAesExchange)
        ));
        server.await??;
    }
    let (a, mut b) = tokio::io::duplex(64);
    assert!(matches!(
        authenticate_rsa_aes(
            a,
            RsaAesSecurity::Ra2,
            credential(false)?,
            RsaServerKeyPin::new([0; 32]),
            Instant::now()
        )
        .await,
        Err(Error::AuthenticationDeadlineExceeded { .. })
    ));
    assert_eq!(b.read(&mut [0]).await?, 0);
    Ok(())
}
#[tokio::test]
async fn pinned_but_invalid_rsa_modulus_or_exponent_close_before_client_exchange() -> TestResult {
    let raw = wire(&key()?.to_public_key());
    let mut missing_top_bit = raw.clone();
    *missing_top_bit.get_mut(4).ok_or("modulus required")? &= 0x7f;
    let mut even_modulus = raw.clone();
    *even_modulus.get_mut(259).ok_or("modulus required")? &= 0xfe;
    let mut wrong_exponent = raw.clone();
    wrong_exponent
        .get_mut(260..)
        .ok_or("exponent required")?
        .fill(0);
    *wrong_exponent.last_mut().ok_or("exponent required")? = 3;
    for raw in [missing_top_bit, even_modulus, wrong_exponent] {
        // A matching independently supplied pin does not waive RSA parameter policy.
        let pin = RsaServerKeyPin::new(Sha256::digest(&raw).into());
        let (a, mut b) = tokio::io::duplex(2048);
        let server = tokio::spawn(async move {
            prefix(&mut b, 5).await?;
            assert_eq!(b.read_u8().await?, 5);
            b.write_all(&raw).await?;
            assert_eq!(b.read(&mut [0]).await?, 0);
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
        });
        assert!(matches!(
            authenticate_rsa_aes(
                a,
                RsaAesSecurity::Ra2,
                credential(false)?,
                pin,
                Instant::now() + Duration::from_secs(30)
            )
            .await,
            Err(Error::InvalidRsaAesExchange)
        ));
        server.await??;
    }
    Ok(())
}

#[tokio::test]
async fn cancelling_pending_key_negotiation_drops_the_owned_stream() -> TestResult {
    let (a, mut b) = tokio::io::duplex(64);
    let (entered, ready) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        prefix(&mut b, 5).await?;
        assert_eq!(b.read_u8().await?, 5);
        entered.send(()).map_err(|_| "cancel observer missing")?;
        assert_eq!(b.read(&mut [0]).await?, 0);
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
    });
    let mut waiting = Box::pin(authenticate_rsa_aes(
        a,
        RsaAesSecurity::Ra2,
        credential(false)?,
        RsaServerKeyPin::new([0; 32]),
        Instant::now() + Duration::from_secs(30),
    ));
    tokio::select! {result=&mut waiting=>panic!("unexpected completion {}",result.is_ok()),done=ready=>done?};
    drop(waiting);
    server.await??;
    Ok(())
}
#[test]
fn credentials_preserve_utf8_spaces_exact_255_byte_limits_and_redacted_debug() -> TestResult {
    let value = RsaAesCredentials::username_password(username(), password())?;
    assert_eq!(format!("{value:?}"), "RsaAesCredentials([REDACTED])");
    for value in [String::new(), "x".repeat(256), "bad\0secret".into()] {
        assert!(RsaAesCredentials::password(value).is_err());
    }
    assert!(RsaAesCredentials::username_password("界".repeat(86), "ok".into()).is_err());
    Ok(())
}
