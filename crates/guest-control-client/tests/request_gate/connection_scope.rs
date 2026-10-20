use std::io;
use std::sync::{Arc, Mutex};

use guest_control_client::test_support::request_gate::{RequestKind, gate_connection};
use guest_control_client::test_support::{self, ConnectionScope};
use tokio::net::UnixStream;

use super::support::*;

#[tokio::test]
async fn explicit_listener_scope_preserves_handshake_and_cancelled_fixed_request() -> TestResult<()>
{
    let retained = Arc::new(Mutex::new(None));
    let owner = retained.clone();
    let scope = ConnectionScope::new("original".into(), move |guest| {
        let (client, host) = UnixStream::pair()?;
        let bundle = gate_connection(host, guest);
        assert!(owner.lock().unwrap().replace(bundle).is_none());
        Ok(client)
    })?;
    let (stream, guest) = UnixStream::pair()?;
    let mut listener = None;
    scope
        .scope(async {
            let inherited = ConnectionScope::current().unwrap();
            listener = Some(tokio::spawn(async move {
                assert!(ConnectionScope::current().is_none());
                inherited
                    .scope(test_support::from_stream_for_sandbox(
                        stream, DEADLINE, "original",
                    ))
                    .await
            }));
        })
        .await;
    assert!(ConnectionScope::current().is_none());
    let mut peer = Peer { stream: guest };
    peer.handshake().await?;
    let client = bounded(listener.expect("spawned listener retained outside scope")).await???;
    let (mut controls, mut exchange, connection) = retained.lock().unwrap().take().unwrap();
    controls.arm(RequestKind::GuestStateRestore)?;
    let mut operation = Box::pin(restore(&client));
    let captured = capture(&mut controls, operation.as_mut()).await?;
    drop(operation);
    let error = restore(&client).await.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::ConnectionReset);
    controls.dispatch.send(()).unwrap();
    let request = peer.next().await?;
    assert_eq!(request.raw, captured.raw());
    peer.send(
        guest_control_proto::MSG_GUEST_STATE_RESTORE_RESULT,
        captured.sequence(),
        &restore_result()?,
    )
    .await?;
    let response = bounded(&mut controls.response).await??;
    controls
        .delivery
        .send(guest_control_client::test_support::request_gate::ResponseDisposition::Deliver)
        .unwrap();
    let joined = bounded(exchange.join()).await??;
    assert_eq!(joined.request, captured);
    assert_eq!(joined.response, response);
    status_roundtrip(&client, &mut peer).await?;
    assert_eq!(
        restore(&client).await.unwrap_err().kind(),
        io::ErrorKind::ConnectionReset
    );
    finish(client, peer, connection).await?;
    Ok(())
}

#[tokio::test]
async fn connection_scope_rejects_wrong_identity_and_propagates_adapter_error() -> TestResult<()> {
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = calls.clone();
    let scope = ConnectionScope::new("original".into(), move |_| {
        observed.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "owned adapter refused",
        ))
    })?;
    for (id, expected) in [
        ("other", io::ErrorKind::InvalidInput),
        ("original", io::ErrorKind::PermissionDenied),
        ("original", io::ErrorKind::AlreadyExists),
    ] {
        let (stream, _peer) = UnixStream::pair()?;
        let result = scope
            .scope(test_support::from_stream_for_sandbox(stream, DEADLINE, id))
            .await;
        assert_eq!(result.err().unwrap().kind(), expected);
    }
    assert_eq!(calls.load(std::sync::atomic::Ordering::Acquire), 1);
    assert!(ConnectionScope::new(String::new(), Ok).is_err());
    Ok(())
}

#[tokio::test]
async fn unpropagated_spawn_does_not_adopt_an_invocation_scope() -> TestResult<()> {
    let scope = ConnectionScope::new("original".into(), |_| panic!("scope escaped its future"))?;
    let (stream, guest) = UnixStream::pair()?;
    let mut task = None;
    scope
        .scope(async {
            task = Some(tokio::spawn(test_support::from_stream_for_sandbox(
                stream, DEADLINE, "original",
            )));
        })
        .await;
    let mut peer = Peer { stream: guest };
    peer.handshake().await?;
    let client = bounded(task.expect("unpropagated listener retained")).await???;
    drop(client);
    drop(peer);
    assert!(ConnectionScope::current().is_none());
    Ok(())
}
