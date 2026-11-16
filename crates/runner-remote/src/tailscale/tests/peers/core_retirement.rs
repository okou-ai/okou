//! Pin the quiet Core-to-Root completion boundary without unrelated owner input.

use super::{inside, node, own, update};
use crate::tailscale::{core::Core, relay_driver::Driver};
use futures_util::poll;
use serde_json::json;
use std::{pin::pin, task::Poll};
use tokio_util::sync::CancellationToken;
use ts_keys::NodeKeyPair;

async fn connection_owner() -> (Core, Driver) {
    let keys = NodeKeyPair::random();
    let peer = NodeKeyPair::random();
    let (driver, port) = Driver::new(CancellationToken::new());
    let mut core = Core::new(keys.clone(), own(&keys).await, port).unwrap();
    core.update(
        update(json!({
            "Peers": [node(2, "saved.tail-okou.ts.net.", 2, &peer)],
            "PacketFilter": [],
        }))
        .await,
    )
    .unwrap();
    (core, driver)
}

#[tokio::test]
async fn quiet_opening_retirement_completes_the_owner_wait() {
    inside(|control| async move {
        control.ready();
        let (mut core, _driver) = connection_owner().await;
        let opening = core
            .dial("100.64.0.2", 22, CancellationToken::new(), None)
            .unwrap();
        drop(opening);

        // Root must get a turn to publish routes even when no packet, map,
        // command or SDK timer completes after the opening is abandoned.
        assert_eq!(poll!(pin!(core.wait())), Poll::Ready(Ok(())));
    })
    .await;
}

#[tokio::test]
async fn opening_retirement_completes_while_its_outbound_capacity_is_retained() {
    inside(|control| async move {
        control.ready();
        let (mut core, mut driver) = connection_owner().await;
        let opening = core
            .dial("100.64.0.2", 22, CancellationToken::new(), None)
            .unwrap();
        super::bounded(core.wait()).await.unwrap();
        // Retain the actual SDK packet and its physical writer permit. There
        // is no relay driver consuming it to manufacture another owner turn.
        let packet = driver.outgoing.try_recv().unwrap();
        drop(opening);

        assert_eq!(poll!(pin!(core.wait())), Poll::Ready(Ok(())));
        // The one retirement is consumed; blocked unchanged state must not
        // spin the Root or discharge the still-owned outbound capacity.
        assert!(poll!(pin!(core.wait())).is_pending());
        drop(packet);
    })
    .await;
}
