use std::time::Duration;

use tokio::io::AsyncWriteExt;

use super::*;

#[derive(Debug, Eq, PartialEq)]
enum OwnedProcessLogRecord {
    Line(String),
    Truncated,
}

impl From<ProcessLogRecord<'_>> for OwnedProcessLogRecord {
    fn from(record: ProcessLogRecord<'_>) -> Self {
        match record {
            ProcessLogRecord::Line(line) => Self::Line(line.to_owned()),
            ProcessLogRecord::Truncated => Self::Truncated,
        }
    }
}

async fn collect_records(input: &[u8]) -> io::Result<Vec<OwnedProcessLogRecord>> {
    let mut records = Vec::new();
    read_process_log_records(input, |record| records.push(record.into())).await?;
    Ok(records)
}

#[tokio::test]
async fn reads_lf_crlf_and_final_partial_records() {
    let records = collect_records(b"first\nsecond\r\n\nfinal\r")
        .await
        .unwrap();

    assert_eq!(
        records,
        [
            OwnedProcessLogRecord::Line("first".to_string()),
            OwnedProcessLogRecord::Line("second".to_string()),
            OwnedProcessLogRecord::Line("final\r".to_string()),
        ]
    );
}

#[tokio::test]
async fn accepts_records_at_the_payload_limit() {
    let mut input = vec![b'a'; PROCESS_LOG_RECORD_MAX_BYTES];
    input.push(b'\n');
    input.extend(std::iter::repeat_n(b'b', PROCESS_LOG_RECORD_MAX_BYTES));
    input.extend_from_slice(b"\r\n");
    input.extend(std::iter::repeat_n(b'c', PROCESS_LOG_RECORD_MAX_BYTES));

    let records = collect_records(&input).await.unwrap();

    assert_eq!(records.len(), 3);
    assert_eq!(
        records[0],
        OwnedProcessLogRecord::Line("a".repeat(PROCESS_LOG_RECORD_MAX_BYTES))
    );
    assert_eq!(
        records[1],
        OwnedProcessLogRecord::Line("b".repeat(PROCESS_LOG_RECORD_MAX_BYTES))
    );
    assert_eq!(
        records[2],
        OwnedProcessLogRecord::Line("c".repeat(PROCESS_LOG_RECORD_MAX_BYTES))
    );
}

#[tokio::test]
async fn replaces_each_oversized_record_and_resumes_after_newline() {
    let mut input = vec![b'a'; PROCESS_LOG_RECORD_MAX_BYTES + 1];
    input.extend_from_slice(b"\nafter-first\n");
    input.extend(std::iter::repeat_n(b'b', PROCESS_LOG_RECORD_MAX_BYTES));
    input.extend_from_slice(b"\rx\nafter-second\n");
    input.extend(std::iter::repeat_n(b'c', PROCESS_LOG_RECORD_MAX_BYTES));
    input.push(b'\r');

    let records = collect_records(&input).await.unwrap();

    assert_eq!(
        records,
        [
            OwnedProcessLogRecord::Truncated,
            OwnedProcessLogRecord::Line("after-first".to_string()),
            OwnedProcessLogRecord::Truncated,
            OwnedProcessLogRecord::Line("after-second".to_string()),
            OwnedProcessLogRecord::Truncated,
        ]
    );
}

#[tokio::test]
async fn drains_continuous_oversized_output_without_waiting_for_eof() {
    let (mut writer, reader) = tokio::io::duplex(1024);
    let (record_tx, mut record_rx) = tokio::sync::mpsc::unbounded_channel();
    let reader_task = tokio::spawn(async move {
        read_process_log_records(reader, |record| {
            record_tx.send(record.into()).unwrap();
        })
        .await
    });

    tokio::time::timeout(
        Duration::from_secs(1),
        writer.write_all(&vec![b'x'; PROCESS_LOG_RECORD_MAX_BYTES * 4]),
    )
    .await
    .expect("reader should keep draining oversized output")
    .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), record_rx.recv())
            .await
            .expect("truncation record should be emitted before EOF"),
        Some(OwnedProcessLogRecord::Truncated)
    );

    writer.write_all(b"\nafter\n").await.unwrap();
    drop(writer);
    reader_task.await.unwrap().unwrap();

    let mut remaining = Vec::new();
    while let Some(record) = record_rx.recv().await {
        remaining.push(record);
    }
    assert_eq!(
        remaining,
        [OwnedProcessLogRecord::Line("after".to_string())]
    );
}

#[tokio::test]
async fn preserves_invalid_utf8_failure() {
    let error = collect_records(b"valid\n\xff\n").await.unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
}
