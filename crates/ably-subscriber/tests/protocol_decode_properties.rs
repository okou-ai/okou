use std::collections::HashMap;

use ably_subscriber::{
    Error as AblyError,
    protocol::{
        AblyMessage, AuthDetails, ConnectionDetails, ErrorInfo, ProtocolMessage, action,
        decode_msg, encode_msg, error_code,
    },
};
use base64::Engine as _;
use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, RngSeed, TestCaseError, TestCaseResult};

const PROPERTY_CASES: u32 = 128;
const PROPERTY_SEED: u64 = 0xAB1E_DEC0_2026_0802;
const MAX_TEXT_CHARS: usize = 24;
const MAX_BINARY_BYTES: usize = 32;
const MAX_COLLECTION_ITEMS: usize = 4;
const MAX_MESSAGES: usize = 3;
const MAX_DATA_DEPTH: u32 = 4;
const MAX_DATA_NODES: u32 = 64;
const MAX_ARBITRARY_BYTES: usize = 128;

fn property_config() -> ProptestConfig {
    ProptestConfig {
        cases: PROPERTY_CASES,
        rng_seed: RngSeed::Fixed(PROPERTY_SEED),
        ..ProptestConfig::default()
    }
}

fn text_strategy() -> impl Strategy<Value = String> {
    proptest::collection::vec(
        prop_oneof![
            4 => proptest::char::range(' ', '~'),
            1 => Just('界'),
            1 => any::<char>(),
        ],
        0..=MAX_TEXT_CHARS,
    )
    .prop_map(|characters| characters.into_iter().collect())
}

fn json_value_strategy() -> BoxedStrategy<serde_json::Value> {
    let leaf = prop_oneof![
        Just(serde_json::Value::Null),
        any::<bool>().prop_map(serde_json::Value::Bool),
        any::<i64>().prop_map(|value| serde_json::Value::Number(value.into())),
        any::<u64>().prop_map(|value| serde_json::Value::Number(value.into())),
        any::<f64>().prop_filter_map("finite JSON number", |value| {
            serde_json::Number::from_f64(value).map(serde_json::Value::Number)
        }),
        text_strategy().prop_map(serde_json::Value::String),
    ];

    leaf.prop_recursive(
        MAX_DATA_DEPTH,
        MAX_DATA_NODES,
        MAX_COLLECTION_ITEMS as u32,
        |inner| {
            prop_oneof![
                proptest::collection::vec(inner.clone(), 0..=MAX_COLLECTION_ITEMS)
                    .prop_map(serde_json::Value::Array),
                proptest::collection::vec((text_strategy(), inner), 0..=MAX_COLLECTION_ITEMS,)
                    .prop_map(|entries| {
                        serde_json::Value::Object(entries.into_iter().collect())
                    }),
            ]
        },
    )
    .boxed()
}

fn connection_details_strategy() -> impl Strategy<Value = ConnectionDetails> {
    (
        proptest::option::of(text_strategy()),
        proptest::option::of(text_strategy()),
        proptest::option::of(any::<i64>()),
        proptest::option::of(any::<i64>()),
        proptest::option::of(any::<i64>()),
        proptest::option::of(any::<i64>()),
        proptest::option::of(text_strategy()),
    )
        .prop_map(
            |(
                client_id,
                connection_key,
                connection_state_ttl,
                max_idle_interval,
                max_message_size,
                max_frame_size,
                server_id,
            )| ConnectionDetails {
                client_id,
                connection_key,
                connection_state_ttl,
                max_idle_interval,
                max_message_size,
                max_frame_size,
                server_id,
            },
        )
}

fn error_info_strategy() -> impl Strategy<Value = ErrorInfo> {
    (
        any::<i32>(),
        proptest::option::of(any::<i32>()),
        text_strategy(),
    )
        .prop_map(|(code, status_code, message)| ErrorInfo {
            code,
            status_code,
            message,
        })
}

fn auth_details_strategy() -> impl Strategy<Value = AuthDetails> {
    text_strategy().prop_map(|access_token| AuthDetails { access_token })
}

fn ably_message_strategy() -> impl Strategy<Value = AblyMessage> {
    (
        proptest::option::of(text_strategy()),
        proptest::option::of(text_strategy()),
        proptest::option::of(json_value_strategy()),
        proptest::option::of(text_strategy()),
        proptest::option::of(any::<i64>()),
        proptest::option::of(text_strategy()),
    )
        .prop_map(
            |(id, name, data, client_id, timestamp, encoding)| AblyMessage {
                id,
                name,
                data,
                client_id,
                timestamp,
                encoding,
            },
        )
}

