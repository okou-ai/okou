// VNC authentication flow adapted from vnc-rs at
// ab684d009d767c968af2f7559576334038623124 (MIT; see ../LICENSE-vnc-rs).
// DES is supplied by RustCrypto, not the upstream custom implementation.

use std::{future::Future, sync::Arc};

use des::cipher::{Block, BlockCipherEncrypt, KeyInit};
use rustls::{ClientConfig, pki_types::ServerName};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::time::Instant;
use tokio_rustls::TlsConnector;
use zeroize::Zeroizing;

use crate::{
    Authenticated, AuthenticatedStream, AuthenticationStage, ClientCertificateAuthentication,
    ClientIdentity, Error, PlainCredentials, TrustRoots, VncPassword, X509Authentication,
    qemu_sasl, trust::ClientAuthSelection,
};

const RFB_VERSION: &[u8; 12] = b"RFB 003.008\n";
const VENCRYPT: u8 = 19;
const MAX_ERROR_BYTES: u32 = 4096;

pub(crate) async fn authenticate<S>(
    stream: S,
    server_name: &str,
    authentication: X509Authentication,
    roots: TrustRoots,
    deadline: Instant,
) -> Result<Authenticated<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let config = roots.into_config()?;
    authenticate_with_config(stream, server_name, authentication, config, None, deadline).await
}

pub(crate) async fn authenticate_with_client_certificate<S>(
    stream: S,
    server_name: &str,
    authentication: ClientCertificateAuthentication,
    roots: TrustRoots,
    identity: ClientIdentity,
    deadline: Instant,
) -> Result<Authenticated<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (config, selection) = roots.into_client_auth_config(identity)?;
    let authentication = match authentication {
        ClientCertificateAuthentication::None => X509Authentication::None,
        ClientCertificateAuthentication::VncPassword(password) => {
            X509Authentication::VncPassword(password)
        }
    };
    authenticate_with_config(
        stream,
        server_name,
        authentication,
        config,
        Some(selection),
        deadline,
    )
    .await
}

async fn authenticate_with_config<S>(
    stream: S,
    server_name: &str,
    authentication: X509Authentication,
    config: Arc<ClientConfig>,
    client_auth: Option<Arc<ClientAuthSelection>>,
    deadline: Instant,
) -> Result<Authenticated<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut stream = verified_tls(
        stream,
        server_name,
        authentication.subtype(),
        config,
        deadline,
    )
    .await?;
    // No password or SecurityResult may be processed for a required-client-cert
    // profile unless this *handshake* received a request and selected the key.
    if let Some(selection) = client_auth {
        selection.require_selected()?;
    }
    let stage = authentication.stage();
    phase(
        stage,
        deadline,
        authenticate_x509(&mut stream, authentication),
    )
    .await?;

    Ok(Authenticated {
        stream: AuthenticatedStream::verified_tls(stream),
    })
}

pub(crate) async fn verified_tls<S>(
    mut stream: S,
    server_name: &str,
    subtype: u32,
    config: Arc<ClientConfig>,
    deadline: Instant,
) -> Result<tokio_rustls::client::TlsStream<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let server_name = ServerName::try_from(server_name)
        .map_err(|_| Error::InvalidServerName)?
        .to_owned();
    phase(
        AuthenticationStage::RfbVersion,
        deadline,
        exchange_version(&mut stream),
    )
    .await?;
    phase(
        AuthenticationStage::SecurityNegotiation,
        deadline,
        negotiate_security(&mut stream, subtype),
    )
    .await?;
    phase(AuthenticationStage::TlsHandshake, deadline, async {
        TlsConnector::from(config)
            .connect(server_name, stream)
            .await
            .map_err(Error::Tls)
    })
    .await
}

pub(crate) async fn phase<T>(
    stage: AuthenticationStage,
    deadline: Instant,
    future: impl Future<Output = Result<T, Error>>,
) -> Result<T, Error> {
    let expired = || Error::AuthenticationDeadlineExceeded { stage };
    // timeout_at polls a ready future before its timer. Guard EVERY poll, not
    // just entry/result: a pending authority/IO gate can become ready at expiry
    // and otherwise send credential bytes before the final check rejects it.
    if deadline <= Instant::now() {
        return Err(expired());
    }
    let mut future = std::pin::pin!(future);
    let guarded = std::future::poll_fn(|cx| {
        if deadline <= Instant::now() {
            return std::task::Poll::Ready(Err(expired()));
        }
        future.as_mut().poll(cx)
    });
    let value = tokio::time::timeout_at(deadline, guarded)
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

async fn negotiate_security<S>(stream: &mut S, subtype: u32) -> Result<(), Error>
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
        offered |= stream.read_u32().await? == subtype;
    }
    if !offered {
        return Err(Error::UnsupportedSecurity);
    }
    stream.write_u32(subtype).await?;
    stream.flush().await?;
    if stream.read_u8().await? != 1 {
        return Err(Error::NegotiationRejected);
    }
    Ok(())
}

