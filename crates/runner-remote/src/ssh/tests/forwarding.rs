use std::{sync::atomic::Ordering, time::Duration};

use russh::keys::{Algorithm, HashAlg};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    harness::{CONNECTION, Harness, PASSWORD, Reply, key, params},
    terminal, wait_for,
};
use crate::ssh::FailureReason;

fn connection() -> Uuid {
    Uuid::parse_str(CONNECTION).unwrap()
}

fn password_credential(harness: &Harness, password: &str) -> Value {
    let mut credential = harness.credential(true);
    let object = credential.as_object_mut().unwrap();
    object.insert("outcome".into(), json!("resolved_password"));
    object.insert("password".into(), json!(password));
    object.remove("privateKey");
    object.remove("passphrase");
    credential
}

async fn open(
    harness: &Harness,
    cancelled: CancellationToken,
) -> Result<super::super::forwarding::DirectTcpIpStream, FailureReason> {
    harness
        .ssh()
        .open_direct_tcpip(
            connection(),
            7,
            "desktop.internal",
            5900,
            cancelled,
            Instant::now() + Duration::from_secs(10),
        )
        .await
}

fn failure<T>(result: Result<T, FailureReason>) -> FailureReason {
    match result {
        Ok(_) => panic!("forwarding unexpectedly succeeded"),
        Err(failure) => failure,
    }
}

#[tokio::test]
async fn forwarding_requires_the_authority_generation_selected_by_vnc() {
    let mut harness = Harness::new(Reply::default()).await;
    let resolve = harness.resolve(harness.credential(true)).await;
    let result = harness
        .ssh()
        .open_direct_tcpip(
            connection(),
            8,
            "desktop.internal",
            5900,
            CancellationToken::new(),
            Instant::now() + Duration::from_secs(10),
        )
        .await;
    assert_eq!(failure(result), FailureReason::ConfigurationChanged);
    assert!(harness.observed.forwards.lock().unwrap().is_empty());
    resolve.assert_calls_async(1).await;
    harness.shutdown().await;
}

#[tokio::test]
async fn private_key_and_password_forward_exact_target_and_binary_bytes() {
    for password in [false, true] {
        let mut harness = Harness::new(Reply::default()).await;
        let credential = if password {
            password_credential(&harness, PASSWORD)
        } else {
            harness.credential(true)
        };
        let resolve = harness.resolve(credential).await;
        let mut stream = open(&harness, CancellationToken::new()).await.unwrap();
        let mut target = harness.accept_forwarded().await;

        tokio::time::timeout(Duration::from_secs(5), async {
            stream.write_all(b"client\0\xff").await.unwrap();
            let mut from_client = [0; 8];
            target.read_exact(&mut from_client).await.unwrap();
            assert_eq!(&from_client, b"client\0\xff");

            target.write_all(b"server\0\xfe").await.unwrap();
            let mut from_server = [0; 8];
            stream.read_exact(&mut from_server).await.unwrap();
            assert_eq!(&from_server, b"server\0\xfe");
        })
        .await
        .unwrap();
        assert_eq!(
            *harness.observed.forwards.lock().unwrap(),
            vec![("desktop.internal".into(), 5900, "127.0.0.1".into(), 0)]
        );
        resolve.assert_calls_async(1).await;

        tokio::time::timeout(Duration::from_secs(5), stream.shutdown())
            .await
            .unwrap()
            .unwrap();
        wait_for(|| harness.observed.closed.load(Ordering::SeqCst) == 1).await;
        harness.shutdown().await;
    }
}

#[tokio::test]
async fn forwarding_capacity_is_independent_from_guest_request_admission_and_releases_on_drop() {
    let mut harness = Harness::new(Reply::default()).await;
    let _resolve = harness.resolve(harness.credential(true)).await;
    let first = open(&harness, CancellationToken::new()).await.unwrap();
    let first_target = harness.accept_forwarded().await;
    let second = open(&harness, CancellationToken::new()).await.unwrap();
    let second_target = harness.accept_forwarded().await;

    assert_eq!(
        failure(open(&harness, CancellationToken::new()).await),
        FailureReason::ResourceExhausted
    );
    assert_eq!(
        terminal(&harness.request(params()).await)["type"],
        "finished"
    );

    drop(first);
    drop(first_target);
    wait_for(|| harness.observed.closed.load(Ordering::SeqCst) >= 1).await;
    let replacement = open(&harness, CancellationToken::new()).await.unwrap();
    let replacement_target = harness.accept_forwarded().await;

    drop(replacement);
    drop(replacement_target);
    drop(second);
    drop(second_target);
    harness.shutdown().await;
}

