use guest_contracts::sandbox_channel::{self as channel, ChannelError, Operation, Role};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct Fixtures {
    frames: Vec<Frame>,
    payloads: Vec<Payload>,
}
#[derive(Deserialize)]
struct Frame {
    name: String,
    valid: bool,
    wire: Value,
}
#[derive(Deserialize)]
struct Payload {
    name: String,
    valid: bool,
    operation: String,
    direction: String,
    value: Value,
}

fn fixtures() -> Result<Fixtures, serde_json::Error> {
    serde_json::from_slice(include_bytes!("fixtures/sandbox-channel.json"))
}
fn categories() -> BTreeMap<String, u64> {
    BTreeMap::from([("fs".to_owned(), 3), ("diagnostics".to_owned(), 1)])
}

#[test]
fn shared_envelope_vectors_and_round_trips() {
    for fixture in fixtures().expect("shared wire fixtures").frames {
        let bytes = serde_json::to_vec(&fixture.wire).expect("serialize shared wire");
        let decoded = channel::decode_message(&bytes);
        assert_eq!(decoded.is_ok(), fixture.valid, "{}", fixture.name);
        if let Ok(message) = decoded {
            assert_eq!(
                serde_json::to_value(message).expect("encode validated message"),
                fixture.wire,
                "{}",
                fixture.name
            );
        }
    }
}

#[test]
fn shared_typed_payload_vectors() {
    for fixture in fixtures().expect("shared payload fixtures").payloads {
        let accepted = if fixture.direction == "event" {
            channel::decode_notice(
                "diagnostics",
                1,
                "notice",
                fixture.value,
                &categories(),
                &categories(),
            )
            .is_ok()
        } else {
            let operation = match fixture.operation.as_str() {
                "fs.list" => Operation::FsList,
                "fs.list.close" => Operation::FsListClose,
                "diagnostics.echo" => Operation::Echo,
                "diagnostics.peer.echo" => Operation::PeerEcho,
                other => panic!("unknown shared operation {other}"),
            };
            if fixture.direction == "params" {
                channel::decode_params(operation, fixture.value).is_ok()
            } else {
                channel::decode_result(operation, fixture.value).is_ok()
            }
        };
        assert_eq!(accepted, fixture.valid, "{}", fixture.name);
    }
}

#[test]
fn ordered_category_and_role_gates() {
    let local = categories();
    let mut peer = categories();
    assert_eq!(
        channel::operation_contract("fs", 3, "list", Role::External, &local, &peer),
        Ok(Operation::FsList)
    );
    assert_eq!(
        channel::operation_contract("fs", 3, "list", Role::Guest, &local, &peer),
        Err(ChannelError::Forbidden)
    );
    assert_eq!(
        channel::operation_contract("diagnostics", 1, "echo", Role::Guest, &local, &peer),
        Ok(Operation::Echo)
    );
    assert_eq!(
        channel::operation_contract("constructor", 1, "list", Role::External, &local, &peer),
        Err(ChannelError::UnsupportedCategory)
    );
    peer.insert("fs".to_owned(), 1);
    assert_eq!(
        channel::operation_contract("fs", 3, "unknown", Role::External, &local, &peer),
        Err(ChannelError::CategoryVersionMismatch)
    );
    assert_eq!(
        channel::operation_contract("diagnostics", 1, "echo", Role::External, &local, &peer),
        Ok(Operation::Echo)
    );
    assert_eq!(
        channel::operation_contract("diagnostics", 1, "unknown", Role::External, &local, &peer),
        Err(ChannelError::UnknownOperation)
    );
}

#[test]
fn malformed_diagnostics_payloads_use_business_error_codes() {
    for operation in [Operation::Echo, Operation::PeerEcho] {
        for value in [json!({}), json!({"payload":"", "extra":true})] {
            assert_eq!(
                channel::decode_params(operation, value),
                Err(ChannelError::InvalidParams)
            );
        }
    }
    for value in [json!({}), json!({"message":"ready", "ack":true})] {
        assert_eq!(
            channel::decode_notice(
                "diagnostics",
                1,
                "notice",
                value,
                &categories(),
                &categories()
            ),
            Err(ChannelError::InvalidParams)
        );
    }
    assert_eq!(
        channel::decode_result(Operation::Echo, json!({"payload":"", "extra":true})),
        Err(ChannelError::InvalidRequest)
    );
}