async fn authenticate_x509<S>(
    stream: &mut tokio_rustls::client::TlsStream<S>,
    authentication: X509Authentication,
) -> Result<(), Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    match authentication {
        X509Authentication::None => read_security_result(stream).await,
        X509Authentication::VncPassword(password) => authenticate_vnc(stream, password).await,
        X509Authentication::Plain(credentials) => authenticate_plain(stream, credentials).await,
        X509Authentication::QemuScramSha256(credentials) => {
            qemu_sasl::authenticate(stream, credentials).await
        }
    }
}

pub(crate) async fn authenticate_vnc<S>(stream: &mut S, password: VncPassword) -> Result<(), Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    authenticate_vnc_with_result(stream, password, false).await
}

pub(crate) async fn authenticate_apple_vnc<S>(
    stream: &mut S,
    password: VncPassword,
) -> Result<(), Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    authenticate_vnc_with_result(stream, password, true).await
}

async fn authenticate_vnc_with_result<S>(
    stream: &mut S,
    password: VncPassword,
    apple_classic: bool,
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

    read_security_result_with_apple_classic(stream, apple_classic).await
}

async fn authenticate_plain<S>(
    stream: &mut tokio_rustls::client::TlsStream<S>,
    credentials: PlainCredentials,
) -> Result<(), Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let username_length =
        u32::try_from(credentials.username.len()).map_err(|_| Error::InvalidPlainUsername)?;
    let password_length =
        u32::try_from(credentials.password.len()).map_err(|_| Error::InvalidPlainPassword)?;
    stream.write_u32(username_length).await?;
    stream.write_u32(password_length).await?;
    stream.write_all(&credentials.username).await?;
    stream.write_all(&credentials.password).await?;
    stream.flush().await?;
    // Erase both fields before waiting for a potentially silent peer result.
    drop(credentials);
    read_security_result(stream).await
}

pub(crate) async fn read_security_result<S>(stream: &mut S) -> Result<(), Error>
where
    S: AsyncRead + Unpin,
{
    read_security_result_with_apple_classic(stream, false).await
}

async fn read_security_result_with_apple_classic<S>(
    stream: &mut S,
    apple_classic: bool,
) -> Result<(), Error>
where
    S: AsyncRead + Unpin,
{
    match stream.read_u32().await? {
        0 => Ok(()),
        1 => {
            discard_reason(stream).await?;
            Err(Error::AuthenticationFailed)
        }
        // Real macOS ARD classic type 2 sends failure 01 00 00 00, followed by
        // a network-order reason length. This exception is rejection-only and
        // must not change the standard/TLS profiles or accept a nonzero result.
        0x0100_0000 if apple_classic => {
            discard_reason(stream).await?;
            Err(Error::AuthenticationFailed)
        }
        _ => Err(Error::InvalidAuthenticationResult),
    }
}

pub(crate) async fn discard_reason<S: AsyncRead + Unpin>(stream: &mut S) -> Result<(), Error> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn a_pending_phase_never_repolls_ready_secret_output_at_its_deadline() {
        use std::{task::Poll, time::Duration};
        let (mut output, mut peer) = tokio::io::duplex(16);
        let (released, gate) = tokio::sync::oneshot::channel();
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut authentication = Box::pin(phase(
            AuthenticationStage::QemuGssapiAuthentication,
            deadline,
            async move {
                gate.await.unwrap();
                output.write_u8(1).await?;
                Ok(())
            },
        ));
        // Arm both the real phase timer and the external authority/IO gate.
        std::future::poll_fn(|cx| {
            assert!(authentication.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        tokio::time::advance(Duration::from_secs(1)).await;
        released.send(()).unwrap();
        let result = authentication.as_mut().await;
        drop(authentication);
        assert!(matches!(
            result,
            Err(Error::AuthenticationDeadlineExceeded {
                stage: AuthenticationStage::QemuGssapiAuthentication
            })
        ));
        // An error returned after sending the byte would not enforce expiry.
        assert_eq!(
            peer.read_u8().await.unwrap_err().kind(),
            std::io::ErrorKind::UnexpectedEof
        );
    }

    #[tokio::test]
    async fn standard_result_never_reinterprets_apple_classic_failure() {
        let (mut client, mut server) = tokio::io::duplex(16);
        server.write_all(&[1, 0, 0, 0]).await.unwrap();
        assert!(matches!(
            read_security_result(&mut client).await,
            Err(Error::InvalidAuthenticationResult)
        ));
    }
}
