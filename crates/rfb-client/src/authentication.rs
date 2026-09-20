// VNC authentication flow adapted from vnc-rs at
// ab684d009d767c968af2f7559576334038623124 (MIT; see ../LICENSE-vnc-rs).
// DES is supplied by RustCrypto, not the upstream custom implementation.

use std::future::Future;

use des::cipher::{Block, BlockCipherEncrypt, KeyInit};
use rustls::pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::time::Instant;
use tokio_rustls::TlsConnector;
use zeroize::Zeroizing;

use crate::{Authenticated, AuthenticationStage, Error, TrustRoots, VncPassword};

const RFB_VERSION: &[u8; 12] = b"RFB 003.008\n";
const VENCRYPT: u8 = 19;
const X509_VNC: u32 = 261;
const MAX_ERROR_BYTES: u32 = 4096;

pub(crate) async fn authenticate<S>(
    mut stream: S,
    server_name: &str,
    password: VncPassword,
    roots: TrustRoots,
    deadline: Instant,
) -> Result<Authenticated<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let server_name = ServerName::try_from(server_name)
        .map_err(|_| Error::InvalidServerName)?
        .to_owned();
    let config = roots.into_config()?;

    phase(
        AuthenticationStage::RfbVersion,
        deadline,
        exchange_version(&mut stream),
    )
    .await?;
    phase(
        AuthenticationStage::SecurityNegotiation,
        deadline,
        negotiate_security(&mut stream),
    )
    .await?;
    let mut stream = phase(AuthenticationStage::TlsHandshake, deadline, async {
        TlsConnector::from(config)
            .connect(server_name, stream)
            .await
            .map_err(Error::Tls)
    })
    .await?;
    phase(
        AuthenticationStage::VncAuthentication,
        deadline,
        authenticate_vnc(&mut stream, password),
    )
    .await?;

    Ok(Authenticated { stream })
}

async fn phase<T>(
    stage: AuthenticationStage,
    deadline: Instant,
    future: impl Future<Output = Result<T, Error>>,
) -> Result<T, Error> {
    let expired = || Error::AuthenticationDeadlineExceeded { stage };
    // timeout_at polls a ready future before its timer, so check both boundaries.
    if deadline <= Instant::now() {
        return Err(expired());
    }
    let value = tokio::time::timeout_at(deadline, future)
        .await
        .map_err(|_| expired())??;
    if deadline <= Instant::now() {
        return Err(expired());
    }
    Ok(value)
}

async fn exchange_version<S>(stream: &mut S) -> Result<(), Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut version = [0; 12];
    stream.read_exact(&mut version).await?;
    if &version != RFB_VERSION {
        return Err(Error::UnsupportedRfbVersion);
    }
    stream.write_all(RFB_VERSION).await?;
    stream.flush().await?;
    Ok(())
}

async fn negotiate_security<S>(stream: &mut S) -> Result<(), Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let count = stream.read_u8().await?;
    if count == 0 {
        discard_reason(stream).await?;
        return Err(Error::ServerRejected);
    }
    let mut types = vec![0; usize::from(count)];
    stream.read_exact(&mut types).await?;
    if !types.contains(&VENCRYPT) {
        return Err(Error::UnsupportedSecurity);
    }
    stream.write_u8(VENCRYPT).await?;
    stream.flush().await?;

    let mut version = [0; 2];
    stream.read_exact(&mut version).await?;
    if version != [0, 2] {
        return Err(Error::UnsupportedSecurity);
    }
    stream.write_all(&[0, 2]).await?;
    stream.flush().await?;
    if stream.read_u8().await? != 0 {
        return Err(Error::NegotiationRejected);
    }

    let count = stream.read_u8().await?;
    let mut offered = false;
    for _ in 0..count {
        offered |= stream.read_u32().await? == X509_VNC;
    }
    if !offered {
        return Err(Error::UnsupportedSecurity);
    }
    stream.write_u32(X509_VNC).await?;
    stream.flush().await?;
    if stream.read_u8().await? != 1 {
        return Err(Error::NegotiationRejected);
    }
    Ok(())
}

async fn authenticate_vnc<S>(
    stream: &mut tokio_rustls::client::TlsStream<S>,
    password: VncPassword,
) -> Result<(), Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut challenge = [0; 16];
    stream.read_exact(&mut challenge).await?;
    // Erase password and DES key before awaiting the write or SecurityResult.
    let response = challenge_response(password, challenge);
    stream.write_all(&*response).await?;
    stream.flush().await?;
    drop(response);

    match stream.read_u32().await? {
        0 => Ok(()),
        1 => {
            discard_reason(stream).await?;
            Err(Error::AuthenticationFailed)
        }
        _ => Err(Error::InvalidAuthenticationResult),
    }
}

async fn discard_reason<S: AsyncRead + Unpin>(stream: &mut S) -> Result<(), Error> {
    let length = stream.read_u32().await?;
    if length > MAX_ERROR_BYTES {
        return Err(Error::RemoteDataTooLarge);
    }
    // The peer controls this data: do not convert it to text or attach it to errors.
    let mut bytes = Zeroizing::new(vec![0; length as usize]);
    stream.read_exact(&mut bytes).await?;
    Ok(())
}

fn challenge_response(password: VncPassword, challenge: [u8; 16]) -> Zeroizing<[u8; 16]> {
    let mut key = Zeroizing::new([0u8; 8]);
    for (target, byte) in key.iter_mut().zip(password.0.iter()) {
        *target = byte.reverse_bits();
    }
    let cipher = des::Des::new((&*key).into());
    let mut response = Zeroizing::new(challenge);
    for chunk in response.as_chunks_mut::<8>().0 {
        let mut block = Block::<des::Des>::default();
        block.copy_from_slice(chunk);
        cipher.encrypt_block(&mut block);
        chunk.copy_from_slice(&block);
    }
    response
}
