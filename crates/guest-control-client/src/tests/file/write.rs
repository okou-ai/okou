use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::Poll;
use std::time::Duration;

use guest_control_proto::{
    MSG_ERROR, MSG_EXEC_START, MSG_SHUTDOWN, MSG_SHUTDOWN_ACK, MSG_WRITE_FILE_RESULT,
};
use nix::sys::socket::{Shutdown, setsockopt, shutdown, sockopt};
use tokio::io::AsyncWriteExt;

use super::super::support::{
    MockGuest, assert_connection_accepts_exec_operation, await_mock_guest, host_from_stream,
    is_connected, make_pair, mock_handshake, normal_operation_readiness, pending_request_count,
    setup_host_and_guest, setup_host_and_mock_guest,
};
use super::support::{
    expect_write_file, expect_write_files, expect_write_private_files, send_guest_error,
    send_write_file_failure, send_write_file_success, send_write_files_failure,
    send_write_files_success, spawn_write_file, spawn_write_files, spawn_write_private_files,
};
use crate::{
    FrameWriteObserver, RequestTimeoutError, RequestTimeoutStage, RequestWriteError,
    RequestWriteStage, WriteFileEntry,
    file::test_support::{
        WRITE_FILES_BATCH_CONTENT_LIMIT, WRITE_FILES_BATCH_FILE_LIMIT,
        write_private_files_with_small_limits,
    },
    operation_tracker::NormalOperationReadiness,
};

// Public file APIs use the shared production request timeout. Use
// their shared request seam here so timeout lifecycle coverage remains fast.
const FRAME_BUILDER_REQUEST_TIMEOUT: Duration = Duration::from_millis(50);

#[tokio::test]
async fn explicit_zstd_preserves_the_callers_choice_and_bytes() {
    use guest_control_proto::{
        MSG_WRITE_FILE_STREAM_BEGIN, MSG_WRITE_FILE_STREAM_CREDIT, MSG_WRITE_FILE_STREAM_DATA,
        MSG_WRITE_FILE_STREAM_END,
    };

    let mut state = 34573_u64;
    let noise = (0..64 * 1024)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 32) as u8
        })
        .collect::<Vec<_>>();
    for content in [Vec::new(), b"x".to_vec(), noise] {
        let (host, mut guest) = setup_host_and_mock_guest().await;
        let receive = async {
            let begin = guest.read_message().await;
            assert_eq!(begin.msg_type, MSG_WRITE_FILE_STREAM_BEGIN);
            assert_eq!(begin.payload[0], 1);
            assert_eq!(
                u32::from_be_bytes(begin.payload[1..5].try_into().unwrap()) as usize,
                content.len()
            );
            let (path, bytes, sudo, append, private) =
                guest_control_proto::decode_write_file(&begin.payload[5..]).unwrap();
            assert_eq!(
                (path, bytes, sudo, append, private),
                ("/tmp/explicit", &[][..], false, false, false)
            );
            guest
                .send_response(MSG_WRITE_FILE_STREAM_CREDIT, begin.seq, &[4])
                .await;
            let mut encoded = Vec::new();
            loop {
                let frame = guest.read_message().await;
                assert_eq!(frame.seq, begin.seq);
                if frame.msg_type == MSG_WRITE_FILE_STREAM_END {
                    assert!(frame.payload.is_empty());
                    break;
                }
                assert_eq!(frame.msg_type, MSG_WRITE_FILE_STREAM_DATA);
                assert!(frame.payload.len() <= 64 * 1024);
                encoded.extend_from_slice(&frame.payload);
                guest
                    .send_response(MSG_WRITE_FILE_STREAM_CREDIT, begin.seq, &[1])
                    .await;
            }
            assert_ne!(encoded[4] & 4, 0, "frame must carry a checksum");
            assert_eq!(
                zstd::stream::decode_all(encoded.as_slice()).unwrap(),
                content
            );
            guest
                .send_response(
                    MSG_WRITE_FILE_RESULT,
                    begin.seq,
                    &guest_control_proto::encode_write_file_result(true, ""),
                )
                .await;
            encoded.len() as u64
        };
        let write = host.write_file_with_compression(
            "/tmp/explicit",
            &content,
            false,
            crate::FileCompression::Zstd,
        );
        let (result, received_wire_bytes) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(write, receive)
        })
        .await
        .unwrap();
        let measurements = result.unwrap();
        assert_eq!(measurements.wire_payload_bytes, received_wire_bytes);
        assert_eq!(measurements.requests, 1);
        assert_eq!(measurements.publication_elapsed, Duration::ZERO);
        assert!(measurements.encoder_pipeline_elapsed <= measurements.requests_elapsed);
    }
}

fn assert_request_timeout(
    error: &io::Error,
    expected_stage: RequestTimeoutStage,
    expected_timeout: Duration,
) {
    let timeout = error
        .get_ref()
        .and_then(|source| source.downcast_ref::<RequestTimeoutError>())
        .unwrap_or_else(|| panic!("expected typed request timeout, got {error:?}"));
    assert_eq!(timeout.stage(), expected_stage);
    assert_eq!(timeout.timeout(), expected_timeout);
}

async fn poll_once_pending<F: Future>(mut future: Pin<&mut F>) {
    std::future::poll_fn(|cx| {
        assert!(
            future.as_mut().poll(cx).is_pending(),
            "request future unexpectedly completed"
        );
        Poll::Ready(())
    })
    .await;
}

fn encode_test_write_file_frame(
    seq: u32,
    frame: &mut Vec<u8>,
    path: &str,
    content: &[u8],
) -> io::Result<()> {
    guest_control_proto::encode_write_file_frame_into(frame, seq, path, content, false, false)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))
}

