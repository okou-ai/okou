use super::*;
use async_trait::async_trait;
use sandbox::AcceptedGuestDuplex;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::{Mutex as AsyncMutex, mpsc};

struct FakeAcceptor {
    rx: AsyncMutex<mpsc::Receiver<AcceptedGuestDuplex>>,
}
#[async_trait]
impl GuestDuplexAcceptor for FakeAcceptor {
    async fn accept(&self) -> io::Result<AcceptedGuestDuplex> {
        self.rx.lock().await.recv().await.ok_or_else(unavailable)
    }
}
struct Fixture {
    acceptor: Arc<FakeAcceptor>,
    tx: mpsc::Sender<AcceptedGuestDuplex>,
}
impl Fixture {
    fn new() -> Self {
        let (tx, rx) = mpsc::channel(16);
        Self {
            acceptor: Arc::new(FakeAcceptor {
                rx: AsyncMutex::new(rx),
            }),
            tx,
        }
    }
    async fn guest(&self, sandbox: &str) -> DuplexStream {
        let (host, guest) = tokio::io::duplex(128 * 1024);
        self.tx
            .send(AcceptedGuestDuplex {
                sandbox_id: sandbox.to_owned(),
                stream: Box::new(host),
                cancelled: CancellationToken::new(),
            })
            .await
            .unwrap();
        guest
    }
    fn register(
        &self,
        registry: &RunGuestChannels,
        run: RunId,
        sandbox: &str,
        cancel: &CancellationToken,
    ) -> Registration {
        registry.register_acceptor(run, sandbox.to_owned(), self.acceptor.clone(), cancel)
    }
}

#[tokio::test]
async fn both_directions_order_and_half_close() {
    let registry = RunGuestChannels::default();
    let fixture = Fixture::new();
    let run = RunId::new_v4();
    let _registration = fixture.register(&registry, run, "sandbox-a", &CancellationToken::new());
    let mut guest = fixture.guest("sandbox-a").await;
    let mut channel = registry.open(run).await.unwrap();
    channel.send(b"one").await.unwrap();
    channel.send(b"two").await.unwrap();
    channel.finish_send().await.unwrap();
    assert_eq!(
        channel.send(b"late").await.err().unwrap().kind(),
        io::ErrorKind::BrokenPipe
    );
    for expected in [b"one".as_slice(), b"two".as_slice()] {
        let mut header = [0u8; 4];
        guest.read_exact(&mut header).await.unwrap();
        let mut body = vec![0; u32::from_be_bytes(header) as usize];
        guest.read_exact(&mut body).await.unwrap();
        assert_eq!(body, expected);
    }
    let mut end = [0u8; 1];
    assert_eq!(guest.read(&mut end).await.unwrap(), 0);
    guest.write_all(&3u32.to_be_bytes()).await.unwrap();
    guest.write_all(b"ack").await.unwrap();
    guest.shutdown().await.unwrap();
    assert_eq!(channel.recv().await.unwrap(), Some(b"ack".to_vec()));
    assert_eq!(channel.recv().await.unwrap(), None);
}

#[tokio::test]
async fn exact_run_isolation_and_reuse_epoch() {
    let registry = RunGuestChannels::default();
    let a = Fixture::new();
    let b = Fixture::new();
    let run_a = RunId::new_v4();
    let run_b = RunId::new_v4();
    let cancel = CancellationToken::new();
    let old = a.register(&registry, run_a, "reused", &cancel);
    let _b = b.register(&registry, run_b, "other", &cancel);
    assert!(registry.open(RunId::new_v4()).await.is_err());
    let _wrong = a.guest("other").await;
    assert!(registry.open(run_a).await.is_err());
    let _guest_b = b.guest("other").await;
    let mut channel_b = registry.open(run_b).await.unwrap();
    drop(old);
    assert!(registry.open(run_a).await.is_err());
    let replacement = a.register(&registry, run_a, "reused", &cancel);
    let _guest_a = a.guest("reused").await;
    let mut channel_a = registry.open(run_a).await.unwrap();
    drop(replacement);
    assert_eq!(
        channel_a.send(b"stale").await.err().unwrap().kind(),
        io::ErrorKind::NotConnected
    );
    // An unrelated run still has a live registration and can use its stream.
    assert!(channel_b.send(b"ok").await.is_ok());
}

#[tokio::test]
async fn split_channel_retains_independent_listener_cancellation_observer() {
    let registry = RunGuestChannels::default();
    let fixture = Fixture::new();
    let run = RunId::new_v4();
    let cancel = CancellationToken::new();
    let registration = fixture.register(&registry, run, "a", &cancel);
    let _guest = fixture.guest("a").await;
    let channel = registry.open(run).await.unwrap();
    let observer = channel.cancellation();
    let (mut sender, mut receiver) = channel.split();
    drop(registration);
    observer.cancelled().await;
    assert_eq!(
        sender.send(b"late").await.err().unwrap().kind(),
        io::ErrorKind::NotConnected
    );
    assert_eq!(
        receiver.recv().await.err().unwrap().kind(),
        io::ErrorKind::NotConnected
    );
}

