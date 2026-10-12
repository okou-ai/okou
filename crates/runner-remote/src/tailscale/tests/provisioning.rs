pub(crate) mod fixture;
pub(crate) mod regional_fixture;
mod regional_tcp;
mod resolver;

#[tokio::test]
async fn closing_an_undispatched_fixed_producer_joins_its_actual_worker_before_startup_io() {
    use super::super::{Pool, Registry, producer};
    let registry = Registry::new(Arc::new(Pool::new()));
    let node = registry
        .acquire_configured(configuration(uuid::Uuid::new_v4()), producer::work)
        .unwrap();
    // The exact fixed production constructor is retained, but no winning Cache
    // admission has released its real worker's one-shot start latch.
    drop(node);
    bounded(registry.shutdown()).await.unwrap();
}
mod registered;

use std::sync::Arc;

use runner_types::ids::RunId;

use super::{
    super::{Configuration, Control, Failure, Work, provisioning::Provider},
    fixture::bounded,
};
use crate::ssh::{FailureReason, cache::Cache};
use fixture::{Loopback, Phase, Service};

fn configuration(id: uuid::Uuid) -> Configuration {
    Configuration::new(
        id,
        1,
        serde_json::from_value(serde_json::json!("synthetic-client")).unwrap(),
        serde_json::from_value(serde_json::json!("synthetic-secret")).unwrap(),
        vec!["tag:ssh".to_owned()],
    )
    .unwrap()
}

fn factory(
    dial: Loopback,
    panic_after_key: bool,
) -> impl FnOnce(Configuration, Arc<super::super::Journal>) -> Work {
    move |configuration, journal| {
        Box::new(move |control: Control| {
            Box::pin(async move {
                let provider = Provider::new(configuration, journal, dial, &control)?;
                let _key = provider.create().await?;
                if panic_after_key {
                    panic!("synthetic startup panic after captured key");
                }
                // Component readiness here identifies completed provision IO only;
                // it is not claimed as full Root/common SSH qualification.
                control.ready();
                control.cancelled().cancelled().await;
                Ok(())
            })
        })
    }
}

#[tokio::test]
async fn unused_key_cleanup_survives_run_close_and_deletes_only_the_captured_encoded_id() {
    let service = Service::new(None, None, 200).await;
    let cache = Cache::new();
    let registration = cache.register(RunId::new_v4());
    let access = registration.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access
        .native_configured(
            configuration(uuid::Uuid::new_v4()),
            factory(service.dial.clone(), false),
        )
        .unwrap();
    bounded(node.ready()).await.unwrap();
    registration.close();
    bounded(node.physical()).await.unwrap();
    registration.shutdown_native().await.unwrap();
    service.assert_contract(1, 1);
    service.finish().await;
}

#[tokio::test]
async fn cancelling_an_accepted_create_without_its_id_seals_the_attempt_and_reports_cleanup_failure()
 {
    let mut service = Service::new(Some(Phase::Create), None, 200).await;
    let cache = Cache::new();
    let run = RunId::new_v4();
    let registration = cache.register(run);
    let access = registration.lookup(uuid::Uuid::new_v4()).unwrap();
    let id = uuid::Uuid::new_v4();
    let node = access
        .native_configured(configuration(id), factory(service.dial.clone(), false))
        .unwrap();
    service.next(Phase::OAuth).await;
    service.next(Phase::Create).await;
    cache.invalidate(run, None);
    assert_eq!(bounded(node.physical()).await, Err(Failure::DomainFailed));
    drop(node);
    let fresh = registration.lookup(uuid::Uuid::new_v4()).unwrap();
    assert!(matches!(
        fresh.native_configured(configuration(id), factory(service.dial.clone(), false)),
        Err(FailureReason::AuthorityFailure)
    ));
    assert_eq!(
        registration.shutdown_native().await,
        Err(Failure::DomainFailed)
    );
    service.create.cancel();
    service.assert_contract(1, 0);
    service.finish().await;
}

