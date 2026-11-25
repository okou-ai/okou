use super::*;
use crate::{
    app_state,
    test_fixtures::http::{HttpClientConfig, http_client},
};
use httpmock::prelude::*;
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_rpc_proto::stream::{Frame, Reader, Writer};
use sha2::{Digest, Sha256};
use tokio::time::Instant;
use uuid::Uuid;

#[tokio::test]
async fn app_state_delivers_only_to_an_authorized_assignment_and_repeats_the_receipt() {
    let server = MockServer::start_async().await;
    let http = http_client(HttpClientConfig {
        api_url: server.base_url(),
        vercel_bypass: None,
        client_session_id: "test".into(),
    });
    let runtime = app_state::Runtime::new(
        http,
        "test-service",
        RunnerProcessIdentity::new(Uuid::new_v4(), 7).unwrap(),
    );
    let mut rpc = Runtime::new(None, None, None);
    rpc.app_state = Some(runtime.clone());
    let h = Harness::with_runtime(rpc, false);
    let assigned = runtime.run(h.run_id).unwrap();
    let host = Uuid::new_v4();
    let command = Uuid::new_v4();
    let grant = server
        .mock_async(|when, then| {
            when.method(POST)
                .path(format!(
                    "/api/runners/runs/{}/computer-use/commands/{command}/check",
                    h.run_id
                ))
                .header("authorization", "Bearer test-service");
            then.status(200)
                .json_body(json!({"hostId": host, "claimed": true}));
        })
        .await;
    let bytes = bytes::Bytes::from(vec![42u8; 180_001]);
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    let deadline = Instant::now() + Duration::from_secs(8);
    let upload = || {
        assigned.deliver(
            command,
            host,
            deadline,
            digest,
            bytes.clone(),
            runtime.reserve_upload().unwrap(),
        )
    };
    let guest = async {
        let mut guest = h.open("assigned-sandbox").await;
        send(&mut guest, &serde_json::to_vec(&json!({"version":1,"method":"computer.appState.receive","params":{"commandId":command}})).unwrap()).await;
        let (input, output) = tokio::io::split(guest);
        let mut frames = Reader::responses(input);
        let mut sink = Writer::input(output);
        assert!(matches!(
            frames.next().await.unwrap(),
            Some(Frame::Control(runner_rpc_proto::Response::Event { .. }))
        ));
        let mut received = Vec::new();
        loop {
            match frames.next().await.unwrap() {
                Some(Frame::Data(data)) => received.extend_from_slice(&data),
                Some(Frame::End) => break,
                _ => panic!("incomplete app state"),
            }
        }
        assert_eq!(received.as_slice(), bytes.as_ref());
        sink.send(&Frame::Data(digest.to_vec())).await.unwrap();
        sink.send(&Frame::End).await.unwrap();
        assert!(matches!(
            frames.next().await.unwrap(),
            Some(Frame::Control(runner_rpc_proto::Response::Result { .. }))
        ));
        assert!(frames.next().await.unwrap().is_none());
    };
    let (receipt, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(upload(), guest)
    })
    .await
    .unwrap();
    assert_eq!(receipt.unwrap(), hex::encode(digest));
    assert_eq!(upload().await.unwrap(), hex::encode(digest));
    let other = bytes::Bytes::from_static(b"changed window");
    assert_eq!(
        assigned
            .deliver(
                command,
                host,
                deadline,
                Sha256::digest(&other).into(),
                other,
                runtime.reserve_upload().unwrap()
            )
            .await,
        Err(app_state::UploadError::Conflict)
    );
    grant.delete_async().await;
    let revoked = Uuid::new_v4();
    let mut reader = h.open("assigned-sandbox").await;
    send(&mut reader, &serde_json::to_vec(&json!({"version":1,"method":"computer.appState.receive","params":{"commandId":revoked}})).unwrap()).await;
    let (delivery, replies) = tokio::join!(
        assigned.deliver(
            revoked,
            host,
            deadline,
            digest,
            bytes.clone(),
            runtime.reserve_upload().unwrap()
        ),
        frames(reader)
    );
    assert_eq!(delivery, Err(app_state::UploadError::Expired));
    assert_eq!(replies, error("unavailable"));
    let run_id = h.run_id;
    h.shutdown().await;
    assert!(runtime.run(run_id).is_none());
}
