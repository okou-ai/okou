//! RSA-AES wire implementation from the pinned RFB specification, not vendor code.
//! Exact modes, out-of-band RSA pin and an owned EAX/explicit raw transition.
pub(crate) mod records;
use crate::{
    Authenticated, AuthenticatedStream, AuthenticationStage, Error,
    authentication::{phase, read_security_result},
};
use crypto_bigint::BoxedUint;
use rand::{
    SeedableRng,
    rngs::{StdRng, SysRng},
};
use records::Records;
use rsa::{Pkcs1v15Encrypt, RsaPrivateKey, RsaPublicKey, traits::PublicKeyParts};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::fmt;
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::Semaphore,
    time::Instant,
};
use zeroize::{Zeroize, Zeroizing};

/// Exact RSA-AES security type. No cross-mode fallback or RA2r is supported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum RsaAesSecurity {
    /// AES-128 authenticated records for the complete RFB session (type 5).
    Ra2 = 5,
    /// AES-256 authenticated records for the complete RFB session (type 129).
    Ra2_256 = 129,
    /// AES-128 authentication only; later traffic needs protective outer transport.
    Ra2ne = 6,
    /// AES-256 authentication only; later traffic needs protective outer transport.
    Ra2ne256 = 130,
}
impl RsaAesSecurity {
    fn bytes(self) -> usize {
        match self {
            Self::Ra2 | Self::Ra2ne => 16,
            Self::Ra2_256 | Self::Ra2ne256 => 32,
        }
    }
    fn full(self) -> bool {
        matches!(self, Self::Ra2 | Self::Ra2_256)
    }
    fn hash(self, first: &[u8], second: &[u8]) -> Vec<u8> {
        if self.bytes() == 16 {
            let mut h = Sha1::new();
            h.update(first);
            h.update(second);
            h.finalize().to_vec()
        } else {
            let mut h = Sha256::new();
            h.update(first);
            h.update(second);
            h.finalize().to_vec()
        }
    }
}

/// Mandatory caller-provided SHA256 of U32 bits || fixed-width RSA modulus || exponent.
/// Obtain this out of band; never create it from an untrusted connection as TOFU.
#[derive(Clone, Copy)]
pub struct RsaServerKeyPin([u8; 32]);
impl RsaServerKeyPin {
    /// Accept exactly one independently acquired full SHA256 pin.
    pub const fn new(sha256: [u8; 32]) -> Self {
        Self(sha256)
    }
}

/// Exact expected RSA-AES credential subtype; secret fields never implement Clone.
pub struct RsaAesCredentials {
    username: Option<Zeroizing<String>>,
    password: Zeroizing<String>,
}
impl fmt::Debug for RsaAesCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RsaAesCredentials([REDACTED])")
    }
}
fn valid(value: &str) -> bool {
    (1..=255).contains(&value.len()) && !value.as_bytes().contains(&0)
}
impl RsaAesCredentials {
    /// Password-only subtype 2, 1–255 exact UTF-8 bytes without NUL.
    pub fn password(password: String) -> Result<Self, Error> {
        Self::password_zeroizing(Zeroizing::new(password))
    }
    /// Transfer an already zeroizing password allocation without copying it.
    pub fn password_zeroizing(password: Zeroizing<String>) -> Result<Self, Error> {
        if !valid(&password) {
            return Err(Error::InvalidRsaAesCredential);
        }
        Ok(Self {
            username: None,
            password,
        })
    }
    /// Username/password subtype 1; each field is 1–255 UTF-8 bytes without NUL.
    pub fn username_password(username: String, password: String) -> Result<Self, Error> {
        Self::username_password_zeroizing(username, Zeroizing::new(password))
    }
    /// Transfer the password allocation and immediately zeroize the owned username.
    pub fn username_password_zeroizing(
        username: String,
        password: Zeroizing<String>,
    ) -> Result<Self, Error> {
        let username = Zeroizing::new(username);
        if !valid(&username) || !valid(&password) {
            return Err(Error::InvalidRsaAesCredential);
        }
        Ok(Self {
            username: Some(username),
            password,
        })
    }
    fn subtype(&self) -> u8 {
        if self.username.is_some() { 1 } else { 2 }
    }
    fn encode(&self) -> Zeroizing<Vec<u8>> {
        let username = self.username.as_deref().map_or("", String::as_str);
        let mut result = Zeroizing::new(Vec::with_capacity(512));
        result.push(username.len() as u8);
        result.extend_from_slice(username.as_bytes());
        result.push(self.password.len() as u8);
        result.extend_from_slice(self.password.as_bytes());
        result
    }
}

