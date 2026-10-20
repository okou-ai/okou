use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::task::Poll;
use std::time::Duration;

use guest_control_client::test_support::request_gate::{
    ConnectionProducer, Controls, ExchangeProducer, Frame, gate_connection,
};
use guest_control_client::{GuestControlClient, GuestStateRestoreResult, test_support};
use guest_control_proto::{
    Decoder, ExecCapturedOutput, ExecTermination, FileWriteStage, FileWriteStatus,
    GuestStateRestoreTimezone, MSG_FILE_WRITE_STATUS, MSG_FILE_WRITE_STATUS_RESULT, MSG_PING,
    MSG_PONG, MSG_READY, RawMessage,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

pub type TestResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub const DEADLINE: Duration = Duration::from_secs(5);
pub const ENTROPY: [u8; 256] = [23; 256];

pub async fn bounded<F: Future>(future: F) -> TestResult<F::Output> {
    Ok(tokio::time::timeout(DEADLINE, future).await?)
}

pub async fn pending_once<F: Future>(mut future: Pin<&mut F>) {
    poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
}

pub struct Wire {
    pub raw: Vec<u8>,
    pub message: RawMessage,
}

pub struct Peer {
    pub stream: UnixStream,
}

impl Peer {
    pub async fn next(&mut self) -> TestResult<Wire> {
        bounded(async {
            let mut prefix = [0; 4];
            self.stream.read_exact(&mut prefix).await?;
            let length = u32::from_be_bytes(prefix) as usize;
            assert!(length <= guest_control_proto::MAX_MESSAGE_SIZE);
            let mut body = vec![0; length];
            self.stream.read_exact(&mut body).await?;
            let mut raw = prefix.to_vec();
            raw.extend(body);
            let mut messages = Decoder::new().decode(&raw)?;
            assert_eq!(messages.len(), 1);
            Ok(Wire {
                raw,
                message: messages
                    .pop()
                    .ok_or_else(|| std::io::Error::other("peer frame missing"))?,
            })
        })
        .await?
    }

    pub async fn send(&mut self, kind: u8, sequence: u32, payload: &[u8]) -> TestResult<Vec<u8>> {
        let raw = guest_control_proto::encode(kind, sequence, payload)?;
        self.stream.write_all(&raw).await?;
        Ok(raw)
    }

    async fn handshake(&mut self) -> TestResult<()> {
        self.send(MSG_READY, 0, &[]).await?;
        let ping = self.next().await?;
        assert_eq!(ping.message.msg_type, MSG_PING);
        self.send(MSG_PONG, ping.message.seq, &[]).await?;
        Ok(())
    }
}

pub async fn setup() -> TestResult<(
    GuestControlClient,
    Peer,
    Controls,
    ExchangeProducer,
    ConnectionProducer,
)> {
    let (client_stream, host) = UnixStream::pair()?;
    let (guest, stream) = UnixStream::pair()?;
    let (controls, exchange, connection) = gate_connection(host, guest);
    let mut peer = Peer { stream };
    let (client, handshake) = tokio::join!(
        test_support::from_stream_for_sandbox(client_stream, DEADLINE, "original-wire-owner"),
        peer.handshake(),
    );
    handshake?;
    Ok((client?, peer, controls, exchange, connection))
}

pub async fn restore(client: &GuestControlClient) -> std::io::Result<GuestStateRestoreResult> {
    client
        .guest_state_restore(
            1_778_000_000,
            123_000_000,
            &ENTROPY,
            GuestStateRestoreTimezone::Required("UTC"),
            1_000,
            DEADLINE,
        )
        .await
}

pub fn restore_result() -> TestResult<Vec<u8>> {
    Ok(guest_control_proto::encode_guest_state_restore_result(
        ExecTermination::Exited { exit_code: 0 },
        17,
        ExecCapturedOutput::Captured {
            bytes: b"original diagnostic",
            truncated: false,
        },
        "",
    )?)
}

pub async fn capture<F: Future>(
    controls: &mut Controls,
    mut operation: Pin<&mut F>,
) -> TestResult<Frame> {
    bounded(async {
        let frame = tokio::select! {
            frame = &mut controls.captured => frame?,
            _ = operation.as_mut() => return Err(std::io::Error::other("public operation passed request capture").into()),
        };
        Ok(frame)
    })
    .await?
}

/// The actual reply also proves the Host reader passed all earlier wire frames.
pub async fn status_roundtrip(client: &GuestControlClient, peer: &mut Peer) -> TestResult<()> {
    let expected = FileWriteStatus {
        sequence: 0,
        stage: FileWriteStage::Idle,
    };
    let (actual, responded) = tokio::join!(client.file_write_status(DEADLINE), async {
        let request = peer.next().await?;
        assert_eq!(request.message.msg_type, MSG_FILE_WRITE_STATUS);
        peer.send(
            MSG_FILE_WRITE_STATUS_RESULT,
            request.message.seq,
            &expected.encode_payload(),
        )
        .await?;
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    });
    responded?;
    assert_eq!(actual?, expected);
    Ok(())
}

pub async fn finish(
    client: GuestControlClient,
    peer: Peer,
    mut connection: ConnectionProducer,
) -> TestResult<()> {
    drop(peer);
    drop(client);
    bounded(connection.join()).await??;
    Ok(())
}