#[tokio::test]
async fn write_files_sends_single_batch_and_tracks_until_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = spawn_write_files(
        Arc::clone(&host),
        vec![
            ("/tmp/a.txt", b"alpha".to_vec()),
            ("/tmp/b.txt", b"beta".to_vec()),
        ],
    );

    let write = expect_write_files(&mut guest).await;
    assert_eq!(
        write.files,
        vec![
            ("/tmp/a.txt".to_string(), b"alpha".to_vec()),
            ("/tmp/b.txt".to_string(), b"beta".to_vec()),
        ]
    );
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_write_files_success(&mut guest, write.seq()).await;

    write_task.await.unwrap().unwrap();
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_files_guest_failure_releases_tracker() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = spawn_write_files(
        Arc::clone(&host),
        vec![
            ("/tmp/a.txt", b"alpha".to_vec()),
            ("/tmp/b.txt", b"beta".to_vec()),
        ],
    );

    let write = expect_write_files(&mut guest).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_write_files_failure(&mut guest, write.seq(), "permission denied").await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("permission denied"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_private_files_sends_one_private_batch_and_tracks_until_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = spawn_write_private_files(
        Arc::clone(&host),
        vec![
            ("/tmp/private-a.txt", b"alpha".to_vec()),
            ("/tmp/private-b.txt", b"beta".to_vec()),
            ("/tmp/private-c.txt", b"gamma".to_vec()),
        ],
    );

    let write = expect_write_private_files(&mut guest).await;
    assert_eq!(
        write.files,
        vec![
            ("/tmp/private-a.txt".to_string(), b"alpha".to_vec()),
            ("/tmp/private-b.txt".to_string(), b"beta".to_vec()),
            ("/tmp/private-c.txt".to_string(), b"gamma".to_vec()),
        ]
    );
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_write_files_success(&mut guest, write.seq()).await;

    write_task.await.unwrap().unwrap();
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_private_files_guest_failure_releases_tracker_and_connection_reuses() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = spawn_write_private_files(
        Arc::clone(&host),
        vec![
            ("/tmp/private-a.txt", b"alpha".to_vec()),
            ("/tmp/private-b.txt", b"beta".to_vec()),
        ],
    );

    let write = expect_write_private_files(&mut guest).await;
    send_write_files_failure(&mut guest, write.seq(), "permission denied").await;

    let error = write_task.await.unwrap().unwrap_err();
    assert!(error.to_string().contains("permission denied"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn write_private_files_single_entry_uses_private_single_write() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = spawn_write_private_files(
        Arc::clone(&host),
        vec![("/tmp/private.txt", b"secret".to_vec())],
    );

    let write = expect_write_file(&mut guest).await;
    assert_eq!(write.path, "/tmp/private.txt");
    assert_eq!(write.content, b"secret");
    assert!(write.private);
    assert!(!write.append);
    send_write_file_success(&mut guest, write.seq()).await;

    write_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn write_private_files_oversized_aggregate_falls_back_to_private_single_writes() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let first = vec![0xA1; 600];
            let second = vec![0xB2; 600];
            write_private_files_with_small_limits(
                &host,
                &[
                    WriteFileEntry {
                        path: "/tmp/private-a.txt",
                        content: &first,
                    },
                    WriteFileEntry {
                        path: "/tmp/private-b.txt",
                        content: &second,
                    },
                    WriteFileEntry {
                        path: "/tmp/private-c.txt",
                        content: b"last entry",
                    },
                ],
                FrameWriteObserver::default(),
            )
            .await
        })
    };

    let first = expect_write_file(&mut guest).await;
    assert_eq!(first.path, "/tmp/private-a.txt");
    assert!(first.private);
    assert_eq!(first.content, vec![0xA1; 600]);
    send_write_file_success(&mut guest, first.seq()).await;

    let second = expect_write_file(&mut guest).await;
    assert_eq!(second.path, "/tmp/private-b.txt");
    assert!(second.private);
    assert_eq!(second.content, vec![0xB2; 600]);
    send_write_file_success(&mut guest, second.seq()).await;

    let third = expect_write_file(&mut guest).await;
    assert_eq!(third.path, "/tmp/private-c.txt");
    assert!(third.private);
    assert_eq!(third.content, b"last entry");
    send_write_file_success(&mut guest, third.seq()).await;

    write_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn write_private_files_fallback_failure_does_not_send_later_entries() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let content = vec![0xA1; 600];
            write_private_files_with_small_limits(
                &host,
                &[
                    WriteFileEntry {
                        path: "/tmp/context.json",
                        content: &content,
                    },
                    WriteFileEntry {
                        path: "/tmp/env.json",
                        content: &content,
                    },
                    WriteFileEntry {
                        path: "/tmp/payload.json",
                        content: b"last entry",
                    },
                ],
                FrameWriteObserver::default(),
            )
            .await
        })
    };

    let first = expect_write_file(&mut guest).await;
    assert_eq!(first.path, "/tmp/context.json");
    send_write_file_success(&mut guest, first.seq()).await;
    let second = expect_write_file(&mut guest).await;
    assert_eq!(second.path, "/tmp/env.json");
    send_write_file_failure(&mut guest, second.seq(), "permission denied").await;

    let error = write_task.await.unwrap().unwrap_err();
    assert!(error.to_string().contains("permission denied"));
    // A later command must be the next frame; no payload write or retry is allowed.
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn write_private_batch_missing_terminal_response_uses_one_deadline() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = spawn_write_private_files(
        Arc::clone(&host),
        vec![
            ("/tmp/context.json", b"context".to_vec()),
            ("/tmp/env.json", b"env".to_vec()),
            ("/tmp/payload.json", b"payload".to_vec()),
        ],
    );
    let write = expect_write_private_files(&mut guest).await;
    assert_eq!(write.files.len(), 3);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    // Freeze time only after real socket I/O has reached the terminal wait.
    tokio::time::pause();
    tokio::time::advance(guest_contracts::file_write::WRITE_FILE_REQUEST_DEADLINE).await;
    let error = write_task.await.unwrap().unwrap_err();

    assert_request_timeout(
        &error,
        RequestTimeoutStage::AwaitingTerminalResponse,
        guest_contracts::file_write::WRITE_FILE_REQUEST_DEADLINE,
    );
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    let later_error = host
        .write_private_file("/tmp/later.json", b"later")
        .await
        .unwrap_err();
    assert_eq!(later_error.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn dropping_private_batch_after_request_prevents_connection_reuse() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = spawn_write_private_files(
        Arc::clone(&host),
        vec![
            ("/tmp/context.json", b"context".to_vec()),
            ("/tmp/env.json", b"env".to_vec()),
            ("/tmp/payload.json", b"payload".to_vec()),
        ],
    );
    let write = expect_write_private_files(&mut guest).await;
    assert_eq!(write.files.len(), 3);

    write_task.abort();
    assert!(write_task.await.unwrap_err().is_cancelled());

    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    let error = host
        .write_private_file("/tmp/later.json", b"later")
        .await
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn write_private_files_empty_batch_is_noop() {
    let (host, guest) = setup_host_and_guest().await;
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;

    tokio::time::timeout(
        Duration::from_secs(5),
        host.write_private_files_with_write_observer(
            &[],
            FrameWriteObserver::new({
                let write_start_count = Arc::clone(&write_start_count);
                move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }),
        ),
    )
    .await
    .expect("empty write_private_files should return before waiting for the writer")
    .unwrap();

    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("empty write_private_files must not send a frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after empty write_private_files: {err}"),
    }
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    drop(writer_guard);
}