#[derive(Debug)]
struct ScalarFields {
    action: i32,
    id: Option<String>,
    channel: Option<String>,
    channel_serial: Option<String>,
    connection_id: Option<String>,
    connection_key: Option<String>,
    connection_serial: Option<i64>,
    msg_serial: Option<i64>,
    flags: Option<i32>,
    timestamp: Option<i64>,
}

fn scalar_fields_strategy() -> impl Strategy<Value = ScalarFields> {
    (
        any::<i32>(),
        proptest::option::of(text_strategy()),
        proptest::option::of(text_strategy()),
        proptest::option::of(text_strategy()),
        proptest::option::of(text_strategy()),
        proptest::option::of(text_strategy()),
        proptest::option::of(any::<i64>()),
        proptest::option::of(any::<i64>()),
        proptest::option::of(any::<i32>()),
        proptest::option::of(any::<i64>()),
    )
        .prop_map(
            |(
                action,
                id,
                channel,
                channel_serial,
                connection_id,
                connection_key,
                connection_serial,
                msg_serial,
                flags,
                timestamp,
            )| ScalarFields {
                action,
                id,
                channel,
                channel_serial,
                connection_id,
                connection_key,
                connection_serial,
                msg_serial,
                flags,
                timestamp,
            },
        )
}

fn protocol_message_strategy() -> BoxedStrategy<ProtocolMessage> {
    (
        scalar_fields_strategy(),
        proptest::option::of(connection_details_strategy()),
        proptest::option::of(error_info_strategy()),
        proptest::option::of(auth_details_strategy()),
        proptest::option::of(proptest::collection::vec(
            ably_message_strategy(),
            0..=MAX_MESSAGES,
        )),
        proptest::option::of(proptest::collection::hash_map(
            text_strategy(),
            text_strategy(),
            0..=MAX_COLLECTION_ITEMS,
        )),
    )
        .prop_map(
            |(fields, connection_details, error, auth, messages, params)| ProtocolMessage {
                action: fields.action,
                id: fields.id,
                channel: fields.channel,
                channel_serial: fields.channel_serial,
                connection_id: fields.connection_id,
                connection_key: fields.connection_key,
                connection_details,
                connection_serial: fields.connection_serial,
                msg_serial: fields.msg_serial,
                flags: fields.flags,
                error,
                auth,
                messages,
                timestamp: fields.timestamp,
                params,
            },
        )
        .boxed()
}

#[derive(Debug, PartialEq)]
struct ConnectionDetailsSnapshot<'a> {
    client_id: Option<&'a str>,
    connection_key: Option<&'a str>,
    connection_state_ttl: Option<i64>,
    max_idle_interval: Option<i64>,
    max_message_size: Option<i64>,
    max_frame_size: Option<i64>,
    server_id: Option<&'a str>,
}

impl<'a> From<&'a ConnectionDetails> for ConnectionDetailsSnapshot<'a> {
    fn from(details: &'a ConnectionDetails) -> Self {
        Self {
            client_id: details.client_id.as_deref(),
            connection_key: details.connection_key.as_deref(),
            connection_state_ttl: details.connection_state_ttl,
            max_idle_interval: details.max_idle_interval,
            max_message_size: details.max_message_size,
            max_frame_size: details.max_frame_size,
            server_id: details.server_id.as_deref(),
        }
    }
}

#[derive(Debug, PartialEq)]
struct ErrorInfoSnapshot<'a> {
    code: i32,
    status_code: Option<i32>,
    message: &'a str,
}

impl<'a> From<&'a ErrorInfo> for ErrorInfoSnapshot<'a> {
    fn from(error: &'a ErrorInfo) -> Self {
        Self {
            code: error.code,
            status_code: error.status_code,
            message: &error.message,
        }
    }
}

#[derive(Debug, PartialEq)]
struct AuthDetailsSnapshot<'a> {
    access_token: &'a str,
}

impl<'a> From<&'a AuthDetails> for AuthDetailsSnapshot<'a> {
    fn from(auth: &'a AuthDetails) -> Self {
        Self {
            access_token: &auth.access_token,
        }
    }
}

#[derive(Debug, PartialEq)]
struct AblyMessageSnapshot<'a> {
    id: Option<&'a str>,
    name: Option<&'a str>,
    data: Option<&'a serde_json::Value>,
    client_id: Option<&'a str>,
    timestamp: Option<i64>,
    encoding: Option<&'a str>,
}