#[tokio::test]
async fn pending_attach_is_cancelled_before_it_can_follow_a_new_epoch() {
    let registry = RunGuestChannels::default();
    let old_fixture = Fixture::new();
    let run = RunId::new_v4();
    let cancel = CancellationToken::new();
    let old = old_fixture.register(&registry, run, "same-sandbox", &cancel);
    let mut opening = Box::pin(registry.open(run));
    assert!(futures_util::poll!(opening.as_mut()).is_pending());
    drop(old);
    assert_eq!(
        opening.await.err().unwrap().kind(),
        io::ErrorKind::NotConnected
    );
    let replacement = Fixture::new();
    let _new = replacement.register(&registry, run, "same-sandbox", &cancel);
    let _guest = replacement.guest("same-sandbox").await;
    assert!(registry.open(run).await.is_ok());
}

#[tokio::test]
async fn concurrent_streams_and_malformed_frame_fail_only_its_stream() {
    let registry = RunGuestChannels::default();
    let fixture = Fixture::new();
    let run = RunId::new_v4();
    let _registration = fixture.register(&registry, run, "a", &CancellationToken::new());
    let mut first = fixture.guest("a").await;
    let mut second = fixture.guest("a").await;
    let mut a = registry.open(run).await.unwrap();
    let mut b = registry.open(run).await.unwrap();
    first
        .write_all(&((MAX_FRAME_BYTES + 1) as u32).to_be_bytes())
        .await
        .unwrap();
    assert_eq!(
        a.recv().await.err().unwrap().kind(),
        io::ErrorKind::InvalidData
    );
    assert_eq!(
        a.send(b"not allowed").await.err().unwrap().kind(),
        io::ErrorKind::NotConnected
    );
    second.write_all(&1u32.to_be_bytes()).await.unwrap();
    second.write_all(b"b").await.unwrap();
    assert_eq!(b.recv().await.unwrap(), Some(b"b".to_vec()));
    b.send(b"live").await.unwrap();
    let mut frame = [0u8; 8];
    second.read_exact(&mut frame).await.unwrap();
    assert_eq!(&frame, b"\0\0\0\x04live");
}

#[tokio::test]
async fn truncated_header_or_payload_poison_only_the_affected_stream() {
    let registry = RunGuestChannels::default();
    let fixture = Fixture::new();
    let run = RunId::new_v4();
    let _registration = fixture.register(&registry, run, "a", &CancellationToken::new());
    for truncated in [b"\0\0".as_slice(), b"\0\0\0\x03xy".as_slice()] {
        let mut partial_guest = fixture.guest("a").await;
        let mut healthy_guest = fixture.guest("a").await;
        let mut partial = registry.open(run).await.unwrap();
        let mut healthy = registry.open(run).await.unwrap();
        partial_guest.write_all(truncated).await.unwrap();
        partial_guest.shutdown().await.unwrap();
        assert_eq!(
            partial.recv().await.unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        assert_eq!(
            partial.send(b"late").await.unwrap_err().kind(),
            io::ErrorKind::NotConnected
        );
        healthy.send(b"ok").await.unwrap();
        let mut frame = [0; 6];
        healthy_guest.read_exact(&mut frame).await.unwrap();
        assert_eq!(&frame, b"\0\0\0\x02ok");
    }
}

#[tokio::test]
async fn stalled_guest_backpressures_writer_and_run_cancel_interrupts_it() {
    let registry = RunGuestChannels::default();
    let fixture = Fixture::new();
    let run = RunId::new_v4();
    let cancel = CancellationToken::new();
    let _registration = fixture.register(&registry, run, "a", &cancel);
    let _unread_guest = fixture.guest("a").await;
    let mut channel = registry.open(run).await.unwrap();
    let full = vec![7u8; MAX_FRAME_BYTES];
    channel.send(&full).await.unwrap();
    let mut blocked = Box::pin(channel.send(&full));
    assert!(futures_util::poll!(blocked.as_mut()).is_pending());
    cancel.cancel();
    assert_eq!(
        blocked.await.err().unwrap().kind(),
        io::ErrorKind::NotConnected
    );
}

#[tokio::test]
async fn cancellation_capacity_and_oversized_frames() {
    let registry = RunGuestChannels::default();
    let fixture = Fixture::new();
    let run = RunId::new_v4();
    let cancel = CancellationToken::new();
    let _registration = fixture.register(&registry, run, "a", &cancel);
    let mut channels = Vec::new();
    for _ in 0..MAX_STREAMS_PER_RUN {
        let _guest = fixture.guest("a").await;
        channels.push(registry.open(run).await.unwrap());
    }
    assert_eq!(
        registry.open(run).await.err().unwrap().kind(),
        io::ErrorKind::WouldBlock
    );
    assert_eq!(
        channels[0]
            .send(&vec![0; MAX_FRAME_BYTES + 1])
            .await
            .err()
            .unwrap()
            .kind(),
        io::ErrorKind::InvalidInput
    );
    drop(channels.pop());
    let _guest = fixture.guest("a").await;
    let mut free = registry.open(run).await.unwrap();
    cancel.cancel();
    assert_eq!(
        free.recv().await.err().unwrap().kind(),
        io::ErrorKind::NotConnected
    );
    assert!(registry.open(run).await.is_err());
}
