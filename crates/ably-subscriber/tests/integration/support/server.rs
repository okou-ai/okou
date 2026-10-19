use ably_subscriber::protocol::{ConnectionDetails, ProtocolMessage, action, encode_msg};
use futures_util::SinkExt;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite;

use super::protocol::expect_protocol_msg;

pub(crate) struct MockAblyServer {
    pub(crate) listener: TcpListener,
    pub(crate) port: u16,
}

pub(crate) type WsStream = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

pub(crate) struct HandshakeOptions {
    pub(crate) max_idle_interval_ms: i64,
    pub(crate) connection_state_ttl_ms: i64,
    pub(crate) attached_channel_serial: Option<&'static str>,
}

impl Default for HandshakeOptions {
    fn default() -> Self {
        Self {
            max_idle_interval_ms: 15_000,
            connection_state_ttl_ms: 120_000,
            attached_channel_serial: Some("serial-0"),
        }
    }
}

impl MockAblyServer {
    pub(crate) async fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        Ok(Self { listener, port })
    }

    /// Accept one TCP connection and perform the Ably handshake (CONNECTED + ATTACH/ATTACHED).
    ///
    /// `conn_id` controls the connection identity. Use different IDs across
    /// reconnect attempts so the client knows it's a fresh connect (not a
    /// resume) and sends ATTACH.
    pub(crate) async fn accept_and_handshake(
        &self,
        channel: &str,
        conn_id: &str,
    ) -> Result<WsStream, Box<dyn std::error::Error>> {
        self.accept_and_handshake_with_opts(channel, conn_id, HandshakeOptions::default())
            .await
    }

    /// Accept one TCP connection and perform the Ably handshake with custom options.
    pub(crate) async fn accept_and_handshake_with_opts(
        &self,
        channel: &str,
        conn_id: &str,
        opts: HandshakeOptions,
    ) -> Result<WsStream, Box<dyn std::error::Error>> {
        let (tcp, _) = self.listener.accept().await?;
        let mut ws = tokio_tungstenite::accept_async(tcp).await?;

        let conn_key = format!("{conn_id}!key");

        // Send CONNECTED
        let connected = ProtocolMessage {
            action: action::CONNECTED,
            connection_id: Some(conn_id.into()),
            connection_key: Some(conn_key.clone()),
            connection_details: Some(ConnectionDetails {
                server_id: Some("mock-ably-server".into()),
                connection_key: Some(conn_key),
                connection_state_ttl: Some(opts.connection_state_ttl_ms),
                max_idle_interval: Some(opts.max_idle_interval_ms),
                ..Default::default()
            }),
            ..Default::default()
        };
        ws.send(tungstenite::Message::Binary(encode_msg(&connected)?.into()))
            .await?;

        // Read ATTACH
        let msg = expect_protocol_msg(&mut ws, "client ATTACH after CONNECTED").await?;
        assert_eq!(msg.action, action::ATTACH);
        assert_eq!(msg.channel.as_deref(), Some(channel));

        // Send ATTACHED
        let attached = ProtocolMessage {
            action: action::ATTACHED,
            channel: Some(channel.into()),
            channel_serial: opts.attached_channel_serial.map(str::to_string),
            ..Default::default()
        };
        ws.send(tungstenite::Message::Binary(encode_msg(&attached)?.into()))
            .await?;

        Ok(ws)
    }

    /// Accept one TCP connection and return the raw WebSocket (no handshake).
    pub(crate) async fn accept_raw(&self) -> Result<WsStream, Box<dyn std::error::Error>> {
        let (tcp, _) = self.listener.accept().await?;
        let ws = tokio_tungstenite::accept_async(tcp).await?;
        Ok(ws)
    }
}
