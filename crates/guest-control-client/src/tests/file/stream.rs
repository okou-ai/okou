use std::time::Duration;

use guest_control_proto::{
    MSG_ERROR, MSG_QUIESCE_OPERATIONS, MSG_WRITE_FILE_STREAM_BEGIN, MSG_WRITE_FILE_STREAM_CREDIT,
    MSG_WRITE_FILE_STREAM_DATA,
};

use super::super::support::setup_host_and_mock_guest;
use crate::FileCompression;

#[tokio::test]
async fn exhausted_stream_credit_keeps_control_live_and_cancellation_closes_connection() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let mut state = 34573_u64;
    let content = (0..1024 * 1024)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 32) as u8
        })
        .collect::<Vec<_>>();
    let mut write = Box::pin(host.write_file_with_compression(
        "/tmp/credit-cancel",
        &content,
        false,
        FileCompression::Zstd,
    ));
    let exhaust_credit = async {
        let begin = guest.expect_message(MSG_WRITE_FILE_STREAM_BEGIN).await;
        guest
            .send_response(MSG_WRITE_FILE_STREAM_CREDIT, begin.seq, &[4])
            .await;
        for _ in 0..4 {
            let data = guest.expect_message(MSG_WRITE_FILE_STREAM_DATA).await;
            assert_eq!(data.seq, begin.seq);
            assert!(!data.payload.is_empty());
            assert!(data.payload.len() <= 64 * 1024);
        }

        // Do not replenish credit. The next frame must be the unrelated
        // control request, not a fifth DATA frame or premature END.
        let control = host.quiesce_operations(Duration::from_secs(5));
        let respond = async {
            let request = guest.expect_message(MSG_QUIESCE_OPERATIONS).await;
            guest
                .send_response(
                    MSG_ERROR,
                    request.seq,
                    &guest_control_proto::encode_error("stream still active"),
                )
                .await;
        };
        let (result, ()) = tokio::join!(control, respond);
        assert_eq!(result.unwrap_err().to_string(), "stream still active");
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::select! {
            result = &mut write => panic!("stream finished without more credit: {result:?}"),
            () = exhaust_credit => {},
        }
    })
    .await
    .unwrap();

    // Dropping the public write future must release the bounded codec sink,
    // join its producer and close an admitted, unfinished connection.
    drop(write);
    guest.expect_eof().await;
    host.write_file("/tmp/after-cancel", b"later", false)
        .await
        .unwrap_err();
}