static CRYPTO: Semaphore = Semaphore::const_new(2);
async fn crypto<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    // Keep the permit in the CPU job even if the async waiter/stream is dropped.
    let permit = CRYPTO.try_acquire().map_err(|_| Error::ResourceLimit)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .map_err(|_| Error::InvalidRsaAesExchange)?
}
fn rng() -> Result<StdRng, Error> {
    StdRng::try_from_rng(&mut SysRng).map_err(|_| Error::Randomness)
}
fn wire(key: &RsaPublicKey) -> Result<Vec<u8>, Error> {
    let bits = key.n().bits();
    let size = key.size();
    let mut result = Vec::with_capacity(4 + size * 2);
    result.extend_from_slice(&bits.to_be_bytes());
    for component in [key.n().as_ref(), key.e()] {
        let encoded = component.to_be_bytes();
        if encoded.len() > size {
            return Err(Error::InvalidRsaAesExchange);
        }
        result.resize(result.len() + size - encoded.len(), 0);
        result.extend_from_slice(&encoded);
    }
    Ok(result)
}
async fn version<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S) -> Result<(), Error> {
    let mut banner = [0; 12];
    stream.read_exact(&mut banner).await?;
    if &banner != b"RFB 003.008\n" {
        return Err(Error::UnsupportedRfbVersion);
    }
    stream.write_all(&banner).await?;
    stream.flush().await?;
    Ok(())
}
async fn select<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    security: RsaAesSecurity,
) -> Result<(), Error> {
    let count = stream.read_u8().await?;
    if count == 0 {
        return Err(Error::ServerRejected);
    }
    let mut offered = vec![0; usize::from(count)];
    stream.read_exact(&mut offered).await?;
    if !offered.contains(&(security as u8)) {
        return Err(Error::UnsupportedSecurity);
    }
    stream.write_u8(security as u8).await?;
    stream.flush().await?;
    Ok(())
}
async fn server_key<S: AsyncRead + Unpin>(
    stream: &mut S,
    pin: RsaServerKeyPin,
) -> Result<(RsaPublicKey, Vec<u8>), Error> {
    let bits = stream.read_u32().await?;
    if !matches!(bits, 2048 | 3072 | 4096) {
        return Err(Error::InvalidRsaAesExchange);
    }
    let size = usize::try_from(bits / 8).map_err(|_| Error::InvalidRsaAesExchange)?;
    let mut raw = bits.to_be_bytes().to_vec();
    raw.resize(4 + size * 2, 0);
    stream
        .read_exact(raw.get_mut(4..).ok_or(Error::InvalidRsaAesExchange)?)
        .await?;
    let actual: [u8; 32] = Sha256::digest(&raw).into();
    if !bool::from(actual.ct_eq(&pin.0)) {
        return Err(Error::RsaServerKeyMismatch);
    }
    let (n, e) = raw
        .get(4..)
        .ok_or(Error::InvalidRsaAesExchange)?
        .split_at_checked(size)
        .ok_or(Error::InvalidRsaAesExchange)?;
    if n.first().ok_or(Error::InvalidRsaAesExchange)? & 0x80 == 0
        || n.last().ok_or(Error::InvalidRsaAesExchange)? & 1 == 0
    {
        return Err(Error::InvalidRsaAesExchange);
    }
    let n = BoxedUint::from_be_slice(n, bits).map_err(|_| Error::InvalidRsaAesExchange)?;
    let e = BoxedUint::from_be_slice(e, bits).map_err(|_| Error::InvalidRsaAesExchange)?;
    if e != BoxedUint::from(65537u32) {
        return Err(Error::InvalidRsaAesExchange);
    }
    let key =
        RsaPublicKey::new_with_max_size(n, e, 4096).map_err(|_| Error::InvalidRsaAesExchange)?;
    Ok((key, raw))
}
struct Exchange {
    private: RsaPrivateKey,
    wire: Vec<u8>,
    random: Zeroizing<Vec<u8>>,
    encrypted: Vec<u8>,
}
async fn prepare(server: RsaPublicKey, amount: usize) -> Result<Exchange, Error> {
    crypto(move || {
        let mut rng = rng()?;
        let private =
            RsaPrivateKey::new(&mut rng, 2048).map_err(|_| Error::InvalidRsaAesExchange)?;
        let wire = wire(&private.to_public_key())?;
        let mut random = Zeroizing::new(vec![0; amount]);
        getrandom::fill(&mut random).map_err(|_| Error::Randomness)?;
        let encrypted = server
            .encrypt(&mut rng, Pkcs1v15Encrypt, &random)
            .map_err(|_| Error::InvalidRsaAesExchange)?;
        Ok(Exchange {
            private,
            wire,
            random,
            encrypted,
        })
    })
    .await
}