#[tokio::test]
async fn write_private_files_validates_every_path_before_fallback_writes() {
    let (host, guest) = setup_host_and_guest().await;
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;
    let first = vec![0xA1; 600];
    let second = vec![0xB2; 600];

    let error = tokio::time::timeout(
        Duration::from_secs(5),
        write_private_files_with_small_limits(
            &host,
            &[
                WriteFileEntry {
                    path: "/tmp/private-a.txt",
                    content: &first,
                },
                WriteFileEntry {
                    path: "/tmp/has\0nul",
                    content: &second,
                },
            ],
            FrameWriteObserver::new({
                let write_start_count = Arc::clone(&write_start_count);
                move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }),
        ),
    )
    .await
    .expect("invalid write_private_files should return before waiting for the writer")
    .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("invalid write_private_files must not send a frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after invalid write_private_files: {err}"),
    }
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    drop(writer_guard);
}

#[tokio::test]
async fn write_files_error_response_releases_tracker() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = spawn_write_files(
        Arc::clone(&host),
        vec![
            ("/tmp/a.txt", b"alpha".to_vec()),
            ("/tmp/b.txt", b"beta".to_vec()),
        ],
    );

    let write = expect_write_files(&mut guest).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_guest_error(&mut guest, write.seq(), "guest write failed").await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("guest write failed"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_files_unexpected_response_keeps_tracker_fail_closed() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = spawn_write_files(
        Arc::clone(&host),
        vec![
            ("/tmp/a.txt", b"alpha".to_vec()),
            ("/tmp/b.txt", b"beta".to_vec()),
        ],
    );

    let write = expect_write_files(&mut guest).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    let resp = guest_control_proto::encode(MSG_EXEC_START, write.seq(), &[]).unwrap();
    guest.write_all(&resp).await.unwrap();

    let err = write_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn write_files_empty_batch_is_noop() {
    let (host, guest) = setup_host_and_guest().await;
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;

    tokio::time::timeout(
        Duration::from_secs(5),
        host.write_files_with_write_observer(
            &[],
            FrameWriteObserver::new({
                let write_start_count = Arc::clone(&write_start_count);
                move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }),
        ),
    )
    .await
    .expect("empty write_files should return before waiting for the writer")
    .unwrap();

    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("empty write_files must not send a frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after empty write_files: {err}"),
    }
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    drop(writer_guard);
}

