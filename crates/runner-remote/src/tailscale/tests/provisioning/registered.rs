//! Real TLS/OAuth/key/Noise/map/DERP composition under an exact Run registration.
//! Only synthetic external services and their explicit certificate roots differ.

use std::sync::{Arc, Mutex};

use runner_types::ids::RunId;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::regional_fixture::{Relay, map};
use super::{configuration, fixture::Service as Api};
use crate::{
    ssh::FailureReason,
    tailscale::tests::fixture::Cache,
    tailscale::{
        Failure,
        tests::{
            derp::fixture::{Server, WriteGate},
            fixture::bounded,
            startup::secure::{KeyReply, Service as Control},
        },
    },
};

const ACCEPTED: &[u8] = br#"{"User":{"ID":1},"Login":{"ID":1,"Provider":"synthetic","LoginName":"synthetic"},"MachineAuthorized":true,"NodeKeyExpired":false,"Error":"","AuthURL":""}"#;

#[tokio::test]
async fn configured_tls_oauth_noise_error_and_auth_url_remain_private_through_actual_root() {
    const CANARY: &str = "CONFIGURED-TLS-NOISE-PRIVATE-CANARY-37639";
    #[derive(Clone)]
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let writer = Capture(Arc::clone(&bytes));
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    let dispatch = tracing::Dispatch::new(subscriber);
    let _parent = tracing::dispatcher::set_default(&dispatch);
    tracing::warn!(target: "hyper", "ordinary parent HTTP diagnostic");
    let api = Api::secure(None).await;
    let relay = Server::secure().await;
    let mut response: serde_json::Value = serde_json::from_slice(ACCEPTED).unwrap();
    response["Error"] = CANARY.into();
    response["AuthURL"] = format!("https://synthetic.invalid/{CANARY}").into();
    let body = serde_json::to_vec(&response).unwrap();
    let control = Control::new(body, map(&relay), KeyReply::Valid, false).await;
    let descriptors = Arc::new(Mutex::new(Vec::new()));
    let cache = Cache::new();
    let run = cache.register_with_diagnostics(RunId::new_v4(), true);
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let dial = api.secure.as_ref().unwrap().clone();
    let config = configuration(uuid::Uuid::new_v4());
    let node = access
        .native_configured(
            config.clone(),
            control.provisioned_root_factory(
                dial.clone(),
                Relay::new(&relay, WriteGate::new(), Arc::clone(&descriptors)),
            ),
        )
        .unwrap();
    control.allow_all();
    assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
    bounded(node.physical()).await.unwrap();
    let retained = serde_json::to_value(
        node.diagnostic_source(config.key())
            .evidence
            .layers()
            .snapshot(),
    )
    .unwrap();
    assert_eq!(retained["root"], "startup");
    assert!(
        retained["steps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["stage"] == "registration"
                && s["status"] == "failed"
                && s["detail"] == "rejected"),
        "{retained}"
    );
    assert!(!retained.to_string().contains(CANARY));
    bounded(run.shutdown_native()).await.unwrap();
    dial.assert_closed(2);
    control.assert_control_closed();
    api.assert_contract(1, 0);
    assert!(descriptors.lock().unwrap().is_empty());
    relay.task.abort();
    let Err(error) = bounded(relay.task).await else {
        panic!("unused external DERP fixture ran");
    };
    assert!(error.is_cancelled());
    api.finish().await;
    control.finish().await;
    tracing::warn!(target: "hyper", "ordinary parent HTTP diagnostic after cleanup");
    let log = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
    assert!(log.contains("ordinary parent HTTP diagnostic after cleanup"));
    assert!(log.contains("native Tailscale startup"));
    assert!(log.contains("noise") && log.contains("registration"));
    for private in [
        CANARY,
        "synthetic-secret",
        "synthetic-access-token",
        "tskey-auth-synthetic-one-use",
    ] {
        assert!(
            !log.contains(private),
            "configured private diagnostic escaped"
        );
    }
}

