use std::time::Duration;

use crate::support::{Harness, exec_exit_code, run_exec};

#[test]
fn unknown_request_returns_protocol_error_and_keeps_the_connection_usable() {
    use crate::support::{
        finish_raw_guest_connection, read_raw_message, start_raw_guest_connection,
    };
    use guest_control_proto::{MSG_ERROR, MSG_PING, MSG_PONG, decode_error, encode};
    use std::io::Write;

    let (guest, mut stream) = start_raw_guest_connection();
    stream
        .write_all(&encode(0xFE, 254, &[1, 2, 3]).unwrap())
        .unwrap();
    let response = read_raw_message(&mut stream);
    assert_eq!((response.msg_type, response.seq), (MSG_ERROR, 254));
    assert_eq!(
        decode_error(&response.payload).unwrap(),
        "Unknown message type: 0xFE"
    );
    stream
        .write_all(&encode(MSG_PING, 256, &[]).unwrap())
        .unwrap();
    let pong = read_raw_message(&mut stream);
    assert_eq!((pong.msg_type, pong.seq), (MSG_PONG, 256));
    finish_raw_guest_connection(guest, stream);
}

// ── shutdown ─────────────────────────────────────────────────────────

#[tokio::test]
async fn test_shutdown() {
    let h = Harness::new().await;

    h.host().shutdown(Duration::from_secs(5)).await.unwrap();

    h.finish();
}

#[tokio::test]
async fn test_shutdown_after_exec() {
    let h = Harness::new().await;

    // Run a command first, then shutdown
    let result = run_exec(h.host(), "echo before", 5000, &[], false)
        .await
        .expect("exec failed");
    assert_eq!(exec_exit_code(&result), Some(0));

    h.host().shutdown(Duration::from_secs(5)).await.unwrap();

    h.finish();
}