#[tokio::test]
async fn write_files_sends_empty_file_content() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.write_files(&[WriteFileEntry {
                path: "/tmp/empty.txt",
                content: b"",
            }])
            .await
        })
    };

    let write = tokio::time::timeout(Duration::from_secs(5), expect_write_files(&mut guest))
        .await
        .expect("write_files with empty file content should send a frame");
    assert_eq!(
        write.files,
        vec![("/tmp/empty.txt".to_string(), Vec::new())]
    );
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_write_files_success(&mut guest, write.seq()).await;

    write_task.await.unwrap().unwrap();
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_files_accepts_file_count_at_batch_limit() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let files = (0..WRITE_FILES_BATCH_FILE_LIMIT)
        .map(|index| {
            (
                format!("/tmp/batch-limit-{index}.txt"),
                format!("content-{index}").into_bytes(),
            )
        })
        .collect::<Vec<_>>();
    let expected_files = files.clone();

    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let entries = files
                .iter()
                .map(|(path, content)| WriteFileEntry {
                    path: path.as_str(),
                    content: content.as_slice(),
                })
                .collect::<Vec<_>>();
            host.write_files(&entries).await
        })
    };

    let write = tokio::time::timeout(Duration::from_secs(5), expect_write_files(&mut guest))
        .await
        .expect("write_files at the file-count limit should send a frame");
    assert_eq!(write.files, expected_files);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_write_files_success(&mut guest, write.seq()).await;

    write_task.await.unwrap().unwrap();
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_files_accepts_aggregate_content_at_batch_limit() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let first_len = WRITE_FILES_BATCH_CONTENT_LIMIT / 2;
            let second_len = WRITE_FILES_BATCH_CONTENT_LIMIT - first_len;
            let first_content = vec![0xA1u8; first_len];
            let second_content = vec![0xB2u8; second_len];
            host.write_files(&[
                WriteFileEntry {
                    path: "/tmp/content-limit-a.txt",
                    content: &first_content,
                },
                WriteFileEntry {
                    path: "/tmp/content-limit-b.txt",
                    content: &second_content,
                },
            ])
            .await
        })
    };

    let write = tokio::time::timeout(Duration::from_secs(5), expect_write_files(&mut guest))
        .await
        .expect("write_files at the content limit should send a frame");
    let [(first_path, first_content), (second_path, second_content)] = write.files.as_slice()
    else {
        panic!(
            "expected two write_files entries, got {}",
            write.files.len()
        );
    };
    assert_eq!(first_path, "/tmp/content-limit-a.txt");
    assert_eq!(second_path, "/tmp/content-limit-b.txt");
    assert_eq!(
        first_content.len() + second_content.len(),
        WRITE_FILES_BATCH_CONTENT_LIMIT
    );
    assert!(first_content.iter().all(|byte| *byte == 0xA1));
    assert!(second_content.iter().all(|byte| *byte == 0xB2));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_write_files_success(&mut guest, write.seq()).await;

    write_task.await.unwrap().unwrap();
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_files_rejects_file_count_above_batch_limit_before_sending_frame() {
    let (host, guest) = setup_host_and_guest().await;
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;
    let paths = (0..=WRITE_FILES_BATCH_FILE_LIMIT)
        .map(|index| format!("/tmp/too-many-files-{index}.txt"))
        .collect::<Vec<_>>();
    let files = paths
        .iter()
        .map(|path| WriteFileEntry {
            path: path.as_str(),
            content: b"x",
        })
        .collect::<Vec<_>>();

    let err = tokio::time::timeout(
        Duration::from_secs(5),
        host.write_files_with_write_observer(
            &files,
            FrameWriteObserver::new({
                let write_start_count = Arc::clone(&write_start_count);
                move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }),
        ),
    )
    .await
    .expect("file-count-invalid write_files should return before waiting for the writer")
    .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("file-count-invalid write_files must not send a frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after file-count-invalid write_files: {err}"),
    }
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    drop(writer_guard);
}

#[tokio::test]
async fn write_files_rejects_content_above_batch_limit_before_sending_frame() {
    let (host, guest) = setup_host_and_guest().await;
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;
    let content = vec![0u8; WRITE_FILES_BATCH_CONTENT_LIMIT + 1];

    let err = tokio::time::timeout(
        Duration::from_secs(5),
        host.write_files_with_write_observer(
            &[WriteFileEntry {
                path: "/tmp/too-large-batch-content.txt",
                content: &content,
            }],
            FrameWriteObserver::new({
                let write_start_count = Arc::clone(&write_start_count);
                move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }),
        ),
    )
    .await
    .expect("content-invalid write_files should return before waiting for the writer")
    .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("content-invalid write_files must not send a frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after content-invalid write_files: {err}"),
    }
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    drop(writer_guard);
}

#[tokio::test]
async fn write_files_rejects_aggregate_content_above_batch_limit_before_sending_frame() {
    let (host, guest) = setup_host_and_guest().await;
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;
    let first_len = (WRITE_FILES_BATCH_CONTENT_LIMIT / 2) + 1;
    let second_len = WRITE_FILES_BATCH_CONTENT_LIMIT - first_len + 1;
    let first_content = vec![0xA1u8; first_len];
    let second_content = vec![0xB2u8; second_len];

    let err = tokio::time::timeout(
        Duration::from_secs(5),
        host.write_files_with_write_observer(
            &[
                WriteFileEntry {
                    path: "/tmp/too-large-batch-a.txt",
                    content: &first_content,
                },
                WriteFileEntry {
                    path: "/tmp/too-large-batch-b.txt",
                    content: &second_content,
                },
            ],
            FrameWriteObserver::new({
                let write_start_count = Arc::clone(&write_start_count);
                move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }),
        ),
    )
    .await
    .expect("aggregate-content-invalid write_files should return before waiting for the writer")
    .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => {
            panic!("aggregate-content-invalid write_files must not send a frame; read {n} bytes")
        }
        Err(err) => {
            panic!("unexpected read error after aggregate-content-invalid write_files: {err}")
        }
    }
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    drop(writer_guard);
}

#[tokio::test]
async fn write_files_rejects_invalid_path_before_sending_frame() {
    let (host, guest) = setup_host_and_guest().await;
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;

    for path in ["", "/tmp/has\0nul"] {
        let err = tokio::time::timeout(
            Duration::from_secs(5),
            host.write_files_with_write_observer(
                &[WriteFileEntry {
                    path,
                    content: b"hello",
                }],
                FrameWriteObserver::new({
                    let write_start_count = Arc::clone(&write_start_count);
                    move || {
                        write_start_count.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    }
                }),
            ),
        )
        .await
        .expect("path-invalid write_files should return before waiting for the writer")
        .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("invalid write_files path must not send a frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after invalid write_files path: {err}"),
    }
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    drop(writer_guard);
}

