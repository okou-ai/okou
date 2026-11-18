use tracing_subscriber::prelude::*;

#[test]
fn production_filter_rejects_consolidated_netstack_and_dataplane_diagnostics() {
    let sink = tracing_test_support::CapturedEvents::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::filter::filter_fn(
            crate::tailscale::safe_log_metadata,
        ))
        .with(sink.clone());
    tracing::subscriber::with_default(subscriber, || {
        tracing::error!(target: "ts_netstack_smoltcp", "netstack-root-canary");
        tracing::error!(target: "ts_netstack_smoltcp::netcore::command", "netcore-canary");
        tracing::error!(target: "ts_netstack_smoltcp::netsock::tcp::stream", "netsock-canary");
        tracing::error!(target: "ts_dataplane::overlay_router::inbound", "overlay-router-canary");
        tracing::error!(target: "ts_netstack_smoltcp_other", "unrelated target remains visible");
    });
    let entries = sink.entries();
    assert_eq!(entries.len(), 1, "entries={entries:?}");
    assert!(!format!("{entries:?}").contains("canary"));
}
