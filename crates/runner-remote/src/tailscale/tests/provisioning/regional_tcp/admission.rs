//! Buffered regional input shares the controlled peer's bounded receive capacity.

use super::*;
use crate::tailscale::tests::derp::fixture::upgrade;

#[tokio::test]
async fn buffered_regional_bursts_preserve_frames_across_shared_peer_batches() {
    let client = NodeKeyPair::random();
    let peer = NodeKeyPair::random();
    let mut burst = bytes::BytesMut::new();
    let mut ends = vec![0];
    for index in 0..65 {
        // Opaque data exercises DERP framing/admission. The liveness suite
        // separately verifies complete encrypted TCP payloads on eight flows.
        let packet = [0, 0, 0, 0, index];
        frame::Codec
            .encode(
                (
                    frame::RawFrame::from_body(
                        &frame::SendPacket { dest: peer.public },
                        packet.len(),
                    )
                    .unwrap(),
                    packet.as_slice(),
                ),
                &mut burst,
            )
            .unwrap();
        ends.push(burst.len());
    }

    let mut clients = Vec::new();
    let mut services = Vec::new();
    for _ in 0..2 {
        let server = Server::new().await;
        let socket = bounded(tokio::net::TcpStream::connect(server.address))
            .await
            .unwrap();
        let io = bounded(upgrade(server.address, socket)).await.unwrap();
        clients.push(
            bounded(ts_derp::Client::handshake(io, &client))
                .await
                .unwrap(),
        );
        let (mut frames, key) = bounded(server.task).await.unwrap();
        assert_eq!(key, client.public);
        // Prebuffer complete frames to force the backlog independently of
        // kernel reads, TLS record sizes, or the producer thread's scheduling.
        frames.read_buffer_mut().extend_from_slice(&burst);
        services.push(Service {
            task: None,
            frames: Some(frames),
            outgoing: VecDeque::new(),
            offset: 0,
            expected: peer.public,
            client: key,
            closed: false,
            packets: 0,
        });
    }

    let mut side = wire::DerpSide::new(peer, client.public, 2);
    for admitted in [[64, 0], [65, 63], [65, 65]] {
        std::future::poll_fn(|cx| {
            for service in &mut services {
                service.poll(cx, &mut side);
            }
            Poll::Ready(())
        })
        .await;
        for (service, count) in services.iter().zip(admitted) {
            assert_eq!(service.packets, count);
            assert_eq!(
                service.frames.as_ref().unwrap().read_buffer().as_ref(),
                &burst[ends[count]..],
                "unadmitted frames must remain complete and ordered",
            );
        }
        // The unchanged peer pump consumes this batch before the next turn.
        let _ = side.pump(0);
    }

    drop(clients);
    bounded(std::future::poll_fn(|cx| {
        for service in &mut services {
            service.poll(cx, &mut side);
        }
        if services.iter().all(|service| service.closed) {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    }))
    .await;
}