impl<'a> From<&'a AblyMessage> for AblyMessageSnapshot<'a> {
    fn from(message: &'a AblyMessage) -> Self {
        Self {
            id: message.id.as_deref(),
            name: message.name.as_deref(),
            data: message.data.as_ref(),
            client_id: message.client_id.as_deref(),
            timestamp: message.timestamp,
            encoding: message.encoding.as_deref(),
        }
    }
}

#[derive(Debug, PartialEq)]
struct ProtocolMessageSnapshot<'a> {
    action: i32,
    id: Option<&'a str>,
    channel: Option<&'a str>,
    channel_serial: Option<&'a str>,
    connection_id: Option<&'a str>,
    connection_key: Option<&'a str>,
    connection_details: Option<ConnectionDetailsSnapshot<'a>>,
    connection_serial: Option<i64>,
    msg_serial: Option<i64>,
    flags: Option<i32>,
    error: Option<ErrorInfoSnapshot<'a>>,
    auth: Option<AuthDetailsSnapshot<'a>>,
    messages: Option<Vec<AblyMessageSnapshot<'a>>>,
    timestamp: Option<i64>,
    params: Option<&'a HashMap<String, String>>,
}

impl<'a> From<&'a ProtocolMessage> for ProtocolMessageSnapshot<'a> {
    fn from(message: &'a ProtocolMessage) -> Self {
        Self {
            action: message.action,
            id: message.id.as_deref(),
            channel: message.channel.as_deref(),
            channel_serial: message.channel_serial.as_deref(),
            connection_id: message.connection_id.as_deref(),
            connection_key: message.connection_key.as_deref(),
            connection_details: message
                .connection_details
                .as_ref()
                .map(ConnectionDetailsSnapshot::from),
            connection_serial: message.connection_serial,
            msg_serial: message.msg_serial,
            flags: message.flags,
            error: message.error.as_ref().map(ErrorInfoSnapshot::from),
            auth: message.auth.as_ref().map(AuthDetailsSnapshot::from),
            messages: message
                .messages
                .as_ref()
                .map(|messages| messages.iter().map(AblyMessageSnapshot::from).collect()),
            timestamp: message.timestamp,
            params: message.params.as_ref(),
        }
    }
}

fn string_value(value: impl Into<String>) -> rmpv::Value {
    rmpv::Value::from(value.into())
}

fn field(name: &str, value: rmpv::Value) -> (rmpv::Value, rmpv::Value) {
    (rmpv::Value::from(name), value)
}

fn encode_value(value: &rmpv::Value) -> Vec<u8> {
    let mut encoded = Vec::new();
    let result = rmpv::encode::write_value(&mut encoded, value);
    assert!(result.is_ok(), "generated value should encode: {result:?}");
    encoded
}

#[derive(Debug)]
struct CompatibilityCase {
    frame: rmpv::Value,
    action: i32,
    channel: String,
    message_name: String,
    params: HashMap<String, String>,
}

fn compatibility_case_strategy() -> impl Strategy<Value = CompatibilityCase> {
    (
        any::<i32>(),
        text_strategy(),
        text_strategy(),
        text_strategy(),
        text_strategy(),
        text_strategy(),
        any::<[u8; 5]>(),
    )
        .prop_map(
            |(
                expected_action,
                expected_channel,
                expected_message_name,
                expected_rewind,
                extra_param_suffix,
                unknown_suffix,
                order,
            )| {
                let extra_param_key = format!("extra:{extra_param_suffix}");
                let extra_param_value = format!("value:{extra_param_suffix}");
                let unknown_top_level = format!("unknownTopLevel:{unknown_suffix}");
                let unknown_nested = format!("unknownNested:{unknown_suffix}");

                let message = rmpv::Value::Map(vec![
                    field("name", rmpv::Value::Array(Vec::new())),
                    field("name", string_value("discarded-message-name")),
                    field(&unknown_nested, rmpv::Value::Boolean(true)),
                    field("name", string_value(expected_message_name.clone())),
                ]);
                let params = rmpv::Value::Map(vec![
                    field("rewind", rmpv::Value::Array(Vec::new())),
                    field("rewind", string_value("discarded-rewind")),
                    field(&extra_param_key, string_value(extra_param_value.clone())),
                    field("rewind", string_value(expected_rewind.clone())),
                ]);

                let mut groups = vec![
                    (
                        order[0],
                        0,
                        vec![
                            field("action", string_value("invalid-action")),
                            field("action", rmpv::Value::from(expected_action)),
                        ],
                    ),
                    (
                        order[1],
                        1,
                        vec![
                            field("channel", rmpv::Value::Array(Vec::new())),
                            field("channel", string_value(expected_channel.clone())),
                        ],
                    ),
                    (
                        order[2],
                        2,
                        vec![
                            field("messages", string_value("invalid-messages")),
                            field("messages", rmpv::Value::Array(vec![message])),
                        ],
                    ),
                    (
                        order[3],
                        3,
                        vec![
                            field("params", rmpv::Value::Array(Vec::new())),
                            field("params", params),
                        ],
                    ),
                    (
                        order[4],
                        4,
                        vec![field(
                            &unknown_top_level,
                            rmpv::Value::Binary(vec![0xde, 0xad, 0xbe, 0xef]),
                        )],
                    ),
                ];
                groups.sort_by_key(|(sort_key, tie_breaker, _)| (*sort_key, *tie_breaker));
                let frame = rmpv::Value::Map(
                    groups
                        .into_iter()
                        .flat_map(|(_, _, fields)| fields)
                        .collect(),
                );

                let expected_params = HashMap::from([
                    ("rewind".to_string(), expected_rewind.clone()),
                    (extra_param_key, extra_param_value),
                ]);

                CompatibilityCase {
                    frame,
                    action: expected_action,
                    channel: expected_channel,
                    message_name: expected_message_name,
                    params: expected_params,
                }
            },
        )
}