#[tokio::test]
async fn write_file_tracks_until_result() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = spawn_write_file(
        Arc::clone(&host),
        "/tmp/tracked.txt",
        b"hello".to_vec(),
        false,
    );

    let write = expect_write_file(&mut guest).await;
    assert_eq!(write.path, "/tmp/tracked.txt");
    assert_eq!(write.content, b"hello");
    assert!(!write.sudo);
    assert!(!write.append);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_write_file_success(&mut guest, write.seq()).await;

    write_task.await.unwrap().unwrap();
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_file_guest_failure_releases_tracker() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/tracked.txt", b"bad", false).await })
    };

    let write = expect_write_file(&mut guest).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_write_file_failure(&mut guest, write.seq(), "permission denied").await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("permission denied"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_file_error_response_releases_tracker() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/tracked.txt", b"bad", false).await })
    };

    let write = expect_write_file(&mut guest).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    send_guest_error(&mut guest, write.seq(), "guest write failed").await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("guest write failed"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_file_unexpected_response_keeps_tracker_fail_closed() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/tracked.txt", b"bad", false).await })
    };

    let write = expect_write_file(&mut guest).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    let resp = guest_control_proto::encode(MSG_EXEC_START, write.seq(), &[]).unwrap();
    guest.write_all(&resp).await.unwrap();

    let err = write_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn dropping_write_file_after_request_marks_tracker_not_parkable() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/pending.txt", b"hello", false).await })
    };

    let _write = expect_write_file(&mut guest).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    write_task.abort();
    let _ = write_task.await;

    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    let err = host
        .exec_operation_capture_default(
            "blocked-after-write-drop",
            5000,
            &[],
            false,
            "exec",
            Duration::from_secs(10),
        )
        .await
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
}

