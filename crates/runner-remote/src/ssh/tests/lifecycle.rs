use super::{
    harness::{Harness, Reply, frames, key, params, read_http_request, respond},
    terminal, wait_for,
};
use serde_json::json;
use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[test]
fn cancelled_blocking_job_keeps_host_capacity_without_blocking_guest_park() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        let mut h = Harness::new(Reply::default()).await;
        let _resolve = h.resolve(h.credential(true)).await;
        let (release, held) = std::sync::mpsc::channel();
        let entered = Arc::new(tokio::sync::Notify::new());
        let worker_entered = Arc::clone(&entered);
        let occupied = tokio::task::spawn_blocking(move || {
            worker_entered.notify_one();
            held.recv().unwrap();
        });
        entered.notified().await;
        let (frames, ()) = tokio::join!(h.request(params()), async {
            wait_for(|| h.runtime.cpu.available_permits() == 1).await;
            assert_eq!(
                h.control.try_fence_normal_operations().err(),
                Some(guest_control_client::NormalOperationFenceRejection::Busy)
            );
            h.cancel.cancel();
        });
        assert_eq!(terminal(&frames)["failure_reason"], "cancelled");
        assert_eq!(terminal(&frames)["effects"], "not_started");
        h.shutdown().await;
        // RPC terminal+EOF and shutdown do not wait for host blocking work.
        // Its CPU capacity remains charged while the guest can park.
        assert_eq!(h.runtime.cpu.available_permits(), 1);
        let fence = h.control.try_fence_normal_operations().unwrap();
        release.send(()).unwrap();
        occupied.await.unwrap();
        wait_for(|| h.runtime.cpu.available_permits() == 2).await;
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
        assert!(h.observed.attempts.lock().unwrap().is_empty());
        assert!(h.observed.commands.lock().unwrap().is_empty());
        drop(fence);
    });
}

#[tokio::test]
async fn lifecycle_cancellation_during_exec_closes_connection_and_releases_park_fence() {
    let h = Harness::new(Reply::Hold).await;
    let _resolve = h.resolve(h.credential(true)).await;
    let (frames, ()) = tokio::join!(h.request(params()), async {
        wait_for(|| h.observed.commands.lock().unwrap().len() == 1).await;
        h.lifecycle.cancel();
    });
    assert!(
        frames
            .iter()
            .all(|frame| frame["data"]["type"] != "finished")
    );
    wait_for(|| h.observed.reservations.load(Ordering::SeqCst) == 0).await;
    drop(h.control.try_fence_normal_operations().unwrap());
    assert_eq!(h.observed.attempts.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn cancelled_first_use_pin_cannot_authenticate_when_the_response_arrives_late() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let h = Harness::with_api(
        Reply::Hold,
        key(russh::keys::Algorithm::Ed25519),
        key(russh::keys::Algorithm::Ed25519),
        Some(format!("http://{}", listener.local_addr().unwrap())),
    )
    .await;
    let server = async {
        let (mut resolve, _) = listener.accept().await.unwrap();
        read_http_request(&mut resolve).await;
        respond(&mut resolve, h.credential(false)).await.unwrap();
        let (mut pin, _) = listener.accept().await.unwrap();
        read_http_request(&mut pin).await;
        assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
        h.cancel.cancel();
        wait_for(|| h.observed.reservations.load(Ordering::SeqCst) == 0).await;
        // Cancellation may already have closed the HTTP transport. Either a
        // late response or that explicit socket closure must leave auth at zero.
        let late = respond(&mut pin, json!({"outcome":"pinned","generation":8})).await;
        assert!(
            late.is_ok()
                || late.is_err_and(|error| matches!(
                    error.kind(),
                    std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                ))
        );
    };
    let (frames, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(h.request(params()), server)
    })
    .await
    .unwrap();
    assert_eq!(terminal(&frames)["failure_reason"], "cancelled");
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
    assert!(h.observed.commands.lock().unwrap().is_empty());
    drop(h.control.try_fence_normal_operations().unwrap());
}

#[tokio::test]
async fn redirecting_authority_is_not_followed_and_no_private_body_is_forwarded() {
    let h = Harness::new(Reply::default()).await;
    let destination = h
        .api
        .mock_async(|when, then| {
            when.path("/redirected");
            then.status(200).json_body(h.credential(true));
        })
        .await;
    let _resolve = h
        .api
        .mock_async(|when, then| {
            when.path(format!("/api/runners/runs/{}/ssh/resolve", h.run));
            then.status(307)
                .header("location", format!("{}/redirected", h.api.base_url()));
        })
        .await;
    assert_eq!(
        terminal(&h.request(params()).await)["failure_reason"],
        "authority_failure"
    );
    destination.assert_calls_async(0).await;
    assert!(h.observed.attempts.lock().unwrap().is_empty());
}

#[tokio::test]
async fn run_cancellation_during_input_does_not_decode_or_call_authority() {
    let mut h = Harness::new(Reply::default()).await;
    let resolve = h.resolve(h.credential(true)).await;
    let mut guest = h.open().await;
    guest.write_u32(100).await.unwrap();
    guest.write_all(b"{").await.unwrap();
    let mut pending = vec![guest];
    for _ in 1..8 {
        pending.push(h.open().await);
    }
    // The ninth rejection proves the earlier partial input was admitted.
    assert_eq!(
        frames(h.open().await).await[0]["code"],
        "resource_exhausted"
    );
    h.cancel.cancel();
    for guest in pending {
        assert!(frames(guest).await.is_empty());
    }
    resolve.assert_calls_async(0).await;
    h.shutdown().await;
    drop(h.control.try_fence_normal_operations().unwrap());
}

#[tokio::test]
async fn cancelled_handshake_without_server_banner_closes_the_socket() {
    let h = Harness::new(Reply::default()).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    // The network adapter remains the only external replacement boundary.
    *h.network.target.lock().unwrap() = listener.local_addr().unwrap();
    let _resolve = h.resolve(h.credential(true)).await;
    let (frames, ()) = tokio::join!(h.request(params()), async {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut banner = [0; 256];
        assert!(socket.read(&mut banner).await.unwrap() > 0);
        h.cancel.cancel();
        let mut rest = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), socket.read_to_end(&mut rest))
            .await
            .unwrap()
            .unwrap();
    });
    assert_eq!(terminal(&frames)["failure_reason"], "cancelled");
    wait_for(|| h.observed.reservations.load(Ordering::SeqCst) == 0).await;
    drop(h.control.try_fence_normal_operations().unwrap());
    assert_eq!(h.observed.auth.load(Ordering::SeqCst), 0);
}