#[tokio::test]
async fn replacing_a_run_registration_cannot_recreate_an_accepted_unknown_id() {
    let mut service = Service::new(Some(Phase::Create), None, 200).await;
    let cache = Cache::new();
    let run = RunId::new_v4();
    let old = cache.register(run);
    let id = uuid::Uuid::new_v4();
    let node = old
        .lookup(uuid::Uuid::new_v4())
        .unwrap()
        .native_configured(configuration(id), factory(service.dial.clone(), false))
        .unwrap();
    service.next(Phase::OAuth).await;
    service.next(Phase::Create).await;
    let replacement = cache.register(run);
    let fresh = replacement.lookup(uuid::Uuid::new_v4()).unwrap();
    assert!(matches!(
        fresh.native_configured(configuration(id), factory(service.dial.clone(), false)),
        Err(FailureReason::AuthorityFailure)
    ));
    assert_eq!(bounded(node.physical()).await, Err(Failure::DomainFailed));
    // A late completed worker and a new configuration must not make this Run
    // reusable after an unknown provider effect/required-cleanup failure.
    assert!(matches!(
        fresh.native_configured(
            configuration(uuid::Uuid::new_v4()),
            factory(service.dial.clone(), false)
        ),
        Err(FailureReason::AuthorityFailure)
    ));
    assert_eq!(old.shutdown_native().await, Err(Failure::DomainFailed));
    replacement.close();
    service.create.cancel();
    service.assert_contract(1, 0);
    service.finish().await;
}

#[tokio::test]
async fn replacing_a_run_registration_waits_for_exact_unused_delete_before_another_create() {
    let mut service = Service::new(Some(Phase::Delete), None, 200).await;
    let cache = Cache::new();
    let run = RunId::new_v4();
    let old = cache.register(run);
    let id = uuid::Uuid::new_v4();
    let node = old
        .lookup(uuid::Uuid::new_v4())
        .unwrap()
        .native_configured(configuration(id), factory(service.dial.clone(), false))
        .unwrap();
    bounded(node.ready()).await.unwrap();
    service.next(Phase::OAuth).await;
    service.next(Phase::Create).await;
    let replacement = cache.register(run);
    service.next(Phase::Delete).await;
    let fresh = replacement.lookup(uuid::Uuid::new_v4()).unwrap();
    assert!(matches!(
        fresh.native_configured(configuration(id), factory(service.dial.clone(), false)),
        Err(FailureReason::AuthorityFailure)
    ));
    assert!(matches!(
        fresh.native_configured(
            configuration(uuid::Uuid::new_v4()),
            factory(service.dial.clone(), false)
        ),
        Err(FailureReason::AuthorityFailure)
    ));
    service.delete.cancel();
    bounded(node.physical()).await.unwrap();
    bounded(old.shutdown_native()).await.unwrap();
    let next = fresh
        .native_configured(configuration(id), factory(service.dial.clone(), false))
        .unwrap();
    bounded(next.ready()).await.unwrap();
    replacement.close();
    bounded(next.physical()).await.unwrap();
    bounded(replacement.shutdown_native()).await.unwrap();
    service.assert_contract(2, 2);
    service.finish().await;
}

#[tokio::test]
async fn a_missing_secret_after_a_captured_id_still_runs_owned_unused_key_cleanup() {
    let mut response: serde_json::Value = serde_json::from_slice(&fixture::key_response()).unwrap();
    response.as_object_mut().unwrap().remove("key");
    let service = Service::new(None, Some(serde_json::to_vec(&response).unwrap()), 200).await;
    let cache = Cache::new();
    let registration = cache.register(RunId::new_v4());
    let access = registration.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access
        .native_configured(
            configuration(uuid::Uuid::new_v4()),
            factory(service.dial.clone(), false),
        )
        .unwrap();
    assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
    bounded(node.physical()).await.unwrap();
    registration.shutdown_native().await.unwrap();
    service.assert_contract(1, 1);
    service.finish().await;
}

