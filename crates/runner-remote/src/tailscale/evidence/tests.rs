use super::*;
use crate::diagnostics::{
    Cause, Handle, Identity, NativeEvidence, NativeSource, Operation, Protocol, Record,
};
use runner_types::ids::RunId;

#[test]
fn maximum_native_detail_retains_a_bounded_caller_summary_and_frozen_dependency() {
    let handle = Handle::new(RunId::new_v4(), true);
    let evidence = Arc::new(NativeEvidence::new());
    evidence.enable_layers();
    let node = evidence.layers();
    for stage in [
        Stage::Provisioning,
        Stage::ProviderDns,
        Stage::ProviderTcp,
        Stage::ProviderTls,
        Stage::ProviderRequest,
        Stage::KeyDns,
        Stage::KeyTcp,
        Stage::KeyTls,
        Stage::ControlKey,
        Stage::ControlDns,
        Stage::ControlTcp,
        Stage::ControlTls,
        Stage::Noise,
        Stage::Http2,
        Stage::Registration,
        Stage::MapRequest,
        Stage::MapRead,
        Stage::MapAuthority,
        Stage::MapHeader,
        Stage::MapBody,
        Stage::MapValidation,
        Stage::MapDecode,
        Stage::DerpMap,
        Stage::LocalNode,
        Stage::Peers,
        Stage::HomeAnnouncement,
        // A terminal home-relay receipt can also be adopted by the node.
        Stage::RelayAttempt,
        Stage::RelayDial,
        Stage::RelayDns,
        Stage::RelayTcp,
        Stage::RelayTls,
        Stage::RelayUpgrade,
        Stage::RelayProtocol,
        Stage::RelayRead,
        Stage::RelayWrite,
    ] {
        node.set(stage, Status::Passed, Detail::NotExposed);
    }
    node.set(Stage::RelayRead, Status::Failed, Detail::Reset);
    for role in [Role::Provider, Role::Key, Role::Control] {
        node.clone()
            .with_role(role)
            .endpoint("[2606:4700:4700::1111]:443".parse().unwrap());
    }
    node.update(|state| {
        for step in &mut state.steps {
            step.timing.elapsed_ms = 10_000;
        }
    });
    let relay = Trace::new(true);
    relay.region(20);
    relay
        .clone()
        .with_role(Role::Relay)
        .endpoint("[2606:4700:4700::1111]:443".parse().unwrap());
    for stage in [
        Stage::RelayAttempt,
        Stage::RelayDial,
        Stage::RelayDns,
        Stage::RelayTcp,
        Stage::RelayTls,
        Stage::RelayUpgrade,
        Stage::RelayProtocol,
        Stage::RelayRead,
        Stage::RelayWrite,
    ] {
        relay.set(stage, Status::Passed, Detail::NotExposed);
    }
    let v4 = relay.fork();
    let v6 = relay.fork();
    for trace in [&v4, &v6] {
        trace.set(Stage::RelayDns, Status::Passed, Detail::NotExposed);
        trace.set(Stage::RelayTcp, Status::Passed, Detail::NotExposed);
        trace
            .clone()
            .with_role(Role::Relay)
            .endpoint("[2606:4700:4700::1111]:443".parse().unwrap());
        trace.update(|state| {
            for step in &mut state.steps {
                step.timing.elapsed_ms = 10_000;
            }
        });
    }
    // A losing family is not a relay setup failure after the other established.
    v4.set(Stage::RelayTcp, Status::Failed, Detail::Refused);
    relay.update(|state| {
        for step in &mut state.steps {
            step.timing.elapsed_ms = 10_000;
        }
    });
    relay.dial_branches([v4, v6]);
    let connection = Trace::new(true);
    connection.region(20);
    connection
        .clone()
        .with_role(Role::PrivateTcp)
        .endpoint("[fd7a:115c:a1e0::2]:8022".parse().unwrap());
    connection.set(Stage::PeerSelection, Status::Passed, Detail::NotExposed);
    connection.set(Stage::PrivateTcp, Status::Running, Detail::NotExposed);
    connection.relay(relay.clone());
    for flow in [
        Flow::TcpSyn,
        Flow::EncryptedOutput,
        Flow::RelayQueued,
        Flow::RelayFlushed,
    ] {
        connection.flow(flow, 1);
    }
    let source = NativeSource {
        configuration_id: uuid::Uuid::new_v4(),
        generation: 1,
        resource_id: evidence.resource_id,
        evidence,
        connection: Some(connection),
    };
    let ssh = crate::diagnostics::trace::Trace::new(true);
    ssh.route(crate::diagnostics::trace::Route::Tailscale);
    ssh.set(
        crate::diagnostics::trace::Stage::Tcp,
        crate::diagnostics::trace::Progress::Running,
    );
    let access = crate::diagnostics::trace::Trace::new(true);
    access.route(crate::diagnostics::trace::Route::CloudflareAccess);
    for stage in [
        crate::diagnostics::trace::Stage::Dns,
        crate::diagnostics::trace::Stage::DestinationPolicy,
        crate::diagnostics::trace::Stage::Tcp,
        crate::diagnostics::trace::Stage::AccessTls,
        crate::diagnostics::trace::Stage::AccessWebsocket,
    ] {
        access.set(stage, crate::diagnostics::trace::Progress::Passed);
    }
    let vnc = crate::vnc::evidence::Snapshot {
        route: "cloudflare_access",
        kdc_route: Some("tailscale"),
        rfb_carrier: Some(Box::new(crate::vnc::evidence::Carrier {
            configuration_id: uuid::Uuid::new_v4(),
            generation: 1,
            attempt_id: uuid::Uuid::new_v4(),
            resource_id: None,
            connection_id: None,
            status: crate::diagnostics::trace::Progress::Passed,
            node_setup: None,
            origin_tls: Some(crate::diagnostics::trace::Progress::Passed),
            access: access.carrier_snapshot(),
        })),
        kdc_carrier: Some(Box::new(crate::vnc::evidence::Carrier {
            configuration_id: source.configuration_id,
            generation: source.generation,
            attempt_id: uuid::Uuid::new_v4(),
            resource_id: Some(source.resource_id),
            connection_id: source.connection.as_ref().and_then(Trace::id),
            status: crate::diagnostics::trace::Progress::Pending,
            node_setup: Some(crate::diagnostics::trace::Progress::Passed),
            origin_tls: None,
            access: None,
        })),
        ..Default::default()
    };
    let report = handle
        .record(Record {
            protocol: Protocol::Vnc,
            connection: uuid::Uuid::new_v4(),
            operation: Operation::Start,
            identity: Identity::default(),
            cause: Some(Cause::Vnc(crate::vnc::Failure::TimedOut)),
            dependency: None,
            native: Some(source),
            ssh: ssh.snapshot(),
            vnc: Some(vnc),
        })
        .expect("large valid incident must survive");
    assert!(
        serde_json::to_vec(&report.evidence().unwrap())
            .unwrap()
            .len()
            <= 8192
    );
    let text = report.message().expect("bounded caller explanation");
    assert!(
        report.evidence().unwrap()["truncated"] == true || text.contains("Detail omitted"),
        "maximum-detail case must exercise budget compaction; JSON {} bytes, text {} bytes",
        serde_json::to_vec(&report.evidence().unwrap())
            .unwrap()
            .len(),
        text.len()
    );
    assert!(text.len() <= 8192, "{} bytes", text.len());
    assert!(
        text.contains("Private TCP: pending at observation;"),
        "{text}"
    );
    assert!(text.contains("Selected relay region: 20;"), "{text}");
    assert!(text.contains("relay frames flushed locally: 1;"), "{text}");
    assert!(
        text.contains("silence does not identify an offline device or firewall block"),
        "compaction must preserve the established relay fact used by guidance: {text}"
    );
    assert!(text.contains("Attempt:") && text.contains("Next step:"));
    relay.set(Stage::RelayTls, Status::Failed, Detail::Rejected);
    assert_eq!(
        report.message().unwrap(),
        text,
        "later shared-region activity cannot rewrite captured facts"
    );
}

#[test]
fn typed_source_error_refines_a_generic_wrapper_without_being_erased() {
    let trace = Trace::new(true);
    trace.set(Stage::RelayTcp, Status::Running, Detail::NotExposed);
    trace.set(Stage::RelayTcp, Status::Failed, Detail::NotExposed);
    trace.set(Stage::RelayTcp, Status::Failed, Detail::Refused);
    trace.set(Stage::RelayTcp, Status::Failed, Detail::NotExposed);
    assert_eq!(trace.snapshot().unwrap().steps[0].detail, Detail::Refused);
}
