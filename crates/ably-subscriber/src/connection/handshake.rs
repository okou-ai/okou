use std::collections::HashMap;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite;

use crate::protocol::{
    AttachMode, ErrorInfo, ProtocolMessage, action, build_attach_msg, decode_msg, encode_msg,
    error_code,
};
use crate::types::{Error, TimingConfig, TokenDetails};

use super::endpoint::build_ws_url;
use super::errors::{
    channel_detached_message, error_or_unknown, protocol_disconnect_reason, protocol_error_message,
};
use super::state::ConnState;
use super::transport::{
    PendingWsTransport, TransportCloseTracker, WsTransport, WsWrite, connect_pending,
};

pub(super) async fn send_protocol_pong(
    ws_write: &mut WsWrite,
    id: Option<String>,
) -> Result<(), Error> {
    let pong = ProtocolMessage {
        action: action::PONG,
        id,
        ..Default::default()
    };
    ws_write
        .send(tungstenite::Message::Binary(encode_msg(&pong)?.into()))
        .await?;
    Ok(())
}

pub(super) async fn wait_for_connected(
    transport: &mut PendingWsTransport,
) -> Result<ProtocolMessage, Error> {
    while let Some(frame) = transport.read_mut()?.next().await {
        let frame = frame?;
        if let tungstenite::Message::Binary(data) = frame {
            let msg = decode_msg(&data)?;
            match msg.action {
                action::CONNECTED => return Ok(msg),
                action::PING => send_protocol_pong(transport.write_mut()?, msg.id).await?,
                action::PONG => {}
                action::ERROR => {
                    let err = error_or_unknown(msg.error);
                    return Err(Error::Protocol {
                        code: err.code,
                        message: protocol_error_message(err.message),
                    });
                }
                action::DISCONNECTED => {
                    let err = error_or_unknown(msg.error);
                    return Err(Error::Protocol {
                        code: err.code,
                        message: protocol_error_message(err.message),
                    });
                }
                _ => {
                    tracing::info!(action = msg.action, "Ignoring pre-CONNECTED message");
                }
            }
        }
    }
    Err(Error::Protocol {
        code: error_code::FAILED,
        message: "Connection closed before CONNECTED received".to_string(),
    })
}

pub(super) enum AttachOutcome {
    Attached { channel_serial: Option<String> },
    Detached(ErrorInfo),
    RetryAttach(ErrorInfo),
    Closed(ErrorInfo),
    TimedOut,
}

fn detached_error_or_default(error: Option<ErrorInfo>) -> ErrorInfo {
    error.unwrap_or_else(|| ErrorInfo {
        code: error_code::CHANNEL_OPERATION_FAILED,
        status_code: Some(404),
        message: "Channel detached".to_string(),
    })
}

fn closed_error_or_default(error: Option<ErrorInfo>) -> ErrorInfo {
    error.unwrap_or_else(|| ErrorInfo {
        code: error_code::FAILED,
        status_code: None,
        message: "Connection closed by server".to_string(),
    })
}

pub(super) async fn wait_for_attach_outcome(
    transport: &mut PendingWsTransport,
    channel: &str,
) -> Result<AttachOutcome, Error> {
    while let Some(frame) = transport.read_mut()?.next().await {
        let frame = frame?;
        if let tungstenite::Message::Binary(data) = frame {
            let msg = decode_msg(&data)?;
            match msg.action {
                action::PING => send_protocol_pong(transport.write_mut()?, msg.id).await?,
                action::PONG => {}
                action::ATTACHED => {
                    if msg.channel.as_deref() == Some(channel) {
                        return Ok(AttachOutcome::Attached {
                            channel_serial: msg.channel_serial,
                        });
                    }
                }
                action::ERROR => {
                    let err = error_or_unknown(msg.error);
                    if let Some(msg_channel) = msg.channel.as_deref() {
                        if msg_channel != channel {
                            continue;
                        }
                        if err.code == 80016 {
                            return Ok(AttachOutcome::RetryAttach(err));
                        }
                    }
                    return Err(Error::Protocol {
                        code: err.code,
                        message: protocol_error_message(err.message),
                    });
                }
                action::DETACHED => {
                    if msg.channel.as_deref() == Some(channel) {
                        return Ok(AttachOutcome::Detached(detached_error_or_default(
                            msg.error,
                        )));
                    }
                }
                action::DISCONNECTED => {
                    let err = error_or_unknown(msg.error.clone());
                    return Err(Error::Protocol {
                        code: err.code,
                        message: protocol_disconnect_reason(msg.error),
                    });
                }
                action::CLOSED => {
                    return Ok(AttachOutcome::Closed(closed_error_or_default(msg.error)));
                }
                _ => {
                    tracing::info!(action = msg.action, "Ignoring pre-ATTACHED message");
                }
            }
        }
    }
    Err(Error::Protocol {
        code: error_code::CHANNEL_OPERATION_FAILED,
        message: "Connection closed before ATTACHED received".to_string(),
    })
}

async fn wait_for_attached(
    transport: &mut PendingWsTransport,
    channel: &str,
) -> Result<Option<String>, Error> {
    match wait_for_attach_outcome(transport, channel).await? {
        AttachOutcome::Attached { channel_serial } => Ok(channel_serial),
        AttachOutcome::Detached(err) => Err(Error::Protocol {
            code: err.code,
            message: channel_detached_message(&err.message),
        }),
        AttachOutcome::RetryAttach(err) => Err(Error::Protocol {
            code: err.code,
            message: protocol_error_message(err.message),
        }),
        AttachOutcome::Closed(err) => Err(Error::Protocol {
            code: err.code,
            message: protocol_error_message(err.message),
        }),
        AttachOutcome::TimedOut => Err(Error::Protocol {
            code: error_code::TIMEOUT,
            message: "Channel attach timed out".to_string(),
        }),
    }
}

pub(super) fn encode_attach_for_channel(
    channel: &str,
    channel_params: Option<&HashMap<String, String>>,
    channel_serial: Option<&str>,
    attach_mode: AttachMode,
) -> Result<Vec<u8>, Error> {
    let attach = build_attach_msg(channel, channel_params, channel_serial, attach_mode);
    encode_msg(&attach)
}

pub(crate) async fn connect_and_attach(
    realtime_host: &str,
    token: TokenDetails,
    channel: &str,
    channel_params: Option<&HashMap<String, String>>,
    heartbeat_interval: Option<std::time::Duration>,
    timing: &TimingConfig,
    close_tracker: TransportCloseTracker,
) -> Result<(WsTransport, ConnState), Error> {
    let ws_url = build_ws_url(realtime_host, &token.token, None, heartbeat_interval)?;
    let mut transport = connect_pending(&ws_url, timing.close_timeout, close_tracker).await?;
    let connected_msg = wait_for_connected(&mut transport).await?;
    let mut conn_state = ConnState::from_connected(&connected_msg, token, timing);
    let encoded = encode_attach_for_channel(channel, channel_params, None, AttachMode::Clean)?;
    transport
        .write_mut()?
        .send(tungstenite::Message::Binary(encoded.into()))
        .await?;
    conn_state.channel_serial = wait_for_attached(&mut transport, channel).await?;
    Ok((transport.into_transport()?, conn_state))
}