#[tokio::test]
async fn invalid_capabilities_fail_before_registration_and_cleanup_the_known_unused_id() {
    for field in ["reusable", "ephemeral", "preauthorized", "tags"] {
        let mut response: serde_json::Value =
            serde_json::from_slice(&fixture::key_response()).unwrap();
        let permission = &mut response["capabilities"]["devices"]["create"];
        permission[field] = match field {
            "reusable" => true.into(),
            "tags" => serde_json::json!(["tag:other"]),
            _ => false.into(),
        };
        let service = Service::new(None, Some(serde_json::to_vec(&response).unwrap()), 200).await;
        let cache = Cache::new();
        let registration = cache.register(RunId::new_v4());
        let access = registration.lookup(uuid::Uuid::new_v4()).unwrap();
        let node = access
            .native_configured(
                configuration(uuid::Uuid::new_v4()),
                factory(service.dial.clone(), false),
            )
            .unwrap();
        assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
        bounded(node.physical()).await.unwrap();
        registration.shutdown_native().await.unwrap();
        service.assert_contract(1, 1);
        service.finish().await;
    }
}

#[tokio::test]
async fn a_startup_panic_still_finishes_unused_cleanup_and_preserves_required_failure() {
    let service = Service::new(None, None, 200).await;
    let cache = Cache::new();
    let registration = cache.register(RunId::new_v4());
    let access = registration.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access
        .native_configured(
            configuration(uuid::Uuid::new_v4()),
            factory(service.dial.clone(), true),
        )
        .unwrap();
    assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
    assert_eq!(bounded(node.physical()).await, Err(Failure::DomainFailed));
    assert_eq!(
        registration.shutdown_native().await,
        Err(Failure::DomainFailed)
    );
    service.assert_contract(1, 1);
    service.finish().await;
}

#[tokio::test]
async fn cleanup_rejection_is_not_retried_or_converted_to_physical_success() {
    let service = Service::new(None, None, 500).await;
    let cache = Cache::new();
    let registration = cache.register(RunId::new_v4());
    let access = registration.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access
        .native_configured(
            configuration(uuid::Uuid::new_v4()),
            factory(service.dial.clone(), false),
        )
        .unwrap();
    bounded(node.ready()).await.unwrap();
    registration.close();
    assert_eq!(bounded(node.physical()).await, Err(Failure::DomainFailed));
    assert_eq!(
        registration.shutdown_native().await,
        Err(Failure::DomainFailed)
    );
    service.assert_contract(1, 1);
    service.finish().await;
}

#[tokio::test]
async fn cancelled_or_timed_out_cleanup_waiters_cannot_release_the_four_owned_node_slots() {
    let mut service = Service::new(Some(Phase::Delete), None, 200).await;
    let cache = Cache::new();
    let registration = Arc::new(cache.register(RunId::new_v4()));
    let access = registration.lookup(uuid::Uuid::new_v4()).unwrap();
    let mut nodes = Vec::new();
    for _ in 0..4 {
        let node = access
            .native_configured(
                configuration(uuid::Uuid::new_v4()),
                factory(service.dial.clone(), false),
            )
            .unwrap();
        bounded(node.ready()).await.unwrap();
        nodes.push(node);
    }
    registration.close();
    let waiting = Arc::clone(&registration);
    let waiter = tokio::spawn(async move { waiting.shutdown_native().await });
    for _ in 0..4 {
        service.next(Phase::OAuth).await;
        service.next(Phase::Create).await;
    }
    for _ in 0..4 {
        service.next(Phase::Delete).await;
    }
    waiter.abort();
    assert!(waiter.await.unwrap_err().is_cancelled());
    assert_eq!(
        bounded(registration.shutdown_native()).await,
        Err(Failure::CleanupTimedOut)
    );
    let replacement = cache.register(RunId::new_v4());
    let fresh = replacement.lookup(uuid::Uuid::new_v4()).unwrap();
    assert!(matches!(
        fresh.native_configured(
            configuration(uuid::Uuid::new_v4()),
            factory(service.dial.clone(), false)
        ),
        Err(FailureReason::ResourceExhausted)
    ));
    service.delete.cancel();
    for node in nodes {
        bounded(node.physical()).await.unwrap();
    }
    assert_eq!(
        registration.shutdown_native().await,
        Err(Failure::CleanupTimedOut)
    );
    service.assert_contract(4, 4);
    service.finish().await;
}

