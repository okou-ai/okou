//! Readiness checks for run-scoped files produced by guest test fixtures.

mod common;

use std::io;
use std::time::Duration;

const LARGE_LOG_BYTES: usize = 20 * 1024 * 1024;

#[tokio::test]
async fn readiness_observes_large_raw_log_after_creation() -> io::Result<()> {
    let temp = tempfile::tempdir()?;
    let log_path = temp.path().join("agent.jsonl");
    let mut contents = vec![b'x'; LARGE_LOG_BYTES];
    // Readiness searches raw bytes, including a non-UTF-8 prefix and an
    // incomplete marker before the complete sentinel at the end of the log.
    contents.push(0xff);
    contents.extend_from_slice(b"batching-senti\nbatching-sentinel\n");

    let readiness =
        common::wait_for_file_contains(&log_path, "batching-sentinel", Duration::from_secs(5));
    let writer = tokio::fs::write(&log_path, &contents);
    let (ready, written) = tokio::join!(readiness, writer);
    written?;
    ready
}

#[tokio::test]
async fn readiness_rejects_empty_marker() -> io::Result<()> {
    let temp = tempfile::tempdir()?;
    let error = common::wait_for_file_contains(
        &temp.path().join("agent.jsonl"),
        "",
        Duration::from_secs(5),
    )
    .await
    .expect_err("empty marker must not report readiness");
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    Ok(())
}
