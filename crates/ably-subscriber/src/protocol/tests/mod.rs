use super::*;

#[test]
fn encode_decode_attach() {
    let msg = ProtocolMessage {
        action: action::ATTACH,
        channel: Some("test-channel".to_string()),
        flags: Some(flags::MODE_SUBSCRIBE),
        ..Default::default()
    };
    let data = encode_msg(&msg).unwrap();
    let decoded = decode_msg(&data).unwrap();
    assert_eq!(decoded.action, action::ATTACH);
    assert_eq!(decoded.channel.as_deref(), Some("test-channel"));
    assert_eq!(decoded.flags, Some(flags::MODE_SUBSCRIBE));
}

#[test]
fn encode_decode_close() {
    let msg = ProtocolMessage {
        action: action::CLOSE,
        ..Default::default()
    };
    let data = encode_msg(&msg).unwrap();
    let decoded = decode_msg(&data).unwrap();
    assert_eq!(decoded.action, action::CLOSE);
}

#[test]
fn encode_decode_auth() {
    let msg = ProtocolMessage {
        action: action::AUTH,
        auth: Some(AuthDetails {
            access_token: "my-token".to_string(),
        }),
        ..Default::default()
    };
    let data = encode_msg(&msg).unwrap();
    let decoded = decode_msg(&data).unwrap();
    assert_eq!(decoded.action, action::AUTH);
    assert_eq!(
        decoded.auth.as_ref().map(|a| a.access_token.as_str()),
        Some("my-token")
    );
}

#[test]
fn encode_decode_connected() {
    let msg = ProtocolMessage {
        action: action::CONNECTED,
        connection_id: Some("abc123".to_string()),
        connection_key: Some("abc123!key".to_string()),
        connection_serial: Some(-1),
        connection_details: Some(ConnectionDetails {
            connection_state_ttl: Some(120000),
            max_idle_interval: Some(15000),
            server_id: Some("frontend.0".to_string()),
            ..Default::default()
        }),
        ..Default::default()
    };
    let data = encode_msg(&msg).unwrap();
    let decoded = decode_msg(&data).unwrap();
    assert_eq!(decoded.action, action::CONNECTED);
    assert_eq!(decoded.connection_id.as_deref(), Some("abc123"));
    assert_eq!(decoded.connection_key.as_deref(), Some("abc123!key"));
    assert_eq!(decoded.connection_serial, Some(-1));
    let details = decoded.connection_details.as_ref().unwrap();
    assert_eq!(details.connection_state_ttl, Some(120000));
    assert_eq!(details.max_idle_interval, Some(15000));
}

#[test]
fn encode_decode_message_with_data() {
    let msg = ProtocolMessage {
        action: action::MESSAGE,
        channel: Some("runner-group:test".to_string()),
        connection_serial: Some(5),
        messages: Some(vec![AblyMessage {
            id: Some("msg-001".to_string()),
            name: Some("job".to_string()),
            data: Some(serde_json::json!({"runId": "uuid-123"})),
            client_id: Some("publisher".to_string()),
            timestamp: Some(1700000000000),
            encoding: None,
        }]),
        ..Default::default()
    };
    let data = encode_msg(&msg).unwrap();
    let decoded = decode_msg(&data).unwrap();
    assert_eq!(decoded.action, action::MESSAGE);
    assert_eq!(decoded.channel.as_deref(), Some("runner-group:test"));
    let messages = decoded.messages.as_ref().unwrap();
    assert_eq!(messages.len(), 1);
    if let Some(m) = messages.first() {
        assert_eq!(m.name.as_deref(), Some("job"));
        assert_eq!(
            m.data
                .as_ref()
                .and_then(|d| d.get("runId"))
                .and_then(|v| v.as_str()),
            Some("uuid-123")
        );
    }
}

#[test]
fn encode_decode_heartbeat() {
    let msg = ProtocolMessage {
        action: action::HEARTBEAT,
        ..Default::default()
    };
    let data = encode_msg(&msg).unwrap();
    let decoded = decode_msg(&data).unwrap();
    assert_eq!(decoded.action, action::HEARTBEAT);
}

#[test]
fn encode_decode_error() {
    let msg = ProtocolMessage {
        action: action::ERROR,
        error: Some(ErrorInfo {
            code: 40142,
            status_code: Some(401),
            message: "Token expired".to_string(),
        }),
        ..Default::default()
    };
    let data = encode_msg(&msg).unwrap();
    let decoded = decode_msg(&data).unwrap();
    assert_eq!(decoded.action, action::ERROR);
    let err = decoded.error.as_ref().unwrap();
    assert_eq!(err.code, 40142);
    assert_eq!(err.status_code, Some(401));
    assert_eq!(err.message, "Token expired");
}

#[test]
fn encode_decode_disconnected() {
    let msg = ProtocolMessage {
        action: action::DISCONNECTED,
        error: Some(ErrorInfo {
            code: 80003,
            status_code: Some(500),
            message: "Connection lost".to_string(),
        }),
        ..Default::default()
    };
    let data = encode_msg(&msg).unwrap();
    let decoded = decode_msg(&data).unwrap();
    assert_eq!(decoded.action, action::DISCONNECTED);
    assert_eq!(decoded.error.as_ref().map(|e| e.code), Some(80003));
}