#[tokio::test]
async fn channel_refusal_wrong_password_and_bad_host_key_are_bounded_and_never_forward_bytes() {
    let mut refused = Harness::new(Reply::default()).await;
    refused
        .observed
        .reject_forwards
        .store(true, Ordering::SeqCst);
    let _resolve = refused.resolve(refused.credential(true)).await;
    assert_eq!(
        failure(open(&refused, CancellationToken::new()).await),
        FailureReason::Protocol
    );
    wait_for(|| refused.observed.closed.load(Ordering::SeqCst) == 1).await;
    refused.shutdown().await;

    let mut target_refused = Harness::new(Reply::default()).await;
    target_refused
        .observed
        .fail_forward_connect
        .store(true, Ordering::SeqCst);
    let _resolve = target_refused
        .resolve(target_refused.credential(true))
        .await;
    assert_eq!(
        failure(open(&target_refused, CancellationToken::new()).await),
        FailureReason::Protocol
    );
    wait_for(|| target_refused.observed.closed.load(Ordering::SeqCst) == 1).await;
    target_refused.shutdown().await;

    let mut wrong = Harness::new(Reply::default()).await;
    let _resolve = wrong
        .resolve(password_credential(&wrong, "wrong-password-canary"))
        .await;
    assert_eq!(
        failure(open(&wrong, CancellationToken::new()).await),
        FailureReason::AuthenticationFailed
    );
    assert!(wrong.observed.forwards.lock().unwrap().is_empty());
    wrong.shutdown().await;

    let mut mismatch = Harness::new(Reply::default()).await;
    let mut credential = mismatch.credential(true);
    let other = key(Algorithm::Ed25519);
    credential["learnedHostKey"] = json!({
        "algorithm": other.algorithm().as_str(),
        "fingerprint": other.fingerprint(HashAlg::Sha256).to_string()
    });
    let _resolve = mismatch.resolve(credential).await;
    assert_eq!(
        failure(open(&mismatch, CancellationToken::new()).await),
        FailureReason::HostKeyMismatch
    );
    assert!(mismatch.observed.forwards.lock().unwrap().is_empty());
    mismatch.shutdown().await;
}

#[tokio::test]
async fn early_target_eof_retires_physical_transport_before_stream_drop() {
    let mut harness = Harness::new(Reply::default()).await;
    let _resolve = harness.resolve(harness.credential(true)).await;
    let mut stream = open(&harness, CancellationToken::new()).await.unwrap();
    let target = harness.accept_forwarded().await;
    drop(target);

    let mut byte = [0; 1];
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), stream.read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    wait_for(|| harness.observed.closed.load(Ordering::SeqCst) == 1).await;
    drop(stream);
    harness.shutdown().await;
}

#[tokio::test]
async fn caller_cancellation_and_authority_invalidation_interrupt_active_streams() {
    let mut cancelled = Harness::new(Reply::default()).await;
    let _resolve = cancelled.resolve(cancelled.credential(true)).await;
    assert_eq!(
        terminal(&cancelled.request(params()).await)["type"],
        "finished"
    );
    assert_eq!(cancelled.observed.auth.load(Ordering::SeqCst), 1);
    let token = CancellationToken::new();
    let mut stream = open(&cancelled, token.clone()).await.unwrap();
    let _target = cancelled.accept_forwarded().await;
    assert_eq!(
        cancelled.observed.auth.load(Ordering::SeqCst),
        1,
        "forward must observe its caller token even when it checks out an idle transport"
    );
    token.cancel();
    wait_for(|| cancelled.observed.closed.load(Ordering::SeqCst) == 1).await;
    let mut byte = [0; 1];
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut byte))
        .await
        .unwrap();
    assert!(matches!(read, Ok(0) | Err(_)));
    cancelled.shutdown().await;

    let mut invalidated = Harness::new(Reply::default()).await;
    let _resolve = invalidated.resolve(invalidated.credential(true)).await;
    let mut stream = open(&invalidated, CancellationToken::new()).await.unwrap();
    let _target = invalidated.accept_forwarded().await;
    assert!(invalidated.runtime.ably_message(&ably_subscriber::Message {
        name: Some("ssh-authority-invalidated".into()),
        data: json!({"runId":invalidated.run,"connectionId":CONNECTION}),
        id: None,
        client_id: None,
        timestamp: None,
    }));
    wait_for(|| invalidated.observed.closed.load(Ordering::SeqCst) == 1).await;
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut byte))
        .await
        .unwrap();
    assert!(matches!(read, Ok(0) | Err(_)));
    invalidated.shutdown().await;
}

#[tokio::test]
async fn expired_setup_and_run_cancellation_fail_without_leaking_forward_capacity() {
    let mut expired = Harness::new(Reply::default()).await;
    let resolve = expired.resolve(expired.credential(true)).await;
    let invalid = expired
        .ssh()
        .open_direct_tcpip(
            connection(),
            7,
            "https://desktop.internal",
            5900,
            CancellationToken::new(),
            Instant::now() + Duration::from_secs(10),
        )
        .await;
    assert_eq!(failure(invalid), FailureReason::UnsafeDestination);
    let result = expired
        .ssh()
        .open_direct_tcpip(
            connection(),
            7,
            "desktop.internal",
            5900,
            CancellationToken::new(),
            Instant::now(),
        )
        .await;
    assert_eq!(failure(result), FailureReason::TimedOut);
    resolve.assert_calls_async(0).await;
    expired.shutdown().await;

    let mut ended = Harness::new(Reply::default()).await;
    let _resolve = ended.resolve(ended.credential(true)).await;
    let mut stream = open(&ended, CancellationToken::new()).await.unwrap();
    let _target = ended.accept_forwarded().await;
    ended.cancel.cancel();
    wait_for(|| ended.observed.closed.load(Ordering::SeqCst) == 1).await;
    let mut byte = [0; 1];
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut byte))
        .await
        .unwrap();
    assert!(matches!(read, Ok(0) | Err(_)));
    ended.shutdown().await;
}
