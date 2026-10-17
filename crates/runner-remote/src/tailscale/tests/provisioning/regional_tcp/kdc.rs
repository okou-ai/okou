//! Native KDC uses the real assignment registry and encrypted peer TCP.
use super::*;
use crate::vnc::tests::{
    harness::Harness,
    native::{
        connect_gateway,
        gateway::{Gateway, HOST},
        kdc::{
            self, Case,
            peer::{Peer as KdcPeer, Reply},
        },
    },
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

fn route(id: uuid::Uuid) -> Value {
    json!({"type":"tailscale","configId":id,"generation":1,"tags":["tag:ssh"],
        "credentials":{"clientId":"synthetic-client","clientSecret":"synthetic-secret"}})
}

#[tokio::test]
async fn cancelled_kdc_creation_retains_unknown_provider_effect_and_rejects_reuse() {
    use super::super::fixture::Phase;
    let mut h = Harness::new().await;
    let cancel = CancellationToken::new();
    let mut api = Api::secure(Some(Phase::Create)).await;
    let home = Server::secure().await;
    let control = Control::new(ACCEPTED.to_vec(), map(&home), KeyReply::Valid, false).await;
    *h.runtime.native_services.lock().unwrap() = Some(control.test_services(
        api.secure.as_ref().unwrap().clone(),
        Relay::new(&home, WriteGate::new(), Arc::new(Mutex::new(Vec::new()))),
    ));
    {
        let exchange = kdc::exercise(
            &h,
            Case {
                route: route(uuid::Uuid::new_v4()),
                host: "peer.synthetic.ts.net".into(),
                port: 88,
                rfb: None,
                cancel: cancel.clone(),
                authority: "valid",
            },
            1,
        );
        tokio::pin!(exchange);
        bounded(async {
            tokio::select! {
                () = async { api.next(Phase::OAuth).await; api.next(Phase::Create).await; } => {},
                result = &mut exchange => panic!("KDC ended before accepted create: {result:?}"),
            }
        })
        .await;
        cancel.cancel();
        assert_eq!(
            exchange.await.unwrap_err(),
            kerberos_worker::Error::Authority
        );
    }
    assert_eq!(
        h.run.shutdown_result().await,
        Err(crate::guest_rpc::CleanupError::Native)
    );
    api.assert_contract(1, 0);
    home.task.abort();
    assert!(matches!(home.task.await, Err(error) if error.is_cancelled()));
    api.finish().await;
    control.finish_unused().await;
}

#[tokio::test]
async fn native_kdc_retains_one_node_across_messages_and_independent_rfb_roles() {
    for role in ["none", "same_tailscale", "different_cloudflare"] {
        let mut h = Harness::new().await;
        let cancel = CancellationToken::new();
        let kdc = KdcPeer::new(Reply::Complete, cancel.clone()).await;
        let api = Api::secure(None).await;
        let home = Server::secure().await;
        let key = NodeKeyPair::random();
        let mut value: Value = serde_json::from_slice(&map(&home)).unwrap();
        let mut peer = node(2, "peer.synthetic.ts.net.", 2, &key);
        peer["HomeDERP"] = 1.into();
        value["Peers"] = vec![peer].into();
        value["PacketFilter"] = json!([]);
        let control = Control::new(
            ACCEPTED.to_vec(),
            serde_json::to_vec(&value).unwrap(),
            KeyReply::Valid,
            false,
        )
        .await;
        control.set_logout_reply(
            hyper::StatusCode::OK,
            br#"{"NodeKeyExpired":true}"#.to_vec(),
        );
        *h.runtime.native_services.lock().unwrap() = Some(control.test_services(
            api.secure.as_ref().unwrap().clone(),
            Relay::new(&home, WriteGate::new(), Arc::new(Mutex::new(Vec::new()))),
        ));
        let id = uuid::Uuid::new_v4();
        let mut gateway = None;
        let rfb = match role {
            "same_tailscale" => Some((route(id), "peer.synthetic.ts.net".into(), 5900)),
            "different_cloudflare" => {
                let access = Gateway::new(h.peer.address, false, false, HOST).await;
                connect_gateway(&h, &access).await;
                gateway = Some(access);
                Some((
                    json!({"type":"cloudflare_access","configId":uuid::Uuid::new_v4(),"generation":2,"originTls":null,
                    "credentials":{"clientId":"private-client","clientSecret":"private-secret"}}),
                    HOST.into(),
                    443,
                ))
            }
            _ => None,
        };
        control.allow_all();
        let (mut peers, proxy, rfb_proxy) = {
            let exchange = kdc::exercise(
                &h,
                Case {
                    route: route(id),
                    host: "peer.synthetic.ts.net".into(),
                    port: 88,
                    rfb,
                    cancel,
                    authority: "valid",
                },
                2,
            );
            tokio::pin!(exchange);
            let mut peers = super::vnc::relay(home, key, exchange.as_mut(), vec![88, 5900]).await;
            let channel = peers.sides[0].channel();
            let listener = peers
                .finish(channel.tcp_listen("100.64.0.2:88".parse().unwrap()))
                .await
                .unwrap();
            let proxy = super::vnc::proxy(listener, kdc.address);
            let rfb_proxy = if role == "same_tailscale" {
                let listener = peers
                    .finish(channel.tcp_listen("100.64.0.2:5900".parse().unwrap()))
                    .await
                    .unwrap();
                Some(super::vnc::proxy(listener, h.peer.address))
            } else {
                None
            };
            peers.finish(exchange.as_mut()).await.unwrap();
            (peers, proxy, rfb_proxy)
        };
        assert_eq!(kdc.requests.load(std::sync::atomic::Ordering::SeqCst), 2);
        if role == "different_cloudflare" {
            assert_eq!(
                *h.network.queries.lock().unwrap(),
                vec![(format!("{HOST}."), 443)]
            );
            assert_eq!(
                gateway
                    .as_ref()
                    .unwrap()
                    .applications
                    .load(std::sync::atomic::Ordering::SeqCst),
                1
            );
        } else {
            assert!(h.network.queries.lock().unwrap().is_empty());
            assert!(h.network.attempts.lock().unwrap().is_empty());
        }
        peers.finish(h.run.shutdown()).await;
        proxy.abort();
        assert!(proxy.await.unwrap_err().is_cancelled());
        if let Some(proxy) = rfb_proxy {
            proxy.abort();
            assert!(proxy.await.unwrap_err().is_cancelled());
        }
        api.assert_contract(1, 0);
        assert_eq!(control.logout_count(), 1);
        api.finish().await;
        control.finish().await;
    }
}

#[tokio::test]
async fn kdc_peer_retirement_cuts_pending_reply_and_forbids_replay() {
    let mut h = Harness::new().await;
    let cancel = CancellationToken::new();
    let kdc = KdcPeer::new(Reply::Hold, cancel.clone()).await;
    let api = Api::secure(None).await;
    let home = Server::secure().await;
    let key = NodeKeyPair::random();
    let mut value: Value = serde_json::from_slice(&map(&home)).unwrap();
    let mut peer = node(2, "peer.synthetic.ts.net.", 2, &key);
    peer["HomeDERP"] = 1.into();
    value["Peers"] = vec![peer].into();
    value["PacketFilter"] = json!([]);
    let control = Control::new(
        ACCEPTED.to_vec(),
        serde_json::to_vec(&value).unwrap(),
        KeyReply::Valid,
        false,
    )
    .await;
    control.set_logout_reply(
        hyper::StatusCode::OK,
        br#"{"NodeKeyExpired":true}"#.to_vec(),
    );
    *h.runtime.native_services.lock().unwrap() = Some(control.test_services(
        api.secure.as_ref().unwrap().clone(),
        Relay::new(&home, WriteGate::new(), Arc::new(Mutex::new(Vec::new()))),
    ));
    control.allow_all();
    let (mut peers, proxy) = {
        let exchange = kdc::exercise(
            &h,
            Case {
                route: route(uuid::Uuid::new_v4()),
                host: "peer.synthetic.ts.net".into(),
                port: 88,
                rfb: None,
                cancel,
                authority: "valid",
            },
            1,
        );
        tokio::pin!(exchange);
        let mut peers = super::vnc::relay(home, key, exchange.as_mut(), vec![88]).await;
        let channel = peers.sides[0].channel();
        let listener = peers
            .finish(channel.tcp_listen("100.64.0.2:88".parse().unwrap()))
            .await
            .unwrap();
        let proxy = super::vnc::proxy(listener, kdc.address);
        peers.finish(async{tokio::select!{()=kdc.received.notified()=>{},result=&mut exchange=>panic!("exchange finished before peer retirement: {result:?}")}}).await;
        control.update_map(json!({"PeersRemoved":[2]})).await;
        assert_eq!(
            peers.finish(exchange.as_mut()).await.unwrap_err(),
            kerberos_worker::Error::DeliveryUnknown
        );
        (peers, proxy)
    };
    assert_eq!(kdc.requests.load(std::sync::atomic::Ordering::SeqCst), 1);
    peers.finish(h.run.shutdown()).await;
    proxy.abort();
    assert!(proxy.await.unwrap_err().is_cancelled());
    api.assert_contract(1, 0);
    api.finish().await;
    control.finish().await;
}