#[derive(Clone, Debug)]
struct EncodedJson {
    wire: Vec<u8>,
    json: serde_json::Value,
    root_absent: bool,
}

fn encode_array(items: &[EncodedJson]) -> Vec<u8> {
    assert!(items.len() <= MAX_COLLECTION_ITEMS);
    let mut encoded = vec![0x90 | items.len() as u8];
    for item in items {
        encoded.extend_from_slice(&item.wire);
    }
    encoded
}

fn encode_map(entries: &[(String, EncodedJson)]) -> Vec<u8> {
    assert!(entries.len() <= MAX_COLLECTION_ITEMS);
    let mut encoded = vec![0x80 | entries.len() as u8];
    for (key, value) in entries {
        encoded.extend(encode_value(&string_value(key.clone())));
        encoded.extend_from_slice(&value.wire);
    }
    encoded
}

fn encoded_json_leaf_strategy() -> BoxedStrategy<EncodedJson> {
    let finite_f32 = any::<f32>()
        .prop_filter("finite f32", |value| value.is_finite())
        .prop_map(|value| EncodedJson {
            wire: encode_value(&rmpv::Value::F32(value)),
            json: serde_json::Number::from_f64(f64::from(value))
                .map_or(serde_json::Value::Null, serde_json::Value::Number),
            root_absent: false,
        });
    let finite_f64 = any::<f64>()
        .prop_filter("finite f64", |value| value.is_finite())
        .prop_map(|value| EncodedJson {
            wire: encode_value(&rmpv::Value::F64(value)),
            json: serde_json::Number::from_f64(value)
                .map_or(serde_json::Value::Null, serde_json::Value::Number),
            root_absent: false,
        });
    let non_finite_f32 = prop_oneof![Just(f32::NAN), Just(f32::INFINITY), Just(f32::NEG_INFINITY),]
        .prop_map(|value| EncodedJson {
            wire: encode_value(&rmpv::Value::F32(value)),
            json: serde_json::Value::Null,
            root_absent: true,
        });
    let non_finite_f64 = prop_oneof![Just(f64::NAN), Just(f64::INFINITY), Just(f64::NEG_INFINITY),]
        .prop_map(|value| EncodedJson {
            wire: encode_value(&rmpv::Value::F64(value)),
            json: serde_json::Value::Null,
            root_absent: true,
        });

    prop_oneof![
        Just(EncodedJson {
            wire: encode_value(&rmpv::Value::Nil),
            json: serde_json::Value::Null,
            root_absent: true,
        }),
        any::<bool>().prop_map(|value| EncodedJson {
            wire: encode_value(&rmpv::Value::Boolean(value)),
            json: serde_json::Value::Bool(value),
            root_absent: false,
        }),
        any::<i64>().prop_map(|value| EncodedJson {
            wire: encode_value(&rmpv::Value::from(value)),
            json: serde_json::Value::Number(value.into()),
            root_absent: false,
        }),
        any::<u64>().prop_map(|value| EncodedJson {
            wire: encode_value(&rmpv::Value::from(value)),
            json: serde_json::Value::Number(value.into()),
            root_absent: false,
        }),
        finite_f32,
        finite_f64,
        non_finite_f32,
        non_finite_f64,
        text_strategy().prop_map(|value| EncodedJson {
            wire: encode_value(&string_value(value.clone())),
            json: serde_json::Value::String(value),
            root_absent: false,
        }),
        Just(EncodedJson {
            wire: vec![0xa1, 0xff],
            json: serde_json::Value::String(String::new()),
            root_absent: false,
        }),
        proptest::collection::vec(any::<u8>(), 0..=MAX_BINARY_BYTES).prop_map(|bytes| {
            EncodedJson {
                wire: encode_value(&rmpv::Value::Binary(bytes.clone())),
                json: serde_json::Value::String(
                    base64::engine::general_purpose::STANDARD.encode(bytes),
                ),
                root_absent: false,
            }
        }),
        (
            any::<i8>(),
            proptest::collection::vec(any::<u8>(), 0..=MAX_BINARY_BYTES),
        )
            .prop_map(|(kind, bytes)| EncodedJson {
                wire: encode_value(&rmpv::Value::Ext(kind, bytes.clone())),
                json: serde_json::Value::String(
                    base64::engine::general_purpose::STANDARD.encode(bytes),
                ),
                root_absent: false,
            }),
    ]
    .boxed()
}

