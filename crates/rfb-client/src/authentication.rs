// VNC authentication flow adapted from vnc-rs at
// ab684d009d767c968af2f7559576334038623124 (MIT; see ../LICENSE-vnc-rs).
// DES is supplied by RustCrypto, not the upstream custom implementation.

use des::cipher::{Block, BlockCipherEncrypt, KeyInit};
use rustls::pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_rustls::TlsConnector;
use zeroize::Zeroizing;

use crate::{Authenticated, Error, TrustRoots, VncPassword};

const RFB_VERSION: &[u8; 12] = b"RFB 003.008\n";
const VENCRYPT: u8 = 19;
const X509_VNC: u32 = 261;
const MAX_ERROR_BYTES: u32 = 4096;

pub(crate) async fn authenticate<S>(
    mut stream: S,
    server_name: &str,
    password: VncPassword,
    roots: TrustRoots,
) -> Result<Authenticated<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let server_name = ServerName::try_from(server_name)
        .map_err(|_| Error::InvalidServerName)?
        .to_owned();
    let config = roots.into_config()?;
    let mut version = [0; 12];
    stream.read_exact(&mut version).await?;
    if &version != RFB_VERSION {
        return Err(Error::UnsupportedRfbVersion);
    }
    stream.write_all(RFB_VERSION).await?;
    stream.flush().await?;

    let count = stream.read_u8().await?;
    if count == 0 {
        discard_reason(&mut stream).await?;
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

    let mut stream = TlsConnector::from(config)
        .connect(server_name, stream)
        .await
        .map_err(Error::Tls)?;
    let mut challenge = [0; 16];
    stream.read_exact(&mut challenge).await?;
    // Erase password and DES key before awaiting the write or SecurityResult.
    let response = challenge_response(password, challenge);
    stream.write_all(&*response).await?;
    stream.flush().await?;
    drop(response);

    match stream.read_u32().await? {
        0 => Ok(Authenticated { stream }),
        1 => {
            discard_reason(&mut stream).await?;
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