pub(crate) async fn authenticate<S>(
    mut stream: S,
    security: RsaAesSecurity,
    credentials: RsaAesCredentials,
    pin: RsaServerKeyPin,
    deadline: Instant,
) -> Result<Authenticated<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
{
    phase(
        AuthenticationStage::RfbVersion,
        deadline,
        version(&mut stream),
    )
    .await?;
    phase(
        AuthenticationStage::SecurityNegotiation,
        deadline,
        select(&mut stream, security),
    )
    .await?;
    let (server, server_wire) = phase(
        AuthenticationStage::RsaAesAuthentication,
        deadline,
        server_key(&mut stream, pin),
    )
    .await?;
    let exchange = phase(
        AuthenticationStage::RsaAesAuthentication,
        deadline,
        prepare(server, security.bytes()),
    )
    .await?;
    phase(AuthenticationStage::RsaAesAuthentication, deadline, async {
        stream.write_all(&exchange.wire).await?;
        stream
            .write_u16(
                u16::try_from(exchange.encrypted.len())
                    .map_err(|_| Error::InvalidRsaAesExchange)?,
            )
            .await?;
        stream.write_all(&exchange.encrypted).await?;
        stream.flush().await?;
        Ok(())
    })
    .await?;
    let mut encrypted = vec![0; 256];
    phase(AuthenticationStage::RsaAesAuthentication, deadline, async {
        if stream.read_u16().await? != 256 {
            return Err(Error::InvalidRsaAesExchange);
        }
        stream.read_exact(&mut encrypted).await?;
        Ok(())
    })
    .await?;
    let Exchange {
        private,
        wire: client_wire,
        random: client_random,
        encrypted: _,
    } = exchange;
    let server_random = phase(
        AuthenticationStage::RsaAesAuthentication,
        deadline,
        crypto(move || {
            let mut rng = rng()?;
            let random = Zeroizing::new(
                private
                    .decrypt_blinded(&mut rng, Pkcs1v15Encrypt, &encrypted)
                    .map_err(|_| Error::InvalidRsaAesExchange)?,
            );
            if random.len() != security.bytes() {
                return Err(Error::InvalidRsaAesExchange);
            }
            Ok(random)
        }),
    )
    .await?;
    let mut tx = Zeroizing::new(security.hash(&server_random, &client_random));
    tx.get_mut(security.bytes()..)
        .ok_or(Error::InvalidRsaAesExchange)?
        .zeroize();
    tx.truncate(security.bytes());
    let mut rx = Zeroizing::new(security.hash(&client_random, &server_random));
    rx.get_mut(security.bytes()..)
        .ok_or(Error::InvalidRsaAesExchange)?
        .zeroize();
    rx.truncate(security.bytes());
    drop(client_random);
    drop(server_random);
    let mut stream = Records::new(stream, tx, rx);
    phase(AuthenticationStage::RsaAesAuthentication, deadline, async {
        stream
            .write_all(&security.hash(&client_wire, &server_wire))
            .await?;
        stream.flush().await?;
        let expected = security.hash(&server_wire, &client_wire);
        let mut proof = vec![0; expected.len()];
        stream.read_exact(&mut proof).await?;
        if !bool::from(proof.ct_eq(&expected)) {
            return Err(Error::InvalidRsaAesExchange);
        }
        if stream.read_u8().await? != credentials.subtype() {
            return Err(Error::InvalidRsaAesCredential);
        }
        let encoded = credentials.encode();
        stream.write_all(&encoded).await?;
        drop(encoded);
        drop(credentials);
        stream.flush().await?;
        Ok(())
    })
    .await?;
    let mut result = if security.full() {
        AuthenticatedStream::rsa_aes(stream)
    } else {
        AuthenticatedStream::rsa_aes_raw(stream.into_raw()?)
    };
    phase(
        AuthenticationStage::RsaAesAuthentication,
        deadline,
        read_security_result(&mut result),
    )
    .await?;
    Ok(Authenticated { stream: result })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn cancelled_waiters_do_not_release_running_crypto_job_capacity() {
        // Native task lifetime has no public socket observation once its waiter
        // is cancelled. Real blocking jobs use explicit test-owned completion gates.
        let (release_first, wait_first) = mpsc::channel();
        let (entered_first, started_first) = oneshot::channel();
        let first = tokio::spawn(crypto(move || {
            entered_first
                .send(())
                .map_err(|_| Error::InvalidRsaAesExchange)?;
            wait_first
                .recv()
                .map_err(|_| Error::InvalidRsaAesExchange)?;
            Ok(())
        }));
        let (release_second, wait_second) = mpsc::channel();
        let (entered_second, started_second) = oneshot::channel();
        let second = tokio::spawn(crypto(move || {
            entered_second
                .send(())
                .map_err(|_| Error::InvalidRsaAesExchange)?;
            wait_second
                .recv()
                .map_err(|_| Error::InvalidRsaAesExchange)?;
            Ok(())
        }));
        started_first.await.unwrap();
        started_second.await.unwrap();
        first.abort();
        second.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        assert!(second.await.unwrap_err().is_cancelled());
        assert!(matches!(crypto(|| Ok(())).await, Err(Error::ResourceLimit)));
        release_first.send(()).unwrap();
        release_second.send(()).unwrap();
        // Acquisition waits for actual native permit teardown, not elapsed time
        // or the already-cancelled async JoinHandles.
        let permits = tokio::time::timeout(Duration::from_secs(5), CRYPTO.acquire_many(2))
            .await
            .unwrap()
            .unwrap();
        drop(permits);
        assert!(crypto(|| Ok(())).await.is_ok());
    }
}
