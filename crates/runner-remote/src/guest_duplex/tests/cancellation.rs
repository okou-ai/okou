use super::*;

#[tokio::test]
async fn provider_cancellation_interrupts_both_split_directions_and_observer() {
    let registry = RunGuestChannels::default();
    let fixture = Fixture::new();
    let run = RunId::new_v4();
    let _registration = fixture.register(&registry, run, "a", &CancellationToken::new());
    let cancelled = CancellationToken::new();
    let _stalled_guest = fixture.guest_with_cancel("a", cancelled.clone()).await;
    let channel = registry.open(run).await.unwrap();
    let observer = channel.cancellation();
    let (mut sender, mut receiver) = channel.split();
    let frame = vec![7; MAX_FRAME_BYTES];
    sender.send(&frame).await.unwrap();
    let mut send = Box::pin(sender.send(&frame));
    let mut recv = Box::pin(receiver.recv());
    let mut observe = Box::pin(observer.cancelled());
    assert!(futures_util::poll!(send.as_mut()).is_pending());
    assert!(futures_util::poll!(recv.as_mut()).is_pending());
    assert!(futures_util::poll!(observe.as_mut()).is_pending());

    cancelled.cancel();
    let (send, recv, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(send, recv, observe)
    })
    .await
    .expect("provider cancellation must interrupt split IO and its observer");
    assert_eq!(send.unwrap_err().kind(), io::ErrorKind::NotConnected);
    assert_eq!(recv.unwrap_err().kind(), io::ErrorKind::NotConnected);
}

#[tokio::test]
async fn provider_cancellation_precedes_ready_io_without_changing_validation() {
    let registry = RunGuestChannels::default();
    let fixture = Fixture::new();
    let run = RunId::new_v4();
    let _registration = fixture.register(&registry, run, "a", &CancellationToken::new());
    let cancelled = CancellationToken::new();
    let mut read_guest = fixture.guest_with_cancel("a", cancelled.clone()).await;
    let mut read_channel = registry.open(run).await.unwrap();
    let mut write_guest = fixture.guest_with_cancel("a", cancelled.clone()).await;
    let mut write_channel = registry.open(run).await.unwrap();
    let mut finish_guest = fixture.guest_with_cancel("a", cancelled.clone()).await;
    let mut finish_channel = registry.open(run).await.unwrap();
    read_guest.write_all(b"\0\0\0\x05ready").await.unwrap();

    cancelled.cancel();
    assert_eq!(
        write_channel
            .send(&vec![0; MAX_FRAME_BYTES + 1])
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidInput
    );
    assert_eq!(
        read_channel.recv().await.unwrap_err().kind(),
        io::ErrorKind::NotConnected
    );
    assert_eq!(
        write_channel.send(b"late").await.unwrap_err().kind(),
        io::ErrorKind::NotConnected
    );
    assert_eq!(
        finish_channel.finish_send().await.unwrap_err().kind(),
        io::ErrorKind::NotConnected
    );
    // The independently cancelled streams must neither emit a frame nor EOF.
    let mut byte = [0];
    assert!(futures_util::poll!(Box::pin(write_guest.read(&mut byte))).is_pending());
    assert!(futures_util::poll!(Box::pin(finish_guest.read(&mut byte))).is_pending());
}

#[tokio::test]
async fn split_channel_capacity_releases_after_the_last_half() {
    let registry = RunGuestChannels::default();
    let fixture = Fixture::new();
    let run = RunId::new_v4();
    let _registration = fixture.register(&registry, run, "a", &CancellationToken::new());
    let mut guests = Vec::new();
    let mut channels = Vec::new();
    for _ in 0..MAX_STREAMS_PER_RUN {
        guests.push(fixture.guest("a").await);
        channels.push(registry.open(run).await.unwrap());
    }
    let channel = channels.pop().unwrap();
    let observer = channel.cancellation();
    let (sender, receiver) = channel.split();
    assert_eq!(
        registry.open(run).await.err().unwrap().kind(),
        io::ErrorKind::WouldBlock
    );
    drop(sender);
    assert_eq!(
        registry.open(run).await.err().unwrap().kind(),
        io::ErrorKind::WouldBlock
    );
    drop(receiver);
    guests.push(fixture.guest("a").await);
    let _replacement = registry.open(run).await.unwrap();
    // Listener observation outlives both halves but must not retain capacity.
    drop(observer);
}
