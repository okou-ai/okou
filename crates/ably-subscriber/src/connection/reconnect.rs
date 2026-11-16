//! One reconnect acquisition transaction, before the reactor commits its result.
//!
//! The attempt reads committed session/configuration through borrowed inputs and
//! retains candidate tokens in the caller's retry slot and owns its temporary
//! transport. The event loop retains retry scheduling, cancellation selection,
//! session commits and transport installation.

use std::{collections::HashMap, time::Duration};

use futures_util::SinkExt;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite;

use super::auth::exchange_token;
use super::endpoint::build_ws_url;
use super::errors::{channel_detached_message, protocol_error_message};
use super::handshake::{
    AttachOutcome, encode_attach_for_channel, wait_for_attach_outcome, wait_for_connected,
};
use super::session::SessionState;
use super::transport::{TransportCloseTracker, WsTransport, connect_pending};
use crate::Error;
use crate::protocol::{ProtocolMessage, error_code};
use crate::types::{TimingConfig, TokenDetails, TokenFuture};

pub(super) struct ReconnectContext<'a> {
    pub(super) session: &'a SessionState,
    pub(super) channel: &'a str,
    pub(super) channel_params: Option<&'a HashMap<String, String>>,
    pub(super) realtime_host: &'a str,
    pub(super) rest_host: &'a str,
    pub(super) heartbeat_interval: Option<Duration>,
    pub(super) http: &'a reqwest::Client,
    pub(super) get_token: &'a (dyn Fn() -> TokenFuture + Send + Sync),
    pub(super) timing: &'a TimingConfig,
    pub(super) transport_close_tracker: &'a TransportCloseTracker,
}

pub(super) enum ReconnectOutcome {
    Attached {
        connected_msg: ProtocolMessage,
        channel_serial: Option<String>,
        token: Option<TokenDetails>,
        transport: WsTransport,
    },
    ChannelSuspended {
        connected_msg: ProtocolMessage,
        token: Option<TokenDetails>,
        transport: WsTransport,
    },
    Closed,
}

pub(super) struct PendingReconnectToken {
    details: TokenDetails,
    renewal_at: Option<Instant>,
}

