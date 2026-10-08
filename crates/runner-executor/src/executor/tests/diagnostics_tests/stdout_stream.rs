use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use sandbox::ProcessOutputChunk;

use super::super::super::diagnostics::{
    AgentStdoutStreamDiagnostics, StdoutDrainError, append_stdout_stream_diagnostics,
    drain_stdout_to_file,
};
use super::super::super::{
    STDOUT_STREAM_INCOMPLETE_MARKER, STDOUT_STREAM_LIMIT_MARKER, STDOUT_STREAM_OVERFLOW_MARKER,
};

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[tokio::test]
async fn drain_stdout_writes_chunks_to_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stdout.log");

    let (tx, rx) = tokio::sync::mpsc::channel(2);
    tx.send(ProcessOutputChunk {
        bytes: b"chunk 1\n".to_vec(),
        truncated: false,
    })
    .await
    .unwrap();
    tx.send(ProcessOutputChunk {
        bytes: b"chunk 2\n".to_vec(),
        truncated: false,
    })
    .await
    .unwrap();
    drop(tx); // close channel

    let report = drain_stdout_to_file(rx, path.clone(), tokio_util::sync::CancellationToken::new())
        .await
        .unwrap();

    let content = tokio::fs::read_to_string(&path).await.unwrap();
    assert_eq!(content, "chunk 1\nchunk 2\n");
    assert_eq!(report.bytes_written, 16);
    assert!(!report.chunk_truncated);
    assert!(!report.stream_incomplete);
    assert_eq!(mode(&path), 0o600);
}

#[tokio::test]
async fn drain_stdout_reports_truncated_chunk_without_changing_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stdout.log");

    let (tx, rx) = tokio::sync::mpsc::channel(1);
    tx.send(ProcessOutputChunk {
        bytes: b"partial chunk".to_vec(),
        truncated: true,
    })
    .await
    .unwrap();
    drop(tx);

    let report = drain_stdout_to_file(rx, path.clone(), tokio_util::sync::CancellationToken::new())
        .await
        .unwrap();

    let content = tokio::fs::read(&path).await.unwrap();
    assert_eq!(content, b"partial chunk");
    assert_eq!(report.bytes_written, 13);
    assert!(report.chunk_truncated);
    assert!(!report.stream_incomplete);
}

#[tokio::test]
async fn drain_stdout_empty_channel() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty.log");

    let (tx, rx) = tokio::sync::mpsc::channel::<ProcessOutputChunk>(1);
    drop(tx);

    let report = drain_stdout_to_file(rx, path.clone(), tokio_util::sync::CancellationToken::new())
        .await
        .unwrap();

    let content = tokio::fs::read_to_string(&path).await.unwrap();
    assert!(content.is_empty());
    assert_eq!(report.bytes_written, 0);
    assert!(!report.chunk_truncated);
    assert!(!report.stream_incomplete);
}

#[tokio::test]
async fn drain_stdout_invalid_path_returns_error() {
    let (tx, rx) = tokio::sync::mpsc::channel::<ProcessOutputChunk>(1);
    drop(tx);
    let error = drain_stdout_to_file(
        rx,
        PathBuf::from("/dev/null/impossible/file"),
        tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, StdoutDrainError::Open { .. }));
}

#[tokio::test]
async fn append_stdout_stream_diagnostics_noops_when_empty() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stdout.log");

    append_stdout_stream_diagnostics(&path, AgentStdoutStreamDiagnostics::default())
        .await
        .unwrap();

    assert!(!path.exists());
}

#[tokio::test]
async fn append_stdout_stream_diagnostics_writes_markers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("stdout.log");
    tokio::fs::write(&path, b"guest system log without newline")
        .await
        .unwrap();

    append_stdout_stream_diagnostics(
        &path,
        AgentStdoutStreamDiagnostics {
            bytes_written: 0,
            chunk_truncated: true,
            stream_overflowed: true,
            stream_incomplete: true,
        },
    )
    .await
    .unwrap();

    let content = tokio::fs::read(&path).await.unwrap();
    let mut expected = b"guest system log without newline\n".to_vec();
    expected.extend_from_slice(STDOUT_STREAM_LIMIT_MARKER);
    expected.extend_from_slice(STDOUT_STREAM_OVERFLOW_MARKER);
    expected.extend_from_slice(STDOUT_STREAM_INCOMPLETE_MARKER);
    assert_eq!(content, expected);
    assert_eq!(mode(&path), 0o600);
}
