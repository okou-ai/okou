//! Verified connection setup shared by independent exec and managed sessions.

mod trust;

use runner_rpc_proto::ResponseWriter;
use russh::{
    ChannelMsg, Preferred, Sig, client,
    keys::{Algorithm, EcdsaCurve, HashAlg, PrivateKeyWithHashAlg},
};
use std::{
    borrow::Cow,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tokio::net::TcpStream;

use super::{
    FailureReason, Scope,
    authority::{Authority, PreparedAuth, PreparedCredential},
    io::{GuestIo, HostLease, SocketGuard, SshSocket},
    observation::Attempt,
    output::{Output, RemoteExit, Stream},
};
use crate::ids::RunId;

pub(super) struct Execution {
    pub(super) authority: Arc<Authority>,
    pub(super) run: RunId,
    pub(super) connection: uuid::Uuid,
    pub(super) lease: Arc<HostLease>,
    pub(super) credential: Arc<PreparedCredential>,
}

pub(super) struct Connected {
    pub(super) session: client::Handle<trust::HostTrust>,
    guard: SocketGuard,
}

impl Connected {
    pub(super) fn prepare_reuse(&self) -> std::io::Result<()> {
        // Small control packets on later channels must not wait for delayed ACKs.
        // Preserve the initial handshake/command's existing socket behavior.
        self.guard.enable_nodelay()
    }

    pub(super) fn close(&self) {
        // The library's detached I/O retains its host lease until socket release.
        self.guard.close();
    }
}

impl Execution {
    pub(super) async fn connect(
        self,
        stream: TcpStream,
        scope: &Scope,
        trust_scope: &Scope,
        config: client::Config,
        observation: &mut Attempt,
    ) -> Result<Connected, FailureReason> {
        let (stream, socket_guard) =
            SshSocket::new(stream, self.lease).map_err(|_| FailureReason::NetworkFailure)?;
        let handler = trust::HostTrust::new(
            self.authority,
            self.run,
            self.connection,
            Arc::clone(&self.credential),
            trust_scope.clone(),
        );
        let failure = Arc::clone(&handler.failure);
        let authority_pending = Arc::clone(&handler.authority_pending);
        let connection = scope
            .wait(client::connect_stream(Arc::new(config), stream, handler))
            .await;
        observation.connecting = !authority_pending.load(Ordering::Acquire);
        // TOFU may advance trust even when the following authentication fails.
        observation.generation = Some(
            self.credential
                .trust
                .lock()
                .map_err(|_| FailureReason::Protocol)?
                .generation,
        );
        let session = connection?.map_err(|_| {
            failure
                .lock()
                .ok()
                .and_then(|failure| *failure)
                .unwrap_or(FailureReason::Protocol)
        })?;
        let mut connected = Connected {
            session,
            guard: socket_guard,
        };
        let session = &mut connected.session;
        let authentication = match &self.credential.auth {
            PreparedAuth::Password(password) => scope
                .wait(
                    session
                        .authenticate_password(self.credential.username.clone(), password.expose()),
                )
                .await?
                .map_err(|_| FailureReason::AuthenticationFailed)?,
            PreparedAuth::PrivateKey(key) => {
                let hash = if matches!(key.0.algorithm(), Algorithm::Rsa { .. }) {
                    match scope
                        .wait(session.best_supported_rsa_hash())
                        .await?
                        .map_err(|_| FailureReason::Protocol)?
                    {
                        Some(Some(hash)) => Some(hash),
                        None => Some(HashAlg::Sha512),
                        Some(None) => return Err(FailureReason::AuthenticationFailed),
                    }
                } else {
                    None
                };
                scope
                    .wait(session.authenticate_publickey(
                        self.credential.username.clone(),
                        PrivateKeyWithHashAlg::new(Arc::clone(&key.0), hash),
                    ))
                    .await?
                    .map_err(|_| FailureReason::AuthenticationFailed)?
            }
        };
        if !authentication.success() {
            return Err(FailureReason::AuthenticationFailed);
        }
        observation.authenticated_at = Some(chrono::Utc::now());
        Ok(connected)
    }
}

impl Connected {
    pub(super) async fn execute(
        &self,
        command: String,
        scope: &Scope,
        writer: &mut ResponseWriter<GuestIo>,
        output: &mut Output,
    ) -> Result<RemoteExit, FailureReason> {
        let session = &self.session;
        let mut channel = scope
            .wait(session.channel_open_session())
            .await?
            .map_err(|_| FailureReason::Protocol)?;
        scope.check()?;
        // Sending the request, not receiving its acknowledgement, is the
        // ambiguity boundary. A failed write must never trigger replay.
        output.attempted();
        scope
            .wait(channel.exec(true, command))
            .await?
            .map_err(|_| FailureReason::Disconnected)?;
        scope
            .wait(channel.eof())
            .await?
            .map_err(|_| FailureReason::Disconnected)?;
        let mut exit = None;
        let mut eof = false;
        let mut flush_tick = tokio::time::interval(Duration::from_millis(250));
        flush_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let message = scope
                .wait(async {
                    tokio::select! {
                        biased;
                        _ = flush_tick.tick() => None,
                        message = channel.wait() => Some(message),
                    }
                })
                .await?;
            let Some(message) = message else {
                scope.wait(output.flush(writer)).await??;
                continue;
            };
            match message {
                Some(ChannelMsg::Success) if !output.is_accepted() => {
                    scope.wait(output.accept(writer)).await??;
                }
                Some(ChannelMsg::Failure) if !output.is_accepted() => {
                    output.rejected();
                    return Err(FailureReason::ExecRejected);
                }
                Some(ChannelMsg::Data { data }) if !eof => {
                    scope
                        .wait(output.data(writer, Stream::Stdout, &data))
                        .await??;
                }
                Some(ChannelMsg::ExtendedData { ext: 1, data }) if !eof => {
                    scope
                        .wait(output.data(writer, Stream::Stderr, &data))
                        .await??;
                }
                Some(ChannelMsg::ExitStatus { exit_status })
                    if output.is_accepted() && exit.is_none() =>
                {
                    exit = Some(RemoteExit::Status { code: exit_status });
                }
                Some(ChannelMsg::ExitSignal {
                    signal_name,
                    core_dumped,
                    ..
                }) if output.is_accepted() && exit.is_none() => {
                    exit = Some(RemoteExit::Signal {
                        signal: signal(&signal_name),
                        core_dumped,
                    });
                }
                Some(ChannelMsg::Eof) if !eof => eof = true,
                Some(ChannelMsg::Close) => return exit.ok_or(FailureReason::Disconnected),
                Some(ChannelMsg::WindowAdjusted { .. }) => (),
                None => return Err(FailureReason::Disconnected),
                _ => return Err(FailureReason::Protocol),
            }
        }
    }
}