/// Attempt a single reconnect (resume or fresh).
///
/// Reconnect setup through sending the channel `ATTACH` is bounded by
/// `timing.reconnect_timeout`. Waiting for the attach outcome is then separately
/// bounded by `timing.realtime_request_timeout`.
///
/// Connection mutations are deferred until the transport is connected and the
/// channel attach attempt has produced a definitive outcome. If the server
/// responds DETACHED to the ATTACH, the connected transport is kept and the
/// caller moves the channel into suspended retry, matching ably-js.
pub(super) async fn attempt_reconnect(
    p: ReconnectContext<'_>,
    refresh_token: &mut bool,
    pending_reconnect_token: &mut Option<PendingReconnectToken>,
) -> Result<ReconnectOutcome, Error> {
    let reconnect_timeout = p.timing.reconnect_timeout;
    let reconnect_setup = tokio::time::timeout(reconnect_timeout, async {
        let use_resume = p.session.can_resume();
        let use_pending_token = *refresh_token || !use_resume;

        let active_token = if use_pending_token {
            if pending_reconnect_token.as_ref().is_some_and(|pending| {
                pending
                    .renewal_at
                    .is_some_and(|renewal_at| renewal_at <= Instant::now())
            }) {
                pending_reconnect_token.take();
            }

            let pending = match pending_reconnect_token {
                Some(pending) => pending,
                None => {
                    let token_request = (p.get_token)().await.map_err(Error::TokenFetch)?;
                    let details = exchange_token(p.http, &token_request, p.rest_host).await?;
                    let renewal_at = super::state::ConnState::compute_renewal_at(
                        &details,
                        p.timing.token_renewal_margin,
                    );
                    pending_reconnect_token.insert(PendingReconnectToken {
                        details,
                        renewal_at,
                    })
                }
            };
            pending.details.token.clone()
        } else {
            p.session.token().to_string()
        };

        let resume = if use_resume {
            p.session.connection_key().map(str::to_string)
        } else {
            None
        };

        let ws_url = build_ws_url(
            p.realtime_host,
            &active_token,
            resume.as_deref(),
            p.heartbeat_interval,
        )?;
        let mut transport = connect_pending(
            &ws_url,
            p.timing.close_timeout,
            p.transport_close_tracker.clone(),
        )
        .await?;

        let connected_msg = wait_for_connected(&mut transport).await?;

        let resumed = use_resume
            && connected_msg.connection_id.as_deref() == p.session.connection_id()
            && connected_msg.error.is_none();

        // Always re-attach the channel, even after a successful connection resume.
        // The server may silently lose channel state without sending DETACHED,
        // creating a "zombie subscription" where messages stop being delivered.
        // ATTACH is idempotent — the server responds with ATTACHED regardless.
        //
        // This matches ably-js behavior: `Channels.onTransportActive()` calls
        // `channel.requestState('attaching')` for every attached channel whenever
        // a transport becomes active, including after resume.
        // See: ably-js/src/common/lib/client/baserealtime.ts
        if resumed {
            tracing::info!(
                channel_serial = ?p.session.channel_serial(),
                "Connection resumed, re-attaching channel to verify state",
            );
        } else {
            tracing::info!("Fresh connect, attaching channel");
        }
        let data = encode_attach_for_channel(
            p.channel,
            p.channel_params,
            p.session.channel_serial(),
            p.session.attach_mode(),
        )?;
        transport
            .write_mut()?
            .send(tungstenite::Message::Binary(data.into()))
            .await?;

        let new_token = if use_pending_token {
            pending_reconnect_token
                .as_ref()
                .map(|pending| pending.details.clone())
        } else {
            None
        };
        Ok::<_, Error>((connected_msg, transport, new_token))
    })
    .await
    .map_err(|_| Error::Protocol {
        code: error_code::TIMEOUT,
        message: "Reconnect attempt timed out".to_string(),
    })?;
    let (connected_msg, mut transport, new_token) = match reconnect_setup {
        Ok(setup) => setup,
        Err(error) => {
            if matches!(
                &error,
                Error::Protocol { code, .. } if error_code::is_token_error(*code)
            ) {
                *refresh_token = true;
                pending_reconnect_token.take();
            }
            return Err(error);
        }
    };

    let attach_outcome = match tokio::time::timeout(p.timing.realtime_request_timeout, async {
        loop {
            match wait_for_attach_outcome(&mut transport, p.channel).await? {
                AttachOutcome::RetryAttach(err) => {
                    tracing::warn!(
                        code = err.code,
                        message = %protocol_error_message(err.message),
                        "Channel attach was superseded while re-attaching after reconnect; retrying attach",
                    );
                    let data = encode_attach_for_channel(
                        p.channel,
                        p.channel_params,
                        p.session.channel_serial(),
                        p.session.attach_mode(),
                    )?;
                    transport
                        .write_mut()?
                        .send(tungstenite::Message::Binary(data.into()))
                        .await?;
                }
                outcome => return Ok::<_, Error>(outcome),
            }
        }
    })
    .await
    {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(error)) => {
            if matches!(
                &error,
                Error::Protocol { code, .. } if error_code::is_token_error(*code)
            ) {
                *refresh_token = true;
                pending_reconnect_token.take();
            }
            return Err(error);
        }
        Err(_) => AttachOutcome::TimedOut,
    };

    let attached_channel_serial = match attach_outcome {
        AttachOutcome::Attached { channel_serial } => Some(channel_serial),
        AttachOutcome::Detached(err) => {
            if error_code::is_token_error(err.code) {
                *refresh_token = true;
                pending_reconnect_token.take();
                return Err(Error::Protocol {
                    code: err.code,
                    message: protocol_error_message(err.message),
                });
            }
            tracing::warn!(
                reason = %channel_detached_message(&err.message),
                "Channel detached while re-attaching after reconnect",
            );
            None
        }
        AttachOutcome::RetryAttach(err) => {
            return Err(Error::Protocol {
                code: err.code,
                message: protocol_error_message(err.message),
            });
        }
        AttachOutcome::Closed(err) => {
            tracing::info!(
                code = err.code,
                message = %protocol_error_message(err.message),
                "Connection closed while re-attaching after reconnect",
            );
            return Ok(ReconnectOutcome::Closed);
        }
        AttachOutcome::TimedOut => {
            tracing::warn!(
                timeout_ms = p.timing.realtime_request_timeout.as_millis(),
                "Channel attach timed out while re-attaching after reconnect",
            );
            None
        }
    };

    let transport = transport.into_transport()?;
    if new_token.is_some() {
        pending_reconnect_token.take();
    }
    Ok(match attached_channel_serial {
        Some(channel_serial) => ReconnectOutcome::Attached {
            connected_msg,
            channel_serial,
            token: new_token,
            transport,
        },
        None => ReconnectOutcome::ChannelSuspended {
            connected_msg,
            token: new_token,
            transport,
        },
    })
}