#[tokio::test]
async fn write_file_cancelled_before_frame_write_does_not_poison_or_send_frame() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;
    let write_task = {
        let host = Arc::clone(&host);
        let write_start_count = Arc::clone(&write_start_count);
        tokio::spawn(async move {
            host.write_file_with_write_observer(
                "/tmp/blocked.txt",
                b"hello",
                false,
                FrameWriteObserver::new(move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }),
            )
            .await
        })
    };

    tokio::time::timeout(Duration::from_secs(5), async {
        while normal_operation_readiness(&host) != NormalOperationReadiness::Busy {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    write_task.abort();
    let _ = write_task.await;
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );

    drop(writer_guard);
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn file_stream_cancel_before_begin_keeps_connection_usable() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let writer_guard = host.shared.writer.lock().await;
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let options = crate::FileCompression::Zstd;
            host.write_file_with_compression("/tmp/stream-before-start", b"input", false, options)
                .await
        })
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        while normal_operation_readiness(&host) != NormalOperationReadiness::Busy {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    write_task.abort();
    let _ = write_task.await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    drop(writer_guard);
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn write_file_rejects_protocol_path_too_long_before_waiting_for_writer() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;
    let path = format!("/{}", "a".repeat(u16::MAX as usize));

    let err = tokio::time::timeout(Duration::from_secs(5), {
        let write_start_count = Arc::clone(&write_start_count);
        host.write_file_with_write_observer(
            &path,
            b"hello",
            false,
            FrameWriteObserver::new(move || {
                write_start_count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
        )
    })
    .await
    .unwrap()
    .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("protocol-invalid write_file must not send frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after protocol-invalid write_file: {err}"),
    }
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );

    drop(writer_guard);
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn write_file_frame_builder_request_zero_timeout_does_not_send_frame() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let build_count = Arc::new(AtomicUsize::new(0));
    let write_start_count = Arc::new(AtomicUsize::new(0));

    let err = crate::normal_request_on_shared_with_write_observer_frame_builder(
        &host.shared,
        &[MSG_ERROR, MSG_WRITE_FILE_RESULT],
        Duration::ZERO,
        FrameWriteObserver::new({
            let write_start_count = Arc::clone(&write_start_count);
            move || {
                write_start_count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        }),
        {
            let build_count = Arc::clone(&build_count);
            move |seq, frame| {
                build_count.fetch_add(1, Ordering::SeqCst);
                encode_test_write_file_frame(seq, frame, "/tmp/zero-timeout.txt", b"hello")
            }
        },
    )
    .await
    .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_request_timeout(&err, RequestTimeoutStage::BeforeFrameWrite, Duration::ZERO);
    assert_eq!(build_count.load(Ordering::SeqCst), 0);
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert!(is_connected(&host));
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("zero-timeout request must not send a frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after zero-timeout request: {err}"),
    }

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn write_file_frame_builder_request_times_out_waiting_for_builder() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let frame_builder_guard = host.shared.frame_builder.lock().await;
    let build_count = Arc::new(AtomicUsize::new(0));
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let request = crate::normal_request_on_shared_with_write_observer_frame_builder(
        &host.shared,
        &[MSG_ERROR, MSG_WRITE_FILE_RESULT],
        FRAME_BUILDER_REQUEST_TIMEOUT,
        FrameWriteObserver::new({
            let write_start_count = Arc::clone(&write_start_count);
            move || {
                write_start_count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        }),
        {
            let build_count = Arc::clone(&build_count);
            move |seq, frame| {
                build_count.fetch_add(1, Ordering::SeqCst);
                encode_test_write_file_frame(seq, frame, "/tmp/builder-timeout.txt", b"hello")
            }
        },
    );
    tokio::pin!(request);

    poll_once_pending(request.as_mut()).await;
    assert_eq!(pending_request_count(&host), 1);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    let err = tokio::time::timeout(Duration::from_secs(5), request.as_mut())
        .await
        .expect("request should respect its builder-lock deadline")
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_request_timeout(
        &err,
        RequestTimeoutStage::BeforeFrameWrite,
        FRAME_BUILDER_REQUEST_TIMEOUT,
    );
    assert_eq!(build_count.load(Ordering::SeqCst), 0);
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert!(is_connected(&host));

    drop(frame_builder_guard);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("timed-out builder request must not send later; read {n} bytes"),
        Err(err) => panic!("unexpected read error after builder timeout: {err}"),
    }
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn write_file_frame_builder_request_blocked_write_poisons_connection() {
    let (host_stream, mut guest) = make_pair();
    setsockopt(&host_stream, sockopt::SndBuf, &4096usize).unwrap();
    let host_task = tokio::spawn(async move { host_from_stream(host_stream).await.unwrap() });
    mock_handshake(&mut guest).await;
    let host = host_task.await.unwrap();
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let content = vec![0xAB; 1024 * 1024];
    let request = crate::normal_request_on_shared_with_write_observer_frame_builder(
        &host.shared,
        &[MSG_ERROR, MSG_WRITE_FILE_RESULT],
        FRAME_BUILDER_REQUEST_TIMEOUT,
        FrameWriteObserver::new({
            let write_start_count = Arc::clone(&write_start_count);
            move || {
                write_start_count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        }),
        move |seq, frame| {
            encode_test_write_file_frame(seq, frame, "/tmp/blocked-write.bin", &content)
        },
    );
    tokio::pin!(request);

    poll_once_pending(request.as_mut()).await;
    assert_eq!(write_start_count.load(Ordering::SeqCst), 1);

    let err = tokio::time::timeout(Duration::from_secs(5), request.as_mut())
        .await
        .expect("blocked write should respect its request deadline")
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_request_timeout(
        &err,
        RequestTimeoutStage::FrameWrite,
        FRAME_BUILDER_REQUEST_TIMEOUT,
    );
    assert!(!is_connected(&host));
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    assert!(host.shared.writer.try_lock().is_ok());
    assert!(host.shared.frame_builder.try_lock().is_ok());
}

#[tokio::test]
async fn write_file_frame_failure_poisons_connection_and_releases_gates() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    shutdown(host.shared.fd, Shutdown::Write).unwrap();
    assert!(is_connected(&host));

    let err = host
        .write_file("/tmp/write-error.txt", b"content", false)
        .await
        .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
    assert_eq!(
        err.get_ref()
            .unwrap()
            .downcast_ref::<RequestWriteError>()
            .unwrap()
            .stage(),
        RequestWriteStage::FrameWrite,
    );
    assert!(!is_connected(&host));
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    assert!(host.shared.writer.try_lock().is_ok());
    assert!(host.shared.frame_builder.try_lock().is_ok());
    assert!(host.shared.file_write_gate.try_lock().is_ok());
    guest.expect_eof().await;
}

#[tokio::test]
async fn write_private_file_missing_terminal_response_uses_shared_deadline_and_fails_closed() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    tokio::time::pause();
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            host.write_private_file("/tmp/private-input.json", b"payload")
                .await
        })
    };

    let write = expect_write_file(&mut guest).await;
    assert!(write.private);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    tokio::time::advance(guest_contracts::file_write::WRITE_FILE_REQUEST_DEADLINE).await;
    let error = write_task.await.unwrap().unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert_request_timeout(
        &error,
        RequestTimeoutStage::AwaitingTerminalResponse,
        guest_contracts::file_write::WRITE_FILE_REQUEST_DEADLINE,
    );
    assert_eq!(
        error
            .get_ref()
            .unwrap()
            .downcast_ref::<RequestTimeoutError>()
            .unwrap()
            .private_write_sequence(),
        Some(write.seq())
    );
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    let later_error = host
        .write_file("/tmp/later.txt", b"later", false)
        .await
        .unwrap_err();
    assert_eq!(later_error.kind(), io::ErrorKind::ConnectionReset);
    match guest.try_read(&mut [0u8; 1]) {
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
        Ok(read) => panic!("timed-out write must not be retried; read {read} bytes"),
        Err(error) => panic!("unexpected guest read after timeout: {error}"),
    }
}