#[test]
fn encode_decode_attach_with_params() {
    let mut params = HashMap::new();
    params.insert("rewind".to_string(), "2m".to_string());
    let msg = ProtocolMessage {
        action: action::ATTACH,
        channel: Some("run:uuid-123".to_string()),
        flags: Some(flags::MODE_SUBSCRIBE),
        params: Some(params),
        ..Default::default()
    };
    let data = encode_msg(&msg).unwrap();
    let decoded = decode_msg(&data).unwrap();
    assert_eq!(decoded.action, action::ATTACH);
    assert_eq!(
        decoded
            .params
            .as_ref()
            .and_then(|p| p.get("rewind"))
            .map(String::as_str),
        Some("2m")
    );
}

#[test]
fn rmpv_to_json_replaces_invalid_utf8_string_with_empty_string() {
    let mut cursor = std::io::Cursor::new([0xa1, 0xff]);
    let value = rmpv::decode::read_value(&mut cursor).unwrap();

    assert_eq!(
        rmpv_to_json(value),
        serde_json::Value::String(String::new())
    );
}

#[test]
fn rmpv_to_json_replaces_invalid_utf8_map_key_with_empty_string() {
    let mut cursor = std::io::Cursor::new([0x81, 0xa1, 0xff, 0x01]);
    let value = rmpv::decode::read_value(&mut cursor).unwrap();

    let mut expected = serde_json::Map::new();
    expected.insert(String::new(), serde_json::Value::Number(1.into()));
    assert_eq!(rmpv_to_json(value), serde_json::Value::Object(expected));
}

#[test]
fn action_constants() {
    assert_eq!(action::HEARTBEAT, 0);
    assert_eq!(action::CONNECTED, 4);
    assert_eq!(action::DISCONNECTED, 6);
    assert_eq!(action::CLOSE, 7);
    assert_eq!(action::CLOSED, 8);
    assert_eq!(action::ERROR, 9);
    assert_eq!(action::ATTACH, 10);
    assert_eq!(action::ATTACHED, 11);
    assert_eq!(action::DETACHED, 13);
    assert_eq!(action::MESSAGE, 15);
    assert_eq!(action::AUTH, 17);
}

#[test]
fn flag_constants() {
    assert_eq!(flags::MODE_SUBSCRIBE, 262_144);
    assert_eq!(flags::MODE_SUBSCRIBE, 1 << 18);
    assert_eq!(flags::HAS_PRESENCE, 1);
    assert_eq!(flags::HAS_BACKLOG, 2);
    assert_eq!(flags::HAS_CHANNEL_RESUMED, 4);
}

#[test]
fn build_attach_msg_basic() {
    let msg = build_attach_msg("my-channel", None, None, AttachMode::Clean);
    assert_eq!(msg.action, action::ATTACH);
    assert_eq!(msg.channel.as_deref(), Some("my-channel"));
    assert_eq!(msg.flags, Some(flags::MODE_SUBSCRIBE));
    assert!(msg.channel_serial.is_none());
    assert!(msg.params.is_none());
}

#[test]
fn build_attach_msg_with_rewind() {
    let mut params = HashMap::new();
    params.insert("rewind".to_string(), "2m".to_string());
    let msg = build_attach_msg("run:abc", Some(&params), None, AttachMode::Clean);
    assert_eq!(msg.action, action::ATTACH);
    assert_eq!(msg.channel.as_deref(), Some("run:abc"));
    assert_eq!(
        msg.params
            .as_ref()
            .and_then(|p| p.get("rewind"))
            .map(String::as_str),
        Some("2m")
    );
}

#[test]
fn build_attach_msg_resume_with_channel_serial() {
    let msg = build_attach_msg("my-channel", None, Some("serial-abc"), AttachMode::Resume);
    assert_eq!(msg.action, action::ATTACH);
    assert_eq!(msg.channel_serial.as_deref(), Some("serial-abc"));
    let f = msg.flags.unwrap();
    assert_ne!(f & flags::ATTACH_RESUME, 0);
    assert_ne!(f & flags::MODE_SUBSCRIBE, 0);
}

#[test]
fn build_attach_msg_clean_without_channel_serial_no_resume_flag() {
    let msg = build_attach_msg("my-channel", None, None, AttachMode::Clean);
    let f = msg.flags.unwrap();
    assert_eq!(f & flags::ATTACH_RESUME, 0);
    assert_ne!(f & flags::MODE_SUBSCRIBE, 0);
}

#[test]
fn build_attach_msg_clean_with_channel_serial_omits_serial_and_resume_flag() {
    let msg = build_attach_msg("my-channel", None, Some("serial-abc"), AttachMode::Clean);
    assert!(msg.channel_serial.is_none());
    let f = msg.flags.unwrap();
    assert_eq!(f & flags::ATTACH_RESUME, 0);
    assert_ne!(f & flags::MODE_SUBSCRIBE, 0);
}

#[test]
fn build_attach_msg_resume_without_channel_serial_sets_resume_flag() {
    let msg = build_attach_msg("my-channel", None, None, AttachMode::Resume);
    assert!(msg.channel_serial.is_none());
    let f = msg.flags.unwrap();
    assert_ne!(f & flags::ATTACH_RESUME, 0);
    assert_ne!(f & flags::MODE_SUBSCRIBE, 0);
}
