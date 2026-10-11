//! Real public DERP IO inside the production Cache-owned native runtime.
//! These are component/physical-owner checks, not a qualified SSH carrier.
pub(super) mod fixture;

use super::fixture::bounded;
use crate::ssh::{
    cache::Cache,
    tailscale::{Control, Failure, Key, Work, registration::Registration},
};
use fixture::{Server, WriteGate};
use futures_util::{SinkExt, StreamExt};
use runner_types::ids::RunId;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use ts_derp::frame::{self, RawFrame};
use ts_keys::NodeKeyPair;

fn configuration() -> Key {
    Key {
        configuration: uuid::Uuid::new_v4(),
        generation: 1,
    }
}

#[tokio::test]
async fn owned_derp_partial_read_closes_actual_upgraded_socket_before_releasing_node() {
    let server = Server::new().await;
    let gate = WriteGate::new();
    let retained = Arc::clone(&gate);
    let address = server.address;
    let work: Work = Box::new(move |control: Control| {
        Box::pin(async move {
            let profile = Registration::new();
            let client =
                fixture::connect(address, Arc::clone(&retained), &profile.keys().node_keys).await?;
            retained.observe_read();
            control.ready();
            client.recv_one().await.map_err(|_| Failure::DomainFailed)?;
            Err(Failure::DomainFailed)
        })
    });
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access.native_node(configuration(), work).unwrap();
    let (mut frames, _) = bounded(server.task).await.unwrap();
    bounded(node.ready()).await.unwrap();
    let mut prefix = vec![frame::FrameType::RecvPacket as u8];
    prefix.extend_from_slice(&2080u32.to_be_bytes());
    prefix.extend_from_slice(&[0x71; 3]);
    frames.get_mut().write_all(&prefix).await.unwrap();
    bounded(gate.partial_read_pending(prefix.len())).await;
    run.close();
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(gate.destroyed()).await;
    let mut extra = [0; 8];
    assert_eq!(bounded(frames.get_mut().read(&mut extra)).await.unwrap(), 0);
}

#[tokio::test]
async fn owned_derp_partial_write_discards_unsent_frame_and_closes_actual_socket() {
    let server = Server::new().await;
    let gate = WriteGate::new();
    let retained = Arc::clone(&gate);
    let address = server.address;
    let destination = NodeKeyPair::random().public;
    let work: Work = Box::new(move |control: Control| {
        Box::pin(async move {
            let profile = Registration::new();
            let client =
                fixture::connect(address, Arc::clone(&retained), &profile.keys().node_keys).await?;
            retained.pause_after(12);
            control.ready();
            client
                .send_one(destination, &[0x72; 2048])
                .await
                .map_err(|_| Failure::DomainFailed)?;
            Err(Failure::DomainFailed)
        })
    });
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access.native_node(configuration(), work).unwrap();
    let (mut frames, _) = bounded(server.task).await.unwrap();
    bounded(node.ready()).await.unwrap();
    bounded(gate.pending()).await;
    let mut prefix = [0; 12];
    bounded(frames.get_mut().read_exact(&mut prefix))
        .await
        .unwrap();
    assert_eq!(prefix[0], frame::FrameType::SendPacket as u8);
    assert_eq!(u32::from_be_bytes(prefix[1..5].try_into().unwrap()), 2080);
    run.close();
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(gate.destroyed()).await;
    let mut extra = [0; 8];
    assert_eq!(bounded(frames.get_mut().read(&mut extra)).await.unwrap(), 0);
    assert!(frames.read_buffer().is_empty());
}

#[tokio::test]
async fn oversized_derp_length_fails_without_waiting_for_unbounded_payload() {
    let server = Server::new().await;
    let gate = WriteGate::new();
    let retained = Arc::clone(&gate);
    let address = server.address;
    let (result, observed) = tokio::sync::oneshot::channel();
    let work: Work = Box::new(move |control: Control| {
        Box::pin(async move {
            let profile = Registration::new();
            let client = fixture::connect(address, retained, &profile.keys().node_keys).await?;
            control.ready();
            let value = client
                .recv_one()
                .await
                .map(|_| ())
                .map_err(|_| Failure::DomainFailed);
            let _ = result.send(value);
            value
        })
    });
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access.native_node(configuration(), work).unwrap();
    let (mut frames, _) = bounded(server.task).await.unwrap();
    bounded(node.ready()).await.unwrap();
    let mut invalid = vec![frame::FrameType::RecvPacket as u8];
    invalid.extend_from_slice(&u32::MAX.to_be_bytes());
    frames.get_mut().write_all(&invalid).await.unwrap();
    assert_eq!(bounded(observed).await.unwrap(), Err(Failure::DomainFailed));
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(gate.destroyed()).await;
    let mut extra = [0; 8];
    assert_eq!(bounded(frames.get_mut().read(&mut extra)).await.unwrap(), 0);
}

#[tokio::test]
async fn official_derp_handshake_and_bidirectional_bytes_remain_owned_until_invalidation() {
    let server = Server::new().await;
    let gate = WriteGate::new();
    let retained = Arc::clone(&gate);
    let address = server.address;
    let destination = NodeKeyPair::random().public;
    let (identity, actual_identity) = tokio::sync::oneshot::channel();
    let (reply, received) = tokio::sync::oneshot::channel();
    let work: Work = Box::new(move |control: Control| {
        Box::pin(async move {
            let profile = Registration::new();
            let _ = identity.send(profile.keys().node_keys.public);
            let client = fixture::connect(address, retained, &profile.keys().node_keys).await?;
            control.ready();
            client
                .send_one(destination, &[0x73; 1280])
                .await
                .map_err(|_| Failure::DomainFailed)?;
            let (source, bytes) = client.recv_one().await.map_err(|_| Failure::DomainFailed)?;
            if source != destination || bytes.as_ref() != [0x74; 1280] {
                return Err(Failure::DomainFailed);
            }
            let _ = reply.send(());
            control.cancelled().cancelled().await;
            Ok(())
        })
    });
    let cache = Cache::new();
    let run_id = RunId::new_v4();
    let run = cache.register(run_id);
    let connection = uuid::Uuid::new_v4();
    let access = run.lookup(connection).unwrap();
    let node = access.native_node(configuration(), work).unwrap();
    let (mut frames, client_key) = bounded(server.task).await.unwrap();
    assert_eq!(bounded(actual_identity).await.unwrap(), client_key);
    bounded(node.ready()).await.unwrap();
    let sent = bounded(frames.next()).await.unwrap().unwrap();
    let (packet, bytes) = sent.get().as_type::<frame::SendPacket>().unwrap();
    assert_eq!(packet.dest, destination);
    assert_eq!(bytes, [0x73; 1280]);
    let payload = [0x74; 1280];
    frames
        .send((
            RawFrame::from_body(&frame::RecvPacket { src: destination }, payload.len()).unwrap(),
            payload.as_slice(),
        ))
        .await
        .unwrap();
    bounded(received).await.unwrap();
    // This component fixture has no prepared common-SSH authority entry. Use
    // delivered Run invalidation, which actually owns the complete native root.
    cache.invalidate(run_id, None);
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(gate.destroyed()).await;
    let mut extra = [0; 8];
    assert_eq!(bounded(frames.get_mut().read(&mut extra)).await.unwrap(), 0);
}