#[tokio::test]
async fn configured_tls_oauth_key_and_authenticated_root_share_one_physical_run_owner() {
    use tracing_subscriber::prelude::*;
    let captured = tracing_test_support::CapturedEvents::default();
    let dispatch = tracing::Dispatch::new(tracing_subscriber::registry().with(captured.clone()));
    let _parent = tracing::dispatcher::set_default(&dispatch);
    let api = Api::secure(None).await;
    // A separate loopback client abandons TLS before sending a ClientHello.
    // Observe its retirement before starting the real provisioning exchange.
    let mut abandoned = tokio::net::TcpStream::connect(api.dial.0).await.unwrap();
    abandoned.shutdown().await.unwrap();
    let mut byte = [0];
    assert_eq!(bounded(abandoned.read(&mut byte)).await.unwrap(), 0);
    drop(abandoned);
    let relay = Server::secure().await;
    let control = Control::new(ACCEPTED.to_vec(), map(&relay), KeyReply::Valid, false).await;
    let gate = WriteGate::new();
    let descriptors = Arc::new(Mutex::new(Vec::new()));
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let dial = api.secure.as_ref().unwrap().clone();
    let config = configuration(uuid::Uuid::new_v4());
    let node = access
        .native_configured(
            config.clone(),
            control.provisioned_root_factory(
                dial.clone(),
                Relay::new(&relay, Arc::clone(&gate), Arc::clone(&descriptors)),
            ),
        )
        .unwrap();
    control.allow_all();
    bounded(node.ready()).await.unwrap();
    assert!(
        node.diagnostic_source(config.key())
            .evidence
            .layers()
            .snapshot()
            .is_none(),
        "disabled consumers must not activate native collection, including through a source read"
    );
    assert_eq!(control.announced_home(), vec![1]);
    assert_eq!(control.logout_count(), 0);
    control.set_logout_reply(
        hyper::StatusCode::OK,
        br#"{"NodeKeyExpired":true}"#.to_vec(),
    );
    let (mut frames, _) = bounded(relay.task).await.unwrap();
    run.close();
    bounded(node.physical()).await.unwrap();
    assert!(matches!(
        node.dial("100.64.0.2", 22).await,
        Err(Failure::Cancelled)
    ));
    bounded(run.shutdown_native()).await.unwrap();
    bounded(gate.destroyed()).await;
    crate::tailscale::tests::peers::relay::closed(frames.get_mut(), true).await;
    assert_eq!(descriptors.lock().unwrap().len(), 1);
    control.assert_control_closed();
    assert_eq!(control.logout_count(), 1);
    dial.assert_closed(2);
    // A possibly consumed key is never deleted as an unused key. Validated
    // registration + map + relay readiness allows later legitimate lifetimes.
    api.assert_contract(1, 0);
    api.finish().await;
    control.finish().await;
    let events = captured.entries();
    let logout = events
        .iter()
        .filter(|event| event.fields.get("stage").map(String::as_str) == Some("logout"))
        .collect::<Vec<_>>();
    assert_eq!(logout.len(), 1);
    assert_eq!(logout[0].level, tracing::Level::INFO);
    assert_eq!(logout[0].fields["reason"], "confirmed");
    let startup = events
        .iter()
        .filter(|event| {
            event.fields.get("message").map(String::as_str) == Some("native Tailscale startup")
        })
        .collect::<Vec<_>>();
    assert!(
        startup
            .iter()
            .all(|event| event.level == tracing::Level::INFO)
    );
    assert_eq!(
        startup
            .iter()
            .map(|event| (
                event.fields["stage"].as_str(),
                event.fields["reason"].as_str()
            ))
            .collect::<Vec<_>>(),
        vec![
            ("provisioning", "starting"),
            ("key_tls", "starting"),
            ("control_key", "starting"),
            ("control_tls", "starting"),
            ("noise", "starting"),
            ("registration", "starting"),
            ("map", "starting"),
            ("map_response", "starting"),
            ("derp_map", "starting"),
            ("local_node", "starting"),
            ("peers", "starting"),
            ("home_announcement", "starting"),
            ("relay", "starting"),
            ("ready", "ready"),
        ]
    );
    for private in [
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

#[tokio::test]
async fn cancelling_a_received_registration_or_unready_map_never_deletes_or_recreates_its_key() {
    for before_map in [true, false] {
        let api = Api::secure(None).await;
        let relay = Server::secure().await;
        let control = Control::new(ACCEPTED.to_vec(), map(&relay), KeyReply::Valid, false).await;
        let descriptors = Arc::new(Mutex::new(Vec::new()));
        let cache = Cache::new();
        let run_id = RunId::new_v4();
        let run = cache.register(run_id);
        let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
        let id = uuid::Uuid::new_v4();
        let dial = api.secure.as_ref().unwrap().clone();
        let node = access
            .native_configured(
                configuration(id),
                control.provisioned_root_factory(
                    dial.clone(),
                    Relay::new(&relay, WriteGate::new(), Arc::clone(&descriptors)),
                ),
            )
            .unwrap();
        control.key_response.cancel();
        control.registration_requested().await;
        if !before_map {
            control.allow_registration();
            control.map_requested().await;
        }
        let replacement = cache.register(run_id);
        assert_eq!(bounded(node.ready()).await, Err(Failure::Cancelled));
        bounded(node.physical()).await.unwrap();
        assert_eq!(control.logout_count(), 1);
        drop(node);
        let fresh = replacement.lookup(uuid::Uuid::new_v4()).unwrap();
        assert!(matches!(
            fresh.native_configured(
                configuration(id),
                control.provisioned_root_factory(
                    dial.clone(),
                    Relay::new(&relay, WriteGate::new(), Arc::clone(&descriptors))
                )
            ),
            Err(FailureReason::AuthorityFailure)
        ));
        bounded(run.shutdown_native()).await.unwrap();
        replacement.close();
        bounded(replacement.shutdown_native()).await.unwrap();
        assert!(descriptors.lock().unwrap().is_empty());
        control.assert_control_closed();
        dial.assert_closed(2);
        api.assert_contract(1, 0);
        relay.task.abort();
        let Err(error) = bounded(relay.task).await else {
            panic!("unused relay fixture ran")
        };
        assert!(error.is_cancelled());
        api.finish().await;
        control.finish().await;
    }
}

#[tokio::test]
async fn rejected_authenticated_registration_is_not_proof_that_the_key_remained_unused() {
    let api = Api::secure(None).await;
    let mut response: serde_json::Value = serde_json::from_slice(ACCEPTED).unwrap();
    response["Error"] = "synthetic-rejection".into();
    let relay = Server::secure().await;
    let control = Control::new(
        serde_json::to_vec(&response).unwrap(),
        map(&relay),
        KeyReply::Valid,
        false,
    )
    .await;
    let descriptors = Arc::new(Mutex::new(Vec::new()));
    let cache = Cache::new();
    let run_id = RunId::new_v4();
    let run = cache.register(run_id);
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let id = uuid::Uuid::new_v4();
    let dial = api.secure.as_ref().unwrap().clone();
    let node = access
        .native_configured(
            configuration(id),
            control.provisioned_root_factory(
                dial.clone(),
                Relay::new(&relay, WriteGate::new(), Arc::clone(&descriptors)),
            ),
        )
        .unwrap();
    control.allow_all();
    assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
    bounded(node.physical()).await.unwrap();
    drop(node);
    cache.invalidate(run_id, None);
    let fresh = run.lookup(uuid::Uuid::new_v4()).unwrap();
    assert!(matches!(
        fresh.native_configured(
            configuration(id),
            control.provisioned_root_factory(
                dial.clone(),
                Relay::new(&relay, WriteGate::new(), Arc::clone(&descriptors))
            )
        ),
        Err(FailureReason::AuthorityFailure)
    ));
    bounded(run.shutdown_native()).await.unwrap();
    dial.assert_closed(2);
    control.assert_control_closed();
    api.assert_contract(1, 0);
    assert!(descriptors.lock().unwrap().is_empty());
    relay.task.abort();
    let Err(error) = bounded(relay.task).await else {
        panic!("unused relay fixture ran")
    };
    assert!(error.is_cancelled());
    api.finish().await;
    control.finish().await;
}

#[tokio::test]
async fn unsafe_or_oversized_regional_map_metadata_never_reaches_a_relay_socket() {
    for case in [
        "wrong-region",
        "bad-pin",
        "test-tls",
        "too-many-nodes",
        "duplicate-names",
        "too-many-regions",
        "no-home",
        "disabled",
        "missing-map",
    ] {
        let api = Api::secure(None).await;
        let relay = Server::secure().await;
        let mut value: serde_json::Value = serde_json::from_slice(&map(&relay)).unwrap();
        match case {
            "wrong-region" => value["DERPMap"]["Regions"]["1"]["Nodes"][0]["RegionID"] = 2.into(),
            "bad-pin" => {
                value["DERPMap"]["Regions"]["1"]["Nodes"][0]["CertName"] = "sha256-raw:bad".into()
            }
            "test-tls" => {
                value["DERPMap"]["Regions"]["1"]["Nodes"][0]["InsecureForTests"] = true.into()
            }
            "too-many-nodes" => {
                let node = value["DERPMap"]["Regions"]["1"]["Nodes"][0].clone();
                value["DERPMap"]["Regions"]["1"]["Nodes"] = (0..9)
                    .map(|index| {
                        let mut node = node.clone();
                        node["Name"] = format!("1-{index}").into();
                        node
                    })
                    .collect::<Vec<_>>()
                    .into();
            }
            "duplicate-names" => {
                let node = value["DERPMap"]["Regions"]["1"]["Nodes"][0].clone();
                value["DERPMap"]["Regions"]["1"]["Nodes"] = vec![node; 2].into();
            }
            "too-many-regions" => {
                let region = value["DERPMap"]["Regions"]["1"].clone();
                for id in 2..=129 {
                    let mut extra = region.clone();
                    extra["RegionID"] = id.into();
                    extra["Nodes"][0]["RegionID"] = id.into();
                    extra["Nodes"][0]["Name"] = format!("{id}a").into();
                    value["DERPMap"]["Regions"][id.to_string()] = extra;
                }
            }
            "no-home" => value["DERPMap"]["Regions"]["1"]["NoMeasureNoHome"] = true.into(),
            "disabled" => value["DERPMap"]["Regions"]["1"]["Nodes"][0]["IPv4"] = "none".into(),
            _ => {
                value.as_object_mut().unwrap().remove("DERPMap");
            }
        }
        let control = Control::new(
            ACCEPTED.to_vec(),
            serde_json::to_vec(&value).unwrap(),
            KeyReply::Valid,
            false,
        )
        .await;
        let descriptors = Arc::new(Mutex::new(Vec::new()));
        let cache = Cache::new();
        let run = cache.register(RunId::new_v4());
        let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
        let dial = api.secure.as_ref().unwrap().clone();
        let node = access
            .native_configured(
                configuration(uuid::Uuid::new_v4()),
                control.provisioned_root_factory(
                    dial.clone(),
                    Relay::new(&relay, WriteGate::new(), Arc::clone(&descriptors)),
                ),
            )
            .unwrap();
        control.allow_all();
        assert_eq!(
            bounded(node.ready()).await,
            Err(Failure::DomainFailed),
            "{case}"
        );
        bounded(node.physical()).await.unwrap();
        bounded(run.shutdown_native()).await.unwrap();
        assert!(descriptors.lock().unwrap().is_empty(), "{case}");
        assert!(control.announced_home().is_empty(), "{case}");
        control.assert_control_closed();
        dial.assert_closed(2);
        api.assert_contract(1, 0);
        relay.task.abort();
        let Err(error) = bounded(relay.task).await else {
            panic!("unused relay ran: {case}")
        };
        assert!(error.is_cancelled());
        api.finish().await;
        control.finish().await;
    }
}
