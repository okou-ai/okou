//! Explicit QEMU263/GSSAPI, distinct from SCRAM and every saved/API profile.
use crate::{
    Authenticated, AuthenticatedStream, AuthenticationStage, Error, TrustRoots, authentication,
    qemu_sasl,
};
use kerberos_worker::{Credentials, KdcExchange, TicketPolicy};
use std::{path::PathBuf, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    time::Instant,
};

/// Caller-owned source, private resource root and finite Run/session policy.
/// Neither the TCP hostname nor TLS name implicitly chooses the Kerberos target.
pub struct QemuGssapiAuthentication {
    pub credentials: Credentials,
    pub ticket_policy: TicketPolicy,
    pub private_root: PathBuf,
    pub expires_at: Instant,
}

/// Consume the supplied original stream. Verify exact X509263 TLS before native
/// credential delivery/acquisition or any reusable GSS token. No destination I/O
/// is performed here; KDC I/O requires the separate checked caller interface.
/// Cancellation drops the TLS stream and supervises native kill/wait/cleanup.
pub async fn authenticate_qemu_gssapi<S, K>(
    stream: S,
    server_name: &str,
    roots: TrustRoots,
    selected: QemuGssapiAuthentication,
    caller: &mut K,
    deadline: Instant,
) -> Result<Authenticated<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
    K: KdcExchange,
{
    let deadline = deadline
        .min(Instant::now() + crate::MAX_HANDSHAKE_DURATION)
        .min(selected.expires_at);
    let config = roots.into_config()?;
    let mut stream =
        authentication::verified_tls(stream, server_name, 263, config, deadline).await?;
    let expires_at = authentication::phase(
        AuthenticationStage::QemuGssapiAuthentication,
        deadline,
        async {
            let size = stream.read_u32().await?;
            if !(1..=4096).contains(&size) {
                return Err(Error::InvalidKerberosExchange);
            }
            let mut offers =
                vec![0; usize::try_from(size).map_err(|_| Error::InvalidKerberosExchange)?];
            stream.read_exact(&mut offers).await?;
            if !offers.split(|b| *b == b',').all(|name| {
                !name.is_empty()
                    && name.len() <= 100
                    && name.iter().all(|b| {
                        b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'-' || *b == b'_'
                    })
            }) || !offers.split(|b| *b == b',').any(|name| name == b"GSSAPI")
            {
                return Err(Error::InvalidKerberosExchange);
            }
            let online = selected.credentials.is_online();
            let (mut native, mut status) = kerberos_worker::open(
                &selected.private_root,
                selected.credentials,
                selected.ticket_policy,
                deadline,
                caller,
            )
            .await
            .map_err(native_error)?;
            // One eligible pre-auth renewal only. It never extends an already
            // established GSS/RFB context or retries uncertain delivery.
            if online && status.renewable && status.expires_at < deadline {
                status = native.renew(caller).await.map_err(native_error)?;
            }
            let mut expires_at = selected
                .expires_at
                .min(status.expires_at)
                .min(Instant::now() + Duration::from_secs(7200));
            // The acquired ticket can expire before the original handshake/Run
            // deadline. Bound every subsequent wait, authority check and send;
            // an unresponsive peer must not keep that authentication alive.
            let first = authentication::phase(
                AuthenticationStage::QemuGssapiAuthentication,
                deadline.min(expires_at),
                async { native.step(None, caller).await.map_err(native_error) },
            )
            .await?;
            if first.complete || first.token.as_ref().is_none_or(|token| token.is_empty()) {
                return Err(Error::InvalidKerberosExchange);
            }
            let mut total = 6usize
                .checked_add(first.token.as_ref().map_or(0, |token| token.len() + 1))
                .filter(|total| *total <= 128 * 1024)
                .ok_or(Error::InvalidKerberosExchange)?;
            authentication::phase(
                AuthenticationStage::QemuGssapiAuthentication,
                deadline.min(expires_at),
                async {
                    caller.authorize().await.map_err(native_error)?;
                    stream.write_u32(6).await?;
                    stream.write_all(b"GSSAPI").await?;
                    // Mechanism serialization can await and is not a reusable token.
                    // Recheck current authority at the first AP-REQ send boundary.
                    caller.authorize().await.map_err(native_error)?;
                    qemu_sasl::write_blob(&mut stream, first.token.as_deref().map(Vec::as_slice))
                        .await
                        .map_err(wire_error)
                },
            )
            .await?;
            let mut context_complete = false;
            let mut selected_layer = false;
            for _ in 0..16 {
                let (token, complete) = authentication::phase(
                    AuthenticationStage::QemuGssapiAuthentication,
                    deadline.min(expires_at),
                    async {
                        qemu_sasl::read_blob(&mut stream, &mut total)
                            .await
                            .map_err(wire_error)
                    },
                )
                .await?;
                if complete {
                    if !selected_layer || token.as_ref().is_some_and(|bytes| !bytes.is_empty()) {
                        return Err(Error::InvalidKerberosExchange);
                    }
                    authentication::phase(
                        AuthenticationStage::QemuGssapiAuthentication,
                        deadline.min(expires_at),
                        async {
                            caller.authorize().await.map_err(native_error)?;
                            authentication::read_security_result(&mut stream).await?;
                            native.close().await.map_err(native_error)
                        },
                    )
                    .await?;
                    return Ok(expires_at);
                }
                if selected_layer {
                    return Err(Error::InvalidKerberosExchange);
                }
                let token = token
                    .filter(|bytes| !bytes.is_empty())
                    .ok_or(Error::InvalidKerberosExchange)?;
                let answer = authentication::phase(
                    AuthenticationStage::QemuGssapiAuthentication,
                    deadline.min(expires_at),
                    async {
                        if !context_complete {
                            let step = native
                                .step(Some(token), caller)
                                .await
                                .map_err(native_error)?;
                            if step.complete {
                                context_complete = true;
                                expires_at = expires_at.min(step.expires_at);
                            }
                            Ok(step.token)
                        } else {
                            let answer = native
                                .select_no_layer(token, caller)
                                .await
                                .map_err(native_error)?;
                            selected_layer = true;
                            Ok(Some(answer))
                        }
                    },
                )
                .await?;
                let bytes = answer.as_ref().map_or(0, |bytes| bytes.len() + 1);
                total = total
                    .checked_add(bytes)
                    .filter(|n| *n <= 128 * 1024)
                    .ok_or(Error::InvalidKerberosExchange)?;
                authentication::phase(
                    AuthenticationStage::QemuGssapiAuthentication,
                    deadline.min(expires_at),
                    async {
                        caller.authorize().await.map_err(native_error)?;
                        qemu_sasl::write_blob(&mut stream, answer.as_deref().map(Vec::as_slice))
                            .await
                            .map_err(wire_error)
                    },
                )
                .await?;
            }
            Err(Error::InvalidKerberosExchange)
        },
    )
    .await?;
    if expires_at <= Instant::now() {
        return Err(Error::Kerberos(kerberos_worker::Error::Expired));
    }
    Ok(Authenticated {
        stream: AuthenticatedStream::verified_gssapi(stream, expires_at),
    })
}
fn native_error(error: kerberos_worker::Error) -> Error {
    match error {
        // The nested native/caller timer can become ready before phase's outer
        // timer is polled. Preserve the public RFB deadline/stage classification.
        kerberos_worker::Error::Deadline => Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::QemuGssapiAuthentication,
        },
        other => Error::Kerberos(other),
    }
}
fn wire_error(error: Error) -> Error {
    match error {
        Error::InvalidScramExchange => Error::InvalidKerberosExchange,
        other => other,
    }
}
