//! Run teardown sends one authenticated logout; remote failure cannot strand
//! the worker, its owned sockets or the already-consumed OAuth auth key.

use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use runner_types::ids::RunId;
use tracing_subscriber::prelude::*;

use super::{
    configuration,
    fixture::Service as Api,
    regional_fixture::{Relay, map},
};
use crate::{
    tailscale::tests::fixture::Cache,
    tailscale::tests::{
        derp::fixture::{Server, WriteGate},
        fixture::bounded,
        startup::secure::{KeyReply, Service as Control},
    },
};

const ACCEPTED: &[u8] = br#"{"User":{"ID":1},"Login":{"ID":1,"Provider":"synthetic","LoginName":"synthetic"},"MachineAuthorized":true,"NodeKeyExpired":false,"Error":"","AuthURL":""}"#;

#[tokio::test]
async fn logout_timeout_keeps_the_control_owner_until_physical_cleanup_then_releases_every_socket()
{
    let captured = tracing_test_support::CapturedEvents::default();
    let dispatch = tracing::Dispatch::new(tracing_subscriber::registry().with(captured.clone()));
    let _parent = tracing::dispatcher::set_default(&dispatch);
    let api = Api::secure(None).await;
    let relay = Server::secure().await;
    let control = Control::new(ACCEPTED.to_vec(), map(&relay), KeyReply::Valid, false).await;
    control.pause_logout();
    let gate = WriteGate::new();
    let descriptors = Arc::new(Mutex::new(Vec::new()));
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let dial = api.secure.as_ref().unwrap().clone();
    let node = run
        .lookup(uuid::Uuid::new_v4())
        .unwrap()
        .native_configured(
            configuration(uuid::Uuid::new_v4()),
            control.provisioned_root_factory(
                dial.clone(),
                Relay::new(&relay, Arc::clone(&gate), Arc::clone(&descriptors)),
            ),
        )
        .unwrap();
    control.allow_all();
    bounded(node.ready()).await.unwrap();
    assert_eq!(control.logout_count(), 0);
    let (mut frames, _) = bounded(relay.task).await.unwrap();
    run.close();
    control.logout_requested().await;
    control.assert_control_open();
    assert!(node.physical().now_or_never().is_none());
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    bounded(gate.destroyed()).await;
    crate::tailscale::tests::peers::relay::closed(frames.get_mut(), true).await;
    control.assert_control_closed();
    assert_eq!(control.logout_count(), 1);
    assert_eq!(descriptors.lock().unwrap().len(), 1);
    dial.assert_closed(2);
    api.assert_contract(1, 0);
    api.finish().await;
    control.finish().await;
    let events = captured.entries();
    let logout = events
        .iter()
        .filter(|event| event.fields.get("stage").map(String::as_str) == Some("logout"))
        .collect::<Vec<_>>();
    assert_eq!(logout.len(), 1);
    assert_eq!(logout[0].level, tracing::Level::WARN);
    assert_eq!(logout[0].fields["reason"], "timed_out");
}

#[tokio::test]
async fn logout_replies_are_bounded_private_and_never_replayed_or_allowed_to_block_run_cleanup() {
    const CANARY: &str = "PRIVATE-LOGOUT-REPLY-CANARY";
    let errors = [
        (hyper::StatusCode::FORBIDDEN, CANARY.as_bytes().to_vec()),
        (
            hyper::StatusCode::OK,
            serde_json::to_vec(&serde_json::json!({"Error": CANARY})).unwrap(),
        ),
        (
            hyper::StatusCode::OK,
            serde_json::to_vec(&serde_json::json!({
                "AuthURL": format!("https://synthetic.invalid/{CANARY}")
            }))
            .unwrap(),
        ),
        (hyper::StatusCode::OK, CANARY.as_bytes().to_vec()),
        (hyper::StatusCode::OK, b"[]".to_vec()),
        (hyper::StatusCode::OK, br#"["", ""]"#.to_vec()),
        (hyper::StatusCode::OK, b"{} {}".to_vec()),
    ];
    let boundary_replies = [
        (65_536, tracing::Level::INFO, "confirmed"),
        (65_537, tracing::Level::WARN, "unconfirmed"),
    ]
    .map(|(bytes, level, reason)| {
        // Both replies succeed without the byte cap, so JSON parsing cannot
        // mask a missing limit. Keep the boundary independent of that limit.
        let mut body = vec![b' '; bytes - 2];
        body.extend_from_slice(b"{}");
        assert_eq!(body.len(), bytes);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            serde_json::json!({})
        );
        (hyper::StatusCode::OK, body, level, reason)
    });
    let replies = errors
        .into_iter()
        .map(|(status, body)| (status, body, tracing::Level::WARN, "unconfirmed"))
        .chain(boundary_replies);
    for (status, body, level, reason) in replies {
        let body_bytes = body.len();
        let captured = tracing_test_support::CapturedEvents::default();
        let dispatch =
            tracing::Dispatch::new(tracing_subscriber::registry().with(captured.clone()));
        let _parent = tracing::dispatcher::set_default(&dispatch);
        let api = Api::secure(None).await;
        let relay = Server::secure().await;
        let control = Control::new(ACCEPTED.to_vec(), map(&relay), KeyReply::Valid, false).await;
        control.set_logout_reply(status, body);
        let gate = WriteGate::new();
        let descriptors = Arc::new(Mutex::new(Vec::new()));
        let cache = Cache::new();
        let run = cache.register(RunId::new_v4());
        let dial = api.secure.as_ref().unwrap().clone();
        let node = run
            .lookup(uuid::Uuid::new_v4())
            .unwrap()
            .native_configured(
                configuration(uuid::Uuid::new_v4()),
                control.provisioned_root_factory(
                    dial.clone(),
                    Relay::new(&relay, Arc::clone(&gate), Arc::clone(&descriptors)),
                ),
            )
            .unwrap();
        control.allow_all();
        bounded(node.ready()).await.unwrap();
        assert_eq!(control.logout_count(), 0);
        let (mut frames, _) = bounded(relay.task).await.unwrap();
        run.close();
        bounded(node.physical()).await.unwrap();
        bounded(run.shutdown_native()).await.unwrap();
        bounded(gate.destroyed()).await;
        crate::tailscale::tests::peers::relay::closed(frames.get_mut(), true).await;
        assert_eq!(control.logout_count(), 1);
        control.assert_control_closed();
        dial.assert_closed(2);
        api.assert_contract(1, 0);
        api.finish().await;
        control.finish().await;
        let events = captured.entries();
        let logout = events
            .iter()
            .filter(|event| event.fields.get("stage").map(String::as_str) == Some("logout"))
            .collect::<Vec<_>>();
        assert_eq!(logout.len(), 1);
        assert_eq!(logout[0].level, level, "{body_bytes}-byte response");
        assert_eq!(
            logout[0].fields["reason"], reason,
            "{body_bytes}-byte response"
        );
        for private in [
            CANARY,
            "synthetic-secret",
            "synthetic-access-token",
            "tskey-auth-synthetic-one-use",
        ] {
            assert!(
                events
                    .iter()
                    .all(|event| { event.fields.values().all(|value| !value.contains(private)) })
            );
        }
    }
}