#[tokio::test]
async fn an_oversized_create_reply_keeps_the_accepted_effect_unknown_and_never_retries_it() {
    let service = Service::new(None, Some(vec![b' '; 64 * 1024 + 1]), 200).await;
    let cache = Cache::new();
    let run_id = RunId::new_v4();
    let run = cache.register(run_id);
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let id = uuid::Uuid::new_v4();
    let node = access
        .native_configured(configuration(id), factory(service.dial.clone(), false))
        .unwrap();
    assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
    assert_eq!(bounded(node.physical()).await, Err(Failure::DomainFailed));
    drop(node);
    cache.invalidate(run_id, None);
    let fresh = run.lookup(uuid::Uuid::new_v4()).unwrap();
    assert!(matches!(
        fresh.native_configured(configuration(id), factory(service.dial.clone(), false)),
        Err(FailureReason::AuthorityFailure)
    ));
    assert_eq!(run.shutdown_native().await, Err(Failure::DomainFailed));
    service.assert_contract(1, 0);
    service.finish().await;
}

#[tokio::test]
async fn a_json_escaped_key_id_is_captured_and_deleted_as_one_exact_path_component() {
    let response = String::from_utf8(fixture::key_response())
        .unwrap()
        .replace("captured/?other#id", "captured\\u002F?other#id");
    let service = Service::new(None, Some(response.into_bytes()), 200).await;
    let cache = Cache::new();
    let run = cache.register(RunId::new_v4());
    let access = run.lookup(uuid::Uuid::new_v4()).unwrap();
    let node = access
        .native_configured(
            configuration(uuid::Uuid::new_v4()),
            factory(service.dial.clone(), false),
        )
        .unwrap();
    bounded(node.ready()).await.unwrap();
    run.close();
    bounded(node.physical()).await.unwrap();
    bounded(run.shutdown_native()).await.unwrap();
    service.assert_contract(1, 1);
    service.finish().await;
}

#[tokio::test]
async fn production_api_dial_denies_a_caller_outside_the_owned_private_domain() {
    use super::super::provisioning_io::Dial;
    assert!(matches!(
        super::super::provisioning_io::Https(super::super::resolver::Resolver::new())
            .connect()
            .await,
        Err(Failure::DomainFailed)
    ));
}

#[tokio::test]
async fn a_failed_verified_root_handshake_keeps_the_provisioned_key_known_unused() {
    use super::super::{
        node_root::Root, registration::Registration, relay::Relay, relay_driver::Connector,
    };
    struct NoRelay;
    impl Connector for NoRelay {
        async fn connect(&mut self) -> Result<Relay<ts_http_util::Upgraded>, Failure> {
            panic!("DERP cannot precede verified control startup");
        }
    }
    let service = Service::new(None, None, 200).await;
    let cache = Cache::new();
    let registration = cache.register(RunId::new_v4());
    let access = registration.lookup(uuid::Uuid::new_v4()).unwrap();
    let dial = service.dial.clone();
    let node = access
        .native_configured(
            configuration(uuid::Uuid::new_v4()),
            move |configuration, journal| {
                Box::new(move |control: Control| {
                    Box::pin(async move {
                        let (root, _client) = Root::new(control.cancelled());
                        let provider = Provider::new(configuration, journal, dial, &control)?;
                        let native = Registration::with_tags(provider.tags());
                        let key = provider.create().await?;
                        let (key_io, closed_key) = tokio::io::duplex(1024);
                        let (control_io, closed_control) = tokio::io::duplex(1024);
                        drop(closed_key);
                        drop(closed_control);
                        root.start_provisioned(
                            native,
                            key_io,
                            control_io,
                            &key,
                            |_, _| NoRelay,
                            &control,
                        )
                        .await
                    })
                })
            },
        )
        .unwrap();
    assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
    bounded(node.physical()).await.unwrap();
    registration.shutdown_native().await.unwrap();
    service.assert_contract(1, 1);
    service.finish().await;
}