#[tokio::test]
async fn write_file_frame_builder_runs_before_waiting_for_writer_lock() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let (frame_built_tx, frame_built_rx) = tokio::sync::oneshot::channel();
    let before_write_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;

    let write_task = {
        let host = Arc::clone(&host);
        let before_write_count = Arc::clone(&before_write_count);
        tokio::spawn(async move {
            crate::write_request_frame_with_builder(
                &host.shared,
                123,
                move |seq, frame| {
                    guest_control_proto::encode_write_file_frame_into(
                        frame,
                        seq,
                        "/tmp/built-before-lock.txt",
                        b"hello",
                        false,
                        false,
                    )
                    .map_err(|error| {
                        io::Error::new(io::ErrorKind::InvalidInput, error.to_string())
                    })?;
                    frame_built_tx.send(()).unwrap();
                    Ok(())
                },
                move || {
                    before_write_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
        })
    };

    tokio::time::timeout(Duration::from_secs(5), frame_built_rx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(before_write_count.load(Ordering::SeqCst), 0);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("frame must not be sent before writer lock is released; read {n} bytes"),
        Err(err) => panic!("unexpected read error before writer lock is released: {err}"),
    }

    drop(writer_guard);
    let write = expect_write_file(&mut guest).await;
    assert_eq!(write.seq(), 123);
    assert_eq!(write.path, "/tmp/built-before-lock.txt");
    assert_eq!(write.content, b"hello");
    assert!(!write.sudo);
    assert!(!write.append);
    assert!(!write.private);
    write_task.await.unwrap().unwrap();
    assert_eq!(before_write_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn lifecycle_request_writes_while_file_frame_builder_waits() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let host = Arc::new(host);
    let frame_builder_guard = host.shared.frame_builder.lock().await;
    let write_start_count = Arc::new(AtomicUsize::new(0));

    let write_task = {
        let host = Arc::clone(&host);
        let write_start_count = Arc::clone(&write_start_count);
        tokio::spawn(async move {
            host.write_file_with_write_observer(
                "/tmp/waiting-builder.txt",
                b"hello",
                false,
                FrameWriteObserver::new(move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }),
            )
            .await
        })
    };

    tokio::time::timeout(Duration::from_secs(5), async {
        while normal_operation_readiness(&host) != NormalOperationReadiness::Busy {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    let shutdown_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.shutdown(Duration::from_secs(5)).await })
    };
    let shutdown = guest.expect_message(MSG_SHUTDOWN).await;
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    guest
        .send_empty_response(MSG_SHUTDOWN_ACK, shutdown.seq)
        .await;
    shutdown_task.await.unwrap().unwrap();
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);

    drop(frame_builder_guard);
    let write = expect_write_file(guest.stream_mut()).await;
    assert_eq!(write.path, "/tmp/waiting-builder.txt");
    assert_eq!(write.content, b"hello");
    send_write_file_success(guest.stream_mut(), write.seq()).await;
    write_task.await.unwrap().unwrap();
    assert_eq!(write_start_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn file_write_gate_holds_through_result_and_lifecycle_bypasses_it() {
    let (host, mut guest) = setup_host_and_mock_guest().await;
    let host = Arc::new(host);
    let first_write = spawn_write_file(
        Arc::clone(&host),
        "/tmp/serialized-first.txt",
        b"first".to_vec(),
        false,
    );

    let first = expect_write_file(guest.stream_mut()).await;
    assert_eq!(first.path, "/tmp/serialized-first.txt");
    assert!(
        host.shared.file_write_gate.try_lock().is_err(),
        "file-write gate must remain held while the terminal result is pending"
    );

    let second_write = spawn_write_files(
        Arc::clone(&host),
        vec![("/tmp/serialized-second.txt", b"second".to_vec())],
    );
    let shutdown_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.shutdown(Duration::from_secs(5)).await })
    };

    let shutdown = guest.expect_message(MSG_SHUTDOWN).await;
    guest
        .send_empty_response(MSG_SHUTDOWN_ACK, shutdown.seq)
        .await;
    shutdown_task.await.unwrap().unwrap();
    assert!(host.shared.file_write_gate.try_lock().is_err());

    send_write_file_success(guest.stream_mut(), first.seq()).await;
    first_write.await.unwrap().unwrap();

    let second = expect_write_files(guest.stream_mut()).await;
    assert_eq!(
        second.files,
        vec![("/tmp/serialized-second.txt".to_string(), b"second".to_vec())]
    );
    send_write_files_success(guest.stream_mut(), second.seq()).await;
    second_write.await.unwrap().unwrap();
}