pub(super) fn config() -> client::Config {
    client::Config {
        preferred: Preferred {
            kex: Cow::Borrowed(&[
                russh::kex::CURVE25519,
                russh::kex::CURVE25519_PRE_RFC_8731,
                russh::kex::DH_G14_SHA256,
                russh::kex::EXTENSION_SUPPORT_AS_CLIENT,
                russh::kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
            ]),
            key: Cow::Borrowed(&[
                Algorithm::Ed25519,
                Algorithm::Ecdsa {
                    curve: EcdsaCurve::NistP256,
                },
                Algorithm::Ecdsa {
                    curve: EcdsaCurve::NistP384,
                },
                Algorithm::Ecdsa {
                    curve: EcdsaCurve::NistP521,
                },
                Algorithm::Rsa {
                    hash: Some(HashAlg::Sha512),
                },
                Algorithm::Rsa {
                    hash: Some(HashAlg::Sha256),
                },
            ]),
            cipher: Cow::Borrowed(&[
                russh::cipher::CHACHA20_POLY1305,
                russh::cipher::AES_256_GCM,
                russh::cipher::AES_128_GCM,
                russh::cipher::AES_256_CTR,
                russh::cipher::AES_128_CTR,
            ]),
            mac: Cow::Borrowed(&[
                russh::mac::HMAC_SHA512_ETM,
                russh::mac::HMAC_SHA256_ETM,
                russh::mac::HMAC_SHA512,
                russh::mac::HMAC_SHA256,
            ]),
            ..Preferred::default()
        },
        window_size: 128 * 1024,
        maximum_packet_size: 32 * 1024,
        // Amortize task handoffs for fragmented output while retaining a
        // fixed queue bound. The advertised packet size is 32 KiB; russh's
        // hard transport cap also bounds packets from a nonconforming peer.
        channel_buffer_size: 64,
        inactivity_timeout: Some(Duration::from_secs(60)),
        ..client::Config::default()
    }
}

pub(super) fn signal(signal: &Sig) -> &'static str {
    match signal {
        Sig::ABRT => "ABRT",
        Sig::ALRM => "ALRM",
        Sig::FPE => "FPE",
        Sig::HUP => "HUP",
        Sig::ILL => "ILL",
        Sig::INT => "INT",
        Sig::KILL => "KILL",
        Sig::PIPE => "PIPE",
        Sig::QUIT => "QUIT",
        Sig::SEGV => "SEGV",
        Sig::TERM => "TERM",
        Sig::USR1 => "USR1",
        Sig::Custom(name) if name == "USR2" => "USR2",
        Sig::Custom(_) => "UNKNOWN",
    }
}
