use std::time::Duration;

pub(crate) const TEST_IO_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const RECONNECT_EVENT_TIMEOUT: Duration = Duration::from_secs(10);

mod config;
mod events;
mod protocol;
mod server;
mod token;
mod websocket;

pub(crate) use config::{
    test_config, test_config_with_key_name, test_config_with_pending_renewal,
    test_config_with_timing,
};
pub(crate) use events::{
    abort_server_task, assert_value_stable_for, expect_connected, expect_event,
    expect_event_matching_before, expect_event_with_timeout, expect_subscription_closed,
    join_server_task, wait_for_test_observation,
};
pub(crate) use protocol::{
    assert_attach_resume, expect_protocol_msg, now_ms, send_message,
    send_message_with_channel_serial,
};
pub(crate) use server::{HandshakeOptions, MockAblyServer, WsStream, send_connected};
pub(crate) use token::{RawTokenServer, mock_token_endpoint};
pub(crate) use websocket::{
    expect_websocket_close_frame, expect_websocket_close_frame_while_ignoring_attach,
    expect_websocket_closed,
};