fn encoded_json_strategy() -> BoxedStrategy<EncodedJson> {
    encoded_json_leaf_strategy()
        .prop_recursive(
            MAX_DATA_DEPTH,
            MAX_DATA_NODES,
            MAX_COLLECTION_ITEMS as u32,
            |inner| {
                let array = proptest::collection::vec(inner.clone(), 0..=MAX_COLLECTION_ITEMS)
                    .prop_map(|items| EncodedJson {
                        wire: encode_array(&items),
                        json: serde_json::Value::Array(
                            items.into_iter().map(|item| item.json).collect(),
                        ),
                        root_absent: false,
                    });
                let map = (
                    text_strategy(),
                    inner.clone(),
                    inner.clone(),
                    proptest::collection::vec(
                        (text_strategy(), inner),
                        0..=MAX_COLLECTION_ITEMS - 2,
                    ),
                )
                    .prop_map(|(duplicate_key, first, last, entries)| {
                        let mut wire_entries = Vec::with_capacity(entries.len() + 2);
                        let mut json_entries = serde_json::Map::new();
                        json_entries.insert(duplicate_key.clone(), first.json.clone());
                        wire_entries.push((duplicate_key.clone(), first));
                        for (key, value) in entries {
                            json_entries.insert(key.clone(), value.json.clone());
                            wire_entries.push((key, value));
                        }
                        json_entries.insert(duplicate_key.clone(), last.json.clone());
                        wire_entries.push((duplicate_key, last));
                        EncodedJson {
                            wire: encode_map(&wire_entries),
                            json: serde_json::Value::Object(json_entries),
                            root_absent: false,
                        }
                    });

                prop_oneof![array, map]
            },
        )
        .boxed()
}

fn message_data_frame(data: &[u8]) -> Vec<u8> {
    let mut encoded = vec![0x82];
    encoded.extend(encode_value(&string_value("action")));
    encoded.extend(encode_value(&rmpv::Value::from(action::MESSAGE)));
    encoded.extend(encode_value(&string_value("messages")));
    encoded.push(0x91);
    encoded.push(0x81);
    encoded.extend(encode_value(&string_value("data")));
    encoded.extend_from_slice(data);
    encoded
}

fn arbitrary_bytes_with_secret_strategy() -> impl Strategy<Value = (Vec<u8>, String)> {
    (
        proptest::collection::vec(any::<u8>(), 0..=MAX_ARBITRARY_BYTES),
        any::<u64>(),
        proptest::collection::vec(any::<u8>(), 0..=MAX_ARBITRARY_BYTES),
    )
        .prop_map(|(prefix, nonce, suffix)| {
            let secret = format!("vm0-secret-{nonce:016x}");
            let mut bytes = Vec::with_capacity(prefix.len() + secret.len() + suffix.len());
            bytes.extend(prefix);
            bytes.extend_from_slice(secret.as_bytes());
            bytes.extend(suffix);
            (bytes, secret)
        })
}