#[tokio::test]
async fn write_file_cancelled_while_waiting_for_frame_builder_does_not_poison_or_send_frame() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let frame_builder_guard = host.shared.frame_builder.lock().await;
    let write_start_count = Arc::new(AtomicUsize::new(0));

    let write_task = {
        let host = Arc::clone(&host);
        let write_start_count = Arc::clone(&write_start_count);
        tokio::spawn(async move {
            host.write_file_with_write_observer(
                "/tmp/waiting-builder-cancelled.txt",
                b"hello",
                false,
                FrameWriteObserver::new(move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }),
            )
            .await
        })
    };

    tokio::time::timeout(Duration::from_secs(5), async {
        while normal_operation_readiness(&host) != NormalOperationReadiness::Busy {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    write_task.abort();
    let _ = write_task.await;
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );

    drop(frame_builder_guard);
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn write_file_connection_close_while_waiting_for_frame_builder_keeps_tracker_closed() {
    let (host, guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let frame_builder_guard = host.shared.frame_builder.lock().await;
    let write_start_count = Arc::new(AtomicUsize::new(0));

    let write_task = {
        let host = Arc::clone(&host);
        let write_start_count = Arc::clone(&write_start_count);
        tokio::spawn(async move {
            host.write_file_with_write_observer(
                "/tmp/waiting-builder-closed.txt",
                b"hello",
                false,
                FrameWriteObserver::new(move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }),
            )
            .await
        })
    };

    tokio::time::timeout(Duration::from_secs(5), async {
        while normal_operation_readiness(&host) != NormalOperationReadiness::Busy {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    drop(guest);
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Closed
    );

    drop(frame_builder_guard);
    let err = tokio::time::timeout(Duration::from_secs(5), write_task)
        .await
        .expect("write_file should return after the frame builder is released")
        .unwrap()
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Closed
    );
}

#[tokio::test]
async fn write_file_connection_close_while_waiting_for_writer_keeps_tracker_closed() {
    let (host, guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let writer_guard = host.shared.writer.lock().await;
    let (frame_built_tx, frame_built_rx) = tokio::sync::oneshot::channel();
    let write_start_count = Arc::new(AtomicUsize::new(0));

    let write_task = {
        let host = Arc::clone(&host);
        let write_start_count = Arc::clone(&write_start_count);
        tokio::spawn(async move {
            crate::normal_request_on_shared_with_write_observer_frame_builder(
                &host.shared,
                &[MSG_ERROR, MSG_WRITE_FILE_RESULT],
                Duration::from_secs(5),
                FrameWriteObserver::new(move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }),
                move |seq, frame| {
                    guest_control_proto::encode_write_file_frame_into(
                        frame,
                        seq,
                        "/tmp/waiting-writer-closed.txt",
                        b"hello",
                        false,
                        false,
                    )
                    .map_err(|error| {
                        io::Error::new(io::ErrorKind::InvalidInput, error.to_string())
                    })?;
                    frame_built_tx.send(()).unwrap();
                    Ok(())
                },
            )
            .await
        })
    };

    tokio::time::timeout(Duration::from_secs(5), frame_built_rx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    drop(guest);
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Closed
    );

    drop(writer_guard);
    let err = tokio::time::timeout(Duration::from_secs(5), write_task)
        .await
        .expect("write_file should return after the writer is released")
        .unwrap()
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Closed
    );
}

#[tokio::test]
async fn write_file_rejects_invalid_path_before_sending_frame() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));

    for path in ["", "/tmp/has\0nul"] {
        let err = host
            .write_file_with_write_observer(
                path,
                b"hello",
                false,
                FrameWriteObserver::new({
                    let write_start_count = Arc::clone(&write_start_count);
                    move || {
                        write_start_count.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    }
                }),
            )
            .await
            .unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn write_files_rejects_protocol_message_too_large_before_waiting_for_writer() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;
    let path = format!("/{}", "a".repeat(u16::MAX as usize - 1));
    let content = vec![0u8; WRITE_FILES_BATCH_CONTENT_LIMIT];
    let mut files = Vec::new();
    files.push(WriteFileEntry {
        path: &path,
        content: &content,
    });
    for _ in 1..17 {
        files.push(WriteFileEntry {
            path: &path,
            content: b"",
        });
    }

    let err = tokio::time::timeout(Duration::from_secs(5), {
        let write_start_count = Arc::clone(&write_start_count);
        host.write_files_with_write_observer(
            &files,
            FrameWriteObserver::new(move || {
                write_start_count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
        )
    })
    .await
    .unwrap()
    .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("protocol-invalid write_files must not send frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after protocol-invalid write_files: {err}"),
    }
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );

    drop(writer_guard);
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn write_private_files_protocol_oversize_falls_back_to_private_single_writes() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move {
            let path = format!("/{}", "a".repeat(u16::MAX as usize - 1));
            let content = vec![0u8; WRITE_FILES_BATCH_CONTENT_LIMIT];
            let files = (0..17)
                .map(|index| WriteFileEntry {
                    path: &path,
                    content: if index == 0 { &content } else { &[] },
                })
                .collect::<Vec<_>>();

            host.write_private_files(&files).await
        })
    };

    for index in 0..17 {
        let write = expect_write_file(&mut guest).await;
        assert!(write.private);
        if index == 0 {
            assert_eq!(write.content.len(), WRITE_FILES_BATCH_CONTENT_LIMIT);
        } else {
            assert!(write.content.is_empty());
        }
        send_write_file_success(&mut guest, write.seq()).await;
    }

    write_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn write_file_observer_error_cleans_pending_without_sending_frame() {
    let (host, guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = host
        .write_file_with_write_observer(
            "/tmp/observer-error.txt",
            b"hello",
            false,
            FrameWriteObserver::new(|| Err(io::Error::other("observer failed"))),
        )
        .await
        .unwrap_err();

    assert!(err.to_string().contains("observer failed"));
    assert_eq!(
        err.get_ref()
            .unwrap()
            .downcast_ref::<RequestWriteError>()
            .unwrap()
            .stage(),
        RequestWriteStage::BeforeFrameWrite,
    );
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("observer error must not send write_file frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after observer error: {err}"),
    }
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn write_files_observer_error_cleans_pending_without_sending_frame() {
    let (host, guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let err = host
        .write_files_with_write_observer(
            &[WriteFileEntry {
                path: "/tmp/observer-error.txt",
                content: b"hello",
            }],
            FrameWriteObserver::new(|| Err(io::Error::other("observer failed"))),
        )
        .await
        .unwrap_err();

    assert!(err.to_string().contains("observer failed"));
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("observer error must not send write_files frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after write_files observer error: {err}"),
    }
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn write_file_connection_close_after_request_marks_tracker_not_parkable() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = {
        let host = Arc::clone(&host);
        tokio::spawn(async move { host.write_file("/tmp/pending.txt", b"hello", false).await })
    };

    let _write = expect_write_file(&mut guest).await;
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );

    drop(guest);
    let err = write_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn write_file_after_connection_close_returns_immediately_without_not_parkable() {
    let (host_stream, guest) = make_pair();

    let guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;
        drop(guest);
    });

    let host = host_from_stream(host_stream).await.unwrap();
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();

    let err = tokio::time::timeout(
        Duration::from_secs(5),
        host.write_file("/tmp/closed.txt", b"hello", false),
    )
    .await
    .expect("write_file should return when the connection is already closed")
    .unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Closed
    );
    await_mock_guest(guest_task).await;
}

#[tokio::test]
async fn test_write_file_failure() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = spawn_write_file(Arc::clone(&host), "/etc/shadow", b"bad".to_vec(), false);

    let write = expect_write_file(&mut guest).await;
    assert_eq!(write.path, "/etc/shadow");
    assert_eq!(write.content, b"bad");
    assert!(!write.sudo);
    assert!(!write.append);

    send_write_file_failure(&mut guest, write.seq(), "permission denied").await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("permission denied"));
}