#[test]
fn integral_versions_utf8_and_depth_are_interoperable() {
    let raw = br#"{"schemaVersion":1.0,"type":"hello","id":"00000000-0000-4000-8000-000000000001","categories":{"fs":2e0}}"#;
    assert!(channel::decode_message(raw).is_ok());
    let mut with_bom = vec![0xef, 0xbb, 0xbf];
    with_bom.extend_from_slice(raw);
    assert_eq!(
        channel::decode_message(&with_bom),
        Err(ChannelError::InvalidRequest)
    );
    assert!(channel::decode_message(&[0xff]).is_err());
    let unpaired = br#"{"schemaVersion":1,"type":"request","id":"00000000-0000-4000-8000-000000000001","category":"fs","categoryVersion":2,"operation":"list","params":{"x":"\ud800"}}"#;
    assert!(channel::decode_message(unpaired).is_err());
    let prototype_key = br#"{"schemaVersion":1,"type":"request","id":"00000000-0000-4000-8000-000000000001","category":"fs","categoryVersion":2,"operation":"list","params":{"path":[],"__proto__":{"probe":true}}}"#;
    assert!(channel::decode_message(prototype_key).is_err());
    let mut nested = Value::from(0);
    for _ in 0..66 {
        nested = Value::Array(vec![nested]);
    }
    let envelope = json!({"schemaVersion":1,"type":"request","id":"00000000-0000-4000-8000-000000000001","category":"fs","categoryVersion":2,"operation":"list","params":{"nested":nested}});
    assert_eq!(
        channel::decode_message(&serde_json::to_vec(&envelope).expect("nested frame")),
        Err(ChannelError::LimitExceeded)
    );
}

#[test]
fn frame_limit_and_schema_gate_precede_business_decode() {
    use api_contracts::generated::constants::sandbox_channel as limits;
    assert_eq!(
        u64::from(limits::MAX_FRAME_BYTES),
        u64::try_from(guest_contracts::private_duplex::MAX_FRAME_BYTES).expect("transport bound")
    );
    assert_eq!(
        channel::decode_message(&vec![
            0;
            usize::try_from(limits::MAX_FRAME_BYTES)
                .expect("frame bound")
                + 1
        ]),
        Err(ChannelError::LimitExceeded)
    );
    assert_eq!(
        channel::decode_message(br#"{"schemaVersion":2,"future":true}"#),
        Err(ChannelError::UnsupportedSchema)
    );
    assert!(channel::decode_hello_result(json!({"categories":{"fs":2},"extra":true})).is_err());
    assert!(channel::decode_hello_result(json!({"categories":{"fs":0}})).is_err());
}

#[test]
fn typed_payload_resource_limits_include_the_response_envelope() {
    use api_contracts::generated::constants::sandbox_channel as limits;
    use base64::{Engine, engine::general_purpose::STANDARD};
    let entry = json!({"nameToken":"YQ","displayName":"x".repeat(4096),"kind":"file"});
    let oversized = json!({"listingId":"L","entries":vec![entry;13],"nextCursor":null});
    assert!(channel::decode_result(Operation::FsList, oversized).is_err());
    let maximum = STANDARD.encode(vec![
        b'x';
        usize::try_from(limits::diagnostics::MAX_BYTES)
            .expect("echo limit")
    ]);
    assert!(channel::decode_params(Operation::Echo, json!({"payload":maximum})).is_ok());
    let oversized = STANDARD.encode(vec![
        b'x';
        usize::try_from(limits::diagnostics::MAX_BYTES)
            .expect("echo limit")
            + 1
    ]);
    assert!(channel::decode_params(Operation::Echo, json!({"payload":oversized})).is_err());
}
