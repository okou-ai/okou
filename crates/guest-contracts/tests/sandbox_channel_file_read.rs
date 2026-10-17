use guest_contracts::sandbox_channel::{self as channel, ChannelError, Operation, Role};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct Vectors {
    payloads: Vec<Payload>,
}
#[derive(Deserialize)]
struct Payload {
    name: String,
    operation: String,
    direction: String,
    valid: bool,
    value: Value,
}

#[test]
fn shared_file_reader_semantic_vectors() {
    let vectors: Vectors =
        serde_json::from_slice(include_bytes!("fixtures/sandbox-channel-fs-read.json")).unwrap();
    for vector in vectors.payloads {
        let operation = match vector.operation.as_str() {
            "open" => Operation::FsOpen,
            "read" => Operation::FsRead,
            "finish" => Operation::FsFinish,
            "close" => Operation::FsClose,
            _ => panic!("unknown fixture operation"),
        };
        let accepted = if vector.direction == "params" {
            channel::decode_params(operation, vector.value).is_ok()
        } else {
            channel::decode_result(operation, vector.value).is_ok()
        };
        assert_eq!(accepted, vector.valid, "{}", vector.name);
    }
}

#[test]
fn file_protocol_requires_exact_version_and_external_role() {
    let old = BTreeMap::from([("fs".into(), 2)]);
    let current = BTreeMap::from([("fs".into(), 3)]);
    for (name, operation) in [
        ("list", Operation::FsList),
        ("list.close", Operation::FsListClose),
        ("open", Operation::FsOpen),
        ("read", Operation::FsRead),
        ("finish", Operation::FsFinish),
        ("close", Operation::FsClose),
    ] {
        for version in [2, 3] {
            assert_eq!(
                channel::operation_contract("fs", version, name, Role::External, &current, &old),
                Err(ChannelError::CategoryVersionMismatch)
            );
        }
        assert_eq!(
            channel::operation_contract("fs", 2, name, Role::External, &current, &current),
            Err(ChannelError::CategoryVersionMismatch)
        );
        assert_eq!(
            channel::operation_contract("fs", 3, name, Role::Guest, &current, &current),
            Err(ChannelError::Forbidden)
        );
        assert_eq!(
            channel::operation_contract("fs", 3, name, Role::External, &current, &current),
            Ok(operation)
        );
    }
}

#[test]
fn exact_full_chunk_and_integral_json_lengths_fit_the_wire_budget() {
    use api_contracts::generated::constants::sandbox_channel as limits;
    use base64::{Engine, engine::general_purpose::STANDARD};
    let bytes = vec![255; limits::fs::MAX_CHUNK_BYTES as usize];
    let result =
        json!({"offset":"9007199254740993","length":32768.0,"data":STANDARD.encode(&bytes)});
    channel::decode_result(Operation::FsRead, result.clone()).unwrap();
    assert!(
        serde_json::to_vec(&result).unwrap().len() + limits::RESPONSE_OVERHEAD_BYTES as usize
            <= limits::fs::MAX_RESPONSE_BYTES as usize
    );
    channel::decode_params(
        Operation::FsRead,
        json!({"handle":"owned","offset":"0","length":1.0}),
    )
    .unwrap();
    assert!(
        channel::decode_params(
            Operation::FsRead,
            json!({"handle":"owned","offset":"0","length":32768.00001})
        )
        .is_err()
    );
}
