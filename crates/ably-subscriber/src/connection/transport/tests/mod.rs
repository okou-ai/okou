use super::*;

#[test]
fn websocket_close_reason_redacts_auth_query_params_from_reason() {
    let frame = CloseFrame {
        code: tungstenite::protocol::frame::coding::CloseCode::Normal,
        reason: "url=wss://example/?access_token=close-token&resume=close-key&format=msgpack"
            .into(),
    };

    let reason = websocket_close_reason(Some(&frame));
    let log_reason = websocket_close_frame_reason(&frame);

    assert_eq!(
        reason,
        "websocket closed code=1000 reason=url=wss://example/?access_token=<redacted>&resume=<redacted>&format=msgpack"
    );
    assert_eq!(
        log_reason,
        "url=wss://example/?access_token=<redacted>&resume=<redacted>&format=msgpack"
    );
    assert!(!reason.contains("close-token"));
    assert!(!reason.contains("close-key"));
    assert!(!log_reason.contains("close-token"));
    assert!(!log_reason.contains("close-key"));
}

#[test]
fn websocket_error_reason_redacts_auth_query_params() {
    let err = tungstenite::Error::Url(tungstenite::error::UrlError::UnableToConnect(
        "wss://example/?access_token=error-token&resume=error-key&format=msgpack".to_string(),
    ));

    let reason = websocket_error_reason(&err);

    assert_eq!(
        reason,
        "websocket error: URL error: Unable to connect to wss://example/?access_token=<redacted>&resume=<redacted>&format=msgpack"
    );
    assert!(!reason.contains("error-token"));
    assert!(!reason.contains("error-key"));
}