fn assert_rejection_contract(bytes: &[u8], secret: Option<&str>) -> TestCaseResult {
    match decode_msg(bytes) {
        Ok(_) => Ok(()),
        Err(AblyError::Protocol { code, message }) => {
            prop_assert_eq!(code, error_code::BAD_REQUEST);
            if let Some(secret) = secret {
                prop_assert!(
                    !message.contains(secret),
                    "decode error exposed generated payload sentinel",
                );
            }
            Ok(())
        }
        Err(error) => Err(TestCaseError::fail(format!(
            "rejected bytes returned a non-protocol error: {error}",
        ))),
    }
}

fn assert_protocol_message_round_trip(mut expected: ProtocolMessage) -> TestCaseResult {
    let encoded = encode_msg(&expected).map_err(|error| {
        TestCaseError::fail(format!("protocol message failed to encode: {error}"))
    })?;
    let decoded = decode_msg(&encoded).map_err(|error| {
        TestCaseError::fail(format!(
            "encoded protocol message failed to decode: {error}"
        ))
    })?;

    // Encode the original input, then canonicalize only the expected root data.
    // Keep decoded data and nested nulls intact to check the decoder's contract.
    for message in expected.messages.iter_mut().flatten() {
        if message
            .data
            .as_ref()
            .is_some_and(serde_json::Value::is_null)
        {
            message.data = None;
        }
    }

    prop_assert_eq!(
        ProtocolMessageSnapshot::from(&decoded),
        ProtocolMessageSnapshot::from(&expected),
    );
    Ok(())
}

#[test]
fn round_trip_normalizes_root_null_message_data() -> TestCaseResult {
    assert_protocol_message_round_trip(ProtocolMessage {
        action: 0,
        messages: Some(vec![AblyMessage {
            data: Some(serde_json::Value::Null),
            ..Default::default()
        }]),
        ..Default::default()
    })
}

#[test]
fn round_trip_preserves_nested_null_message_data() -> TestCaseResult {
    let messages = [
        None,
        Some(serde_json::Value::Null),
        Some(serde_json::json!([null, {"nested": null}])),
        Some(serde_json::json!({"nested": null, "array": [null]})),
    ]
    .into_iter()
    .map(|data| AblyMessage {
        data,
        ..Default::default()
    })
    .collect();

    assert_protocol_message_round_trip(ProtocolMessage {
        action: action::MESSAGE,
        messages: Some(messages),
        ..Default::default()
    })
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn generated_protocol_messages_round_trip(expected in protocol_message_strategy()) {
        assert_protocol_message_round_trip(expected)?;
    }

    #[test]
    fn generated_raw_maps_preserve_last_wins_and_ignore_unknown_fields(
        case in compatibility_case_strategy(),
    ) {
        let encoded = encode_value(&case.frame);
        let decoded = decode_msg(&encoded).map_err(|error| {
            TestCaseError::fail(format!("generated compatibility frame failed to decode: {error}"))
        })?;

        prop_assert_eq!(decoded.action, case.action);
        prop_assert_eq!(decoded.channel.as_deref(), Some(case.channel.as_str()));
        let messages = decoded.messages.as_deref().ok_or_else(|| {
            TestCaseError::fail("generated compatibility frame omitted messages")
        })?;
        prop_assert_eq!(messages.len(), 1);
        prop_assert_eq!(messages[0].name.as_deref(), Some(case.message_name.as_str()));
        prop_assert_eq!(decoded.params.as_ref(), Some(&case.params));
    }

    #[test]
    fn generated_nested_message_data_matches_documented_decoder_conversion(case in encoded_json_strategy()) {
        let EncodedJson {
            wire,
            json,
            root_absent,
        } = case;
        let expected = if root_absent {
            None
        } else {
            Some(json)
        };
        let encoded = message_data_frame(&wire);
        let decoded = decode_msg(&encoded).map_err(|error| {
            TestCaseError::fail(format!("generated nested data failed to decode: {error}"))
        })?;
        let messages = decoded.messages.as_deref().ok_or_else(|| {
            TestCaseError::fail("generated nested data frame omitted messages")
        })?;
        prop_assert_eq!(messages.len(), 1);
        prop_assert_eq!(&messages[0].data, &expected);
    }

    #[test]
    fn arbitrary_bounded_bytes_never_panic_and_rejections_are_safe(
        bytes in proptest::collection::vec(any::<u8>(), 0..=MAX_ARBITRARY_BYTES * 2),
        (bytes_with_secret, secret) in arbitrary_bytes_with_secret_strategy(),
    ) {
        assert_rejection_contract(&bytes, None)?;
        assert_rejection_contract(&bytes_with_secret, Some(&secret))?;
    }
}
