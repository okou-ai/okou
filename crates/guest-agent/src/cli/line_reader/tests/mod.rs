use super::*;
use tokio::io::AsyncWriteExt as _;

const LIMIT: usize = 8;

fn reader(bytes: &'static str) -> tokio::io::BufReader<&'static [u8]> {
    tokio::io::BufReader::new(bytes.as_bytes())
}

#[tokio::test]
async fn fragmented_records_preserve_utf8_crlf_and_eof_bytes() {
    for capacity in [1, 2, 7] {
        let mut reader =
            tokio::io::BufReader::with_capacity(capacity, "aé🙂\r\n\nlast\r".as_bytes());
        let mut partial = Vec::new();

        // The first record reaches the eight-byte limit including CR.
        for expected in [Some("aé🙂"), Some(""), Some("last\r"), None] {
            let line = read_bounded_utf8_line(&mut reader, &mut partial, LIMIT)
                .await
                .expect("bounded fragmented record");
            assert_eq!(line.as_deref(), expected);
        }
    }
}

#[tokio::test]
async fn cancelled_read_resumes_partial_utf8_without_repeating_bytes() {
    let (mut writer, reader) = tokio::io::duplex(32);
    let mut reader = tokio::io::BufReader::with_capacity(3, reader);
    let mut partial = Vec::new();
    writer.write_all(b"a\xc3").await.expect("write prefix");

    // Read the available prefix, then cancel while waiting for its tail.
    tokio::select! {
        biased;
        result = read_bounded_utf8_line(&mut reader, &mut partial, LIMIT) => {
            panic!("incomplete record unexpectedly completed: {result:?}");
        }
        () = std::future::ready(()) => {}
    }

    writer
        .write_all(b"\xa9\xf0\x9f\x99\x82\r\nnext")
        .await
        .expect("write remaining records");
    writer.shutdown().await.expect("close writer");

    for expected in [Some("aé🙂"), Some("next"), None] {
        let line = read_bounded_utf8_line(&mut reader, &mut partial, LIMIT)
            .await
            .expect("resumed bounded record");
        assert_eq!(line.as_deref(), expected);
    }
}

#[tokio::test]
async fn fragmented_invalid_utf8_preserves_diagnostics_and_following_record() {
    for (bytes, error_len, following) in [
        (b"a\xff\nnext\n".as_slice(), Some(1), Some("next")),
        (b"a\xc3".as_slice(), None, None),
    ] {
        let mut reader = tokio::io::BufReader::with_capacity(1, bytes);
        let mut partial = Vec::new();
        let error = read_bounded_utf8_line(&mut reader, &mut partial, LIMIT)
            .await
            .expect_err("invalid UTF-8");
        assert!(matches!(
            error,
            BoundedLineError::InvalidUtf8 {
                valid_up_to: 1,
                error_len: actual_error_len,
                line_bytes: 2,
            } if actual_error_len == error_len
        ));
        let line = read_bounded_utf8_line(&mut reader, &mut partial, LIMIT)
            .await
            .expect("record after invalid UTF-8");
        assert_eq!(line.as_deref(), following);
    }
}

#[tokio::test]
async fn skipping_an_over_limit_record_resumes_at_the_next_one() {
    let mut reader = reader("oversized-record\nkept\n");
    let mut partial = Vec::new();

    let too_long = read_bounded_utf8_line(&mut reader, &mut partial, LIMIT).await;
    assert!(matches!(too_long, Err(BoundedLineError::TooLong)));

    // The failing read leaves the record in front of the reader, so the
    // next read repeats the failure until the remainder is drained.
    partial.clear();
    let repeated = read_bounded_utf8_line(&mut reader, &mut partial, LIMIT).await;
    assert!(matches!(repeated, Err(BoundedLineError::TooLong)));

    partial.clear();
    assert!(skip_to_line_end(&mut reader).await.expect("drain"));

    let next = read_bounded_utf8_line(&mut reader, &mut partial, LIMIT)
        .await
        .expect("record after the discarded one");
    assert_eq!(next.as_deref(), Some("kept"));
}

#[tokio::test]
async fn skipping_an_unterminated_record_reports_no_terminator() {
    let mut reader = reader("oversized-record-without-newline");
    let mut partial = Vec::new();

    assert!(matches!(
        read_bounded_utf8_line(&mut reader, &mut partial, LIMIT).await,
        Err(BoundedLineError::TooLong)
    ));

    partial.clear();
    assert!(!skip_to_line_end(&mut reader).await.expect("drain"));

    // The stream is exhausted, so the caller observes an ordinary EOF.
    let eof = read_bounded_utf8_line(&mut reader, &mut partial, LIMIT)
        .await
        .expect("eof after a drained unterminated record");
    assert_eq!(eof, None);
}

#[tokio::test]
async fn interrupted_skipping_resumes_without_consuming_the_next_record() {
    let mut reader = tokio::io::BufReader::with_capacity(4, "oversized-record\nkept\n".as_bytes());
    let mut partial = Vec::new();

    // A ready reader must yield after a non-final buffer, even when the
    // competing control is immediately ready. Dropping the drain future
    // must leave its consumed-byte progress available to the next call.
    let interrupted = tokio::select! {
        biased;
        _ = skip_to_line_end(&mut reader) => false,
        () = std::future::ready(()) => true,
    };
    assert!(
        interrupted,
        "ready discard buffers must not starve controls"
    );
    assert!(skip_to_line_end(&mut reader).await.expect("resumed drain"));
    let next = read_bounded_utf8_line(&mut reader, &mut partial, LIMIT)
        .await
        .expect("record after interrupted drain");
    assert_eq!(next.as_deref(), Some("kept"));
}

#[tokio::test]
async fn skipping_consumes_exactly_one_record() {
    let mut reader = reader("first\nsecond\n");
    let mut partial = Vec::new();

    assert!(skip_to_line_end(&mut reader).await.expect("drain"));

    let next = read_bounded_utf8_line(&mut reader, &mut partial, LIMIT)
        .await
        .expect("second record");
    assert_eq!(next.as_deref(), Some("second"));
}
