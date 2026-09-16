use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::io;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::Poll;
use std::time::Duration;

use guest_control_proto::{
    ExecCapturedOutput, ExecOutputPolicy, ExecTermination, MSG_ERROR, MSG_EXEC_START,
    MSG_WRITE_FILE, MSG_WRITE_FILE_RESULT, MSG_WRITE_FILES,
};
use shell_quote::quote_shell_arg;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use super::super::support::{
    MockGuest, assert_connection_accepts_exec_operation, await_mock_guest, host_from_stream,
    make_pair, normal_operation_readiness, operation_count, pending_request_count,
    read_guest_message, send_exec_result, send_raw_exec_result, setup_host_and_guest,
};
use super::support::{
    ExecStartFrame, WriteFileFrame, expect_exec_start, expect_write_file, send_guest_error,
    send_write_file_failure, send_write_file_success, send_write_files_success,
};
use crate::{
    FrameWriteObserver, GuestControlClient, WriteFileEntry,
    operation_tracker::NormalOperationReadiness,
};
use crate::{exec_operation, file as file_impl};

struct ChunkedWriteFixture {
    host: Arc<GuestControlClient>,
    guest: UnixStream,
    target_path: &'static str,
    temp_path: Option<String>,
    sudo: bool,
}

impl ChunkedWriteFixture {
    async fn new(target_path: &'static str) -> Self {
        let (host, guest) = setup_host_and_guest().await;
        Self {
            host: Arc::new(host),
            guest,
            target_path,
            temp_path: None,
            sudo: false,
        }
    }

    fn chunk_limit() -> usize {
        file_impl::test_support::TEST_WRITE_FILE_CHUNK_LIMIT
    }

    fn two_chunk_content() -> Vec<u8> {
        vec![0xABu8; Self::chunk_limit() + 100]
    }

    fn three_chunk_content() -> Vec<u8> {
        vec![0xABu8; Self::chunk_limit() * 2 + 100]
    }

    fn spawn_write(&mut self, content: Vec<u8>, sudo: bool) -> JoinHandle<io::Result<()>> {
        self.sudo = sudo;
        spawn_write_file_with_small_chunks(Arc::clone(&self.host), self.target_path, content, sudo)
    }

    async fn expect_chunk(&mut self) -> WriteFileFrame {
        let frame = expect_write_file(&mut self.guest).await;
        assert_eq!(frame.sudo, self.sudo);
        assert!(!frame.private);
        if let Some(temp_path) = &self.temp_path {
            assert_eq!(frame.path.as_str(), temp_path);
            assert!(frame.append);
        } else {
            assert_chunked_temp_path(self.target_path, &frame.path);
            assert!(!frame.append);
            self.temp_path = Some(frame.path.clone());
        }
        frame
    }

    async fn expect_rename(&mut self) -> ExecStartFrame {
        let frame = expect_exec_start(&mut self.guest).await;
        assert_eq!(frame.label, "write-file-rename");
        assert_eq!(frame.sudo, self.sudo);
        assert_helper_exec_capture_policy(&frame);
        assert_eq!(frame.command, self.expected_rename_command());
        frame
    }

    async fn expect_cleanup(&mut self) -> ExecStartFrame {
        let frame = expect_exec_start(&mut self.guest).await;
        assert_eq!(frame.label, "exec-cleanup");
        assert_eq!(frame.sudo, self.sudo);
        assert_helper_exec_capture_policy(&frame);
        assert_eq!(frame.command, self.expected_cleanup_command());
        frame
    }

    fn expected_rename_command(&self) -> String {
        format!(
            "mv -fT -- {} {}",
            quote_shell_arg(self.temp_path()),
            quote_shell_arg(self.target_path)
        )
    }

    fn expected_cleanup_command(&self) -> String {
        format!("rm -f -- {}", quote_shell_arg(self.temp_path()))
    }

    fn assert_readiness(&self, expected: NormalOperationReadiness) {
        assert_eq!(normal_operation_readiness(&self.host), expected);
    }

    fn temp_path(&self) -> &str {
        self.temp_path.as_deref().expect("temp path")
    }
}

fn assert_chunked_temp_path(target_path: &str, temp_path: &str) {
    let target = Path::new(target_path);
    let temp = Path::new(temp_path);
    assert_eq!(temp.parent(), target.parent());
    let temp_name = temp
        .file_name()
        .and_then(|name| name.to_str())
        .expect("UTF-8 temp file name");
    assert!(temp_name.starts_with(".vm0tmp-"));
    assert!(temp_name.len() <= 255);
}

async fn write_file_with_small_chunks(
    host: &GuestControlClient,
    path: &str,
    content: &[u8],
    sudo: bool,
) -> io::Result<()> {
    file_impl::test_support::write_file_with_small_chunks(
        host,
        path,
        content,
        sudo,
        FrameWriteObserver::default(),
    )
    .await
}

async fn write_private_file_with_small_chunks(
    host: &GuestControlClient,
    path: &str,
    content: &[u8],
) -> io::Result<()> {
    file_impl::test_support::write_private_file_with_small_chunks(
        host,
        path,
        content,
        FrameWriteObserver::default(),
    )
    .await
}

fn spawn_write_file_with_small_chunks(
    host: Arc<GuestControlClient>,
    path: &'static str,
    content: Vec<u8>,
    sudo: bool,
) -> JoinHandle<io::Result<()>> {
    tokio::spawn(async move { write_file_with_small_chunks(&host, path, &content, sudo).await })
}

fn spawn_write_private_file_with_small_chunks(
    host: Arc<GuestControlClient>,
    path: &'static str,
    content: Vec<u8>,
) -> JoinHandle<io::Result<()>> {
    tokio::spawn(async move { write_private_file_with_small_chunks(&host, path, &content).await })
}

fn assert_helper_exec_capture_policy(frame: &ExecStartFrame) {
    let capture_policy = helper_exec_capture_policy();
    assert_eq!(frame.stdout, capture_policy);
    assert_eq!(frame.stderr, capture_policy);
    assert!(frame.expected_exit_codes.is_empty());
}

async fn poll_once_pending<F: Future>(mut future: Pin<&mut F>) {
    std::future::poll_fn(|cx| {
        assert!(
            future.as_mut().poll(cx).is_pending(),
            "write future unexpectedly completed"
        );
        Poll::Ready(())
    })
    .await;
}

fn helper_exec_capture_policy() -> ExecOutputPolicy {
    ExecOutputPolicy::Capture {
        limit_bytes: exec_operation::SMALL_EXEC_CAPTURE_LIMIT_BYTES,
    }
}

async fn drive_two_chunk_write_to_rename(fixture: &mut ChunkedWriteFixture) -> ExecStartFrame {
    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, second.seq()).await;

    fixture.expect_rename().await
}

#[tokio::test]
async fn write_file_chunked_cancelled_before_first_frame_write_does_not_cleanup() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;
    let content = ChunkedWriteFixture::two_chunk_content();
    let write_task = {
        let host = Arc::clone(&host);
        let write_start_count = Arc::clone(&write_start_count);
        tokio::spawn(async move {
            file_impl::test_support::write_file_with_small_chunks(
                &host,
                "/tmp/big-blocked.bin",
                &content,
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
        while pending_request_count(&host) != 1 {
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

    drop(writer_guard);
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn write_file_chunked_connection_close_while_waiting_for_writer_returns_connection_reset() {
    let (host, guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let writer_guard = host.shared.writer.lock().await;
    let (frame_built_tx, frame_built_rx) = oneshot::channel();
    let write_start_count = Arc::new(AtomicUsize::new(0));

    let write_task = {
        let host = Arc::clone(&host);
        let write_start_count = Arc::clone(&write_start_count);
        tokio::spawn(async move {
            let mut normal_operation = crate::CompositeNormalOperation::reserve(&host.shared)?;
            crate::request_on_shared_with_composite_operation_and_observer_frame_builder(
                &host.shared,
                &[MSG_ERROR, MSG_WRITE_FILE_RESULT],
                Duration::from_secs(5),
                &mut normal_operation,
                FrameWriteObserver::new(move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }),
                move |seq, frame| {
                    guest_control_proto::encode_write_file_frame_into(
                        frame,
                        seq,
                        "/tmp/chunked-waiting-writer-closed.txt",
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
            .await?;
            normal_operation.complete()
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
        .expect("chunked write should return after the writer is released")
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
async fn write_file_chunked_frame_builder_request_times_out_waiting_for_writer() {
    // The public chunked-write path uses the shared production request timeout,
    // so exercise its composite request seam with a practical test deadline.
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let writer_guard = host.shared.writer.lock().await;
    let (frame_built_tx, frame_built_rx) = oneshot::channel();
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let mut normal_operation = crate::CompositeNormalOperation::reserve(&host.shared).unwrap();

    let err = {
        let request = crate::request_on_shared_with_composite_operation_and_observer_frame_builder(
            &host.shared,
            &[MSG_ERROR, MSG_WRITE_FILE_RESULT],
            Duration::from_millis(50),
            &mut normal_operation,
            FrameWriteObserver::new({
                let write_start_count = Arc::clone(&write_start_count);
                move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }),
            move |seq, frame| {
                guest_control_proto::encode_write_file_frame_into(
                    frame,
                    seq,
                    "/tmp/chunked-writer-timeout.txt",
                    b"hello",
                    false,
                    false,
                )
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
                frame_built_tx.send(()).unwrap();
                Ok(())
            },
        );
        tokio::pin!(request);

        poll_once_pending(request.as_mut()).await;
        tokio::time::timeout(Duration::from_secs(5), frame_built_rx)
            .await
            .expect("frame should be built before waiting for the writer")
            .unwrap();
        assert_eq!(pending_request_count(&host), 1);
        assert_eq!(
            normal_operation_readiness(&host),
            NormalOperationReadiness::Busy
        );

        tokio::time::timeout(Duration::from_secs(5), request.as_mut())
            .await
            .expect("request should respect its writer-lock deadline")
            .unwrap_err()
    };

    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(pending_request_count(&host), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );
    drop(normal_operation);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );

    drop(writer_guard);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("timed-out writer request must not send later; read {n} bytes"),
        Err(err) => panic!("unexpected read error after writer timeout: {err}"),
    }
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn write_file_chunked_rejects_invalid_path_before_cleanup_or_write() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let path = format!("/{}", "a".repeat(u16::MAX as usize));
    let content = ChunkedWriteFixture::two_chunk_content();

    let err = file_impl::test_support::write_file_with_small_chunks(
        &host,
        &path,
        &content,
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
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert_eq!(operation_count(&host), 0);

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn write_file_chunked_rejects_invalid_guest_path_before_cleanup_or_write() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let content = ChunkedWriteFixture::two_chunk_content();

    let err = file_impl::test_support::write_file_with_small_chunks(
        &host,
        "/tmp/has\0nul",
        &content,
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
    assert_eq!(write_start_count.load(Ordering::SeqCst), 0);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
    assert_eq!(operation_count(&host), 0);

    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn test_write_file_chunked() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let chunk_limit = ChunkedWriteFixture::chunk_limit();
    let content = ChunkedWriteFixture::three_chunk_content();
    let write_task = fixture.spawn_write(content.clone(), false);

    let mut chunks_received = Vec::new();

    let first = fixture.expect_chunk().await;
    let first_seq = first.seq();
    chunks_received.push((first.append, first.content));
    send_write_file_success(&mut fixture.guest, first_seq).await;

    let second = fixture.expect_chunk().await;
    let second_seq = second.seq();
    chunks_received.push((second.append, second.content));
    send_write_file_success(&mut fixture.guest, second_seq).await;

    let third = fixture.expect_chunk().await;
    let third_seq = third.seq();
    chunks_received.push((third.append, third.content));
    send_write_file_success(&mut fixture.guest, third_seq).await;

    let rename = fixture.expect_rename().await;

    assert_eq!(chunks_received.len(), 3);
    assert!(!chunks_received[0].0);
    assert_eq!(chunks_received[0].1.len(), chunk_limit);
    assert!(chunks_received[1].0);
    assert_eq!(chunks_received[1].1.len(), chunk_limit);
    assert!(chunks_received[2].0);
    assert_eq!(chunks_received[2].1.len(), 100);
    let mut reassembled = chunks_received[0].1.clone();
    reassembled.extend_from_slice(&chunks_received[1].1);
    reassembled.extend_from_slice(&chunks_received[2].1);
    assert_eq!(reassembled, content);

    send_exec_result(
        &mut fixture.guest,
        rename.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    write_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn write_private_file_single_chunk_sets_private_flag() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_task = super::support::spawn_write_private_file(
        Arc::clone(&host),
        "/tmp/private.env",
        b"secret".to_vec(),
    );

    let frame = expect_write_file(&mut guest).await;
    assert_eq!(frame.path, "/tmp/private.env");
    assert_eq!(frame.content, b"secret");
    assert!(!frame.sudo);
    assert!(!frame.append);
    assert!(frame.private);
    send_write_file_success(&mut guest, frame.seq()).await;

    write_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn write_private_file_chunked_writes_final_path_without_rename() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let chunk_limit = ChunkedWriteFixture::chunk_limit();
    let content = vec![0xCD; chunk_limit + 100];
    let write_task = spawn_write_private_file_with_small_chunks(
        Arc::clone(&host),
        "/tmp/private-big.env",
        content,
    );

    let first = expect_write_file(&mut guest).await;
    assert_eq!(first.path, "/tmp/private-big.env");
    assert_eq!(first.content.len(), chunk_limit);
    assert!(!first.sudo);
    assert!(!first.append);
    assert!(first.private);
    send_write_file_success(&mut guest, first.seq()).await;

    let second = expect_write_file(&mut guest).await;
    assert_eq!(second.path, "/tmp/private-big.env");
    assert_eq!(second.content.len(), 100);
    assert!(!second.sudo);
    assert!(second.append);
    assert!(second.private);
    send_write_file_success(&mut guest, second.seq()).await;

    tokio::time::timeout(Duration::from_secs(1), write_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn write_private_file_chunked_serializes_equivalent_destinations() {
    let (host, mut guest) = setup_host_and_guest().await;
    let chunk_limit = ChunkedWriteFixture::chunk_limit();
    let content_a = vec![0xAA; chunk_limit + 1];
    let content_b = vec![0xBB; chunk_limit + 1];
    let mut write_a = Box::pin(write_private_file_with_small_chunks(
        &host,
        "/tmp/private-serialized.bin",
        &content_a,
    ));
    let mut write_b = Box::pin(write_private_file_with_small_chunks(
        &host,
        "/tmp/./private-serialized.bin",
        &content_b,
    ));

    let first_a = tokio::select! {
        _ = write_a.as_mut() => panic!("first private write completed before its first response"),
        frame = expect_write_file(&mut guest) => frame,
    };
    poll_once_pending(write_b.as_mut()).await;
    assert_eq!(first_a.path, "/tmp/private-serialized.bin");
    assert_eq!(first_a.content.len(), chunk_limit);
    assert_eq!(first_a.content.first(), Some(&0xAA));
    assert!(!first_a.append);
    assert!(first_a.private);
    send_write_file_success(&mut guest, first_a.seq()).await;

    let second_a = tokio::select! {
        _ = write_a.as_mut() => panic!("first private write completed before its append"),
        _ = write_b.as_mut() => panic!("second private write completed while the first held the destination"),
        frame = expect_write_file(&mut guest) => frame,
    };
    assert_eq!(second_a.path, "/tmp/private-serialized.bin");
    assert_eq!(second_a.content, [0xAA]);
    assert!(second_a.append);
    assert!(second_a.private);
    send_write_file_success(&mut guest, second_a.seq()).await;
    write_a.await.unwrap();

    let first_b = tokio::select! {
        _ = write_b.as_mut() => panic!("second private write completed before its first frame"),
        frame = expect_write_file(&mut guest) => frame,
    };
    assert_eq!(first_b.path, "/tmp/./private-serialized.bin");
    assert_eq!(first_b.content.len(), chunk_limit);
    assert_eq!(first_b.content.first(), Some(&0xBB));
    assert!(!first_b.append);
    assert!(first_b.private);
    send_write_file_success(&mut guest, first_b.seq()).await;

    let second_b = tokio::select! {
        _ = write_b.as_mut() => panic!("second private write completed before its append"),
        frame = expect_write_file(&mut guest) => frame,
    };
    assert_eq!(second_b.path, "/tmp/./private-serialized.bin");
    assert_eq!(second_b.content, [0xBB]);
    assert!(second_b.append);
    assert!(second_b.private);
    send_write_file_success(&mut guest, second_b.seq()).await;
    write_b.await.unwrap();
}

#[tokio::test]
async fn write_private_file_chunked_excludes_single_private_ordinary_and_batch_writes() {
    let (host, mut guest) = setup_host_and_guest().await;
    let target = "/tmp/private-exclusive.bin";
    let private_content = ChunkedWriteFixture::two_chunk_content();
    let mut private_write = Box::pin(write_private_file_with_small_chunks(
        &host,
        target,
        &private_content,
    ));

    let first_private = tokio::select! {
        _ = private_write.as_mut() => panic!("private write completed before its first response"),
        frame = expect_write_file(&mut guest) => frame,
    };
    assert_eq!(first_private.path, target);
    assert!(!first_private.append);
    assert!(first_private.private);

    let mut ordinary_write = Box::pin(host.write_file(target, b"ordinary", false));
    let mut single_private_write = Box::pin(host.write_private_file(target, b"single-private"));
    let batch_entries = [WriteFileEntry {
        path: target,
        content: b"batch",
    }];
    let mut batch_write = Box::pin(host.write_files(&batch_entries));
    poll_once_pending(ordinary_write.as_mut()).await;
    poll_once_pending(single_private_write.as_mut()).await;
    poll_once_pending(batch_write.as_mut()).await;

    send_write_file_success(&mut guest, first_private.seq()).await;
    let second_private = tokio::select! {
        _ = private_write.as_mut() => panic!("private write completed before its append"),
        _ = ordinary_write.as_mut() => panic!("ordinary write completed while private write held the destination"),
        _ = single_private_write.as_mut() => panic!("single-frame private write completed while chunked private write held the destination"),
        _ = batch_write.as_mut() => panic!("batch write completed while private write held the destination"),
        msg = read_guest_message(&mut guest) => msg,
    };
    assert_eq!(second_private.msg_type, MSG_WRITE_FILE);
    let (path, content, sudo, append, private) =
        guest_control_proto::decode_write_file(&second_private.payload).unwrap();
    assert_eq!(path, target);
    assert_eq!(content.len(), 100);
    assert!(!sudo);
    assert!(append);
    assert!(private);
    send_write_file_success(&mut guest, second_private.seq).await;
    private_write.await.unwrap();

    let guest_drive = async {
        let mut saw_ordinary = false;
        let mut saw_single_private = false;
        let mut saw_batch = false;
        while !(saw_ordinary && saw_single_private && saw_batch) {
            let msg = read_guest_message(&mut guest).await;
            match msg.msg_type {
                MSG_WRITE_FILE => {
                    let (path, content, sudo, append, private) =
                        guest_control_proto::decode_write_file(&msg.payload).unwrap();
                    assert_eq!(path, target);
                    assert!(!sudo);
                    assert!(!append);
                    if private {
                        assert!(!saw_single_private);
                        assert_eq!(content, b"single-private");
                        saw_single_private = true;
                    } else {
                        assert!(!saw_ordinary);
                        assert_eq!(content, b"ordinary");
                        saw_ordinary = true;
                    }
                    send_write_file_success(&mut guest, msg.seq).await;
                }
                MSG_WRITE_FILES => {
                    assert!(!saw_batch);
                    let files = guest_control_proto::decode_write_files(&msg.payload).unwrap();
                    assert_eq!(files.len(), 1);
                    assert_eq!(files[0].path, target);
                    assert_eq!(files[0].content, b"batch");
                    saw_batch = true;
                    send_write_files_success(&mut guest, msg.seq).await;
                }
                _ => panic!("unexpected guest message type {:#04x}", msg.msg_type),
            }
        }
    };
    let ((), ordinary_result, single_private_result, batch_result) = tokio::join!(
        guest_drive,
        ordinary_write.as_mut(),
        single_private_write.as_mut(),
        batch_write.as_mut()
    );
    ordinary_result.unwrap();
    single_private_result.unwrap();
    batch_result.unwrap();
}

#[tokio::test]
async fn write_private_file_chunked_allows_independent_path_progress() {
    let (host, mut guest) = setup_host_and_guest().await;
    let private_content = ChunkedWriteFixture::two_chunk_content();
    let mut private_write = Box::pin(write_private_file_with_small_chunks(
        &host,
        "/tmp/private-progress.bin",
        &private_content,
    ));

    let first_private = tokio::select! {
        _ = private_write.as_mut() => panic!("private write completed before its first response"),
        frame = expect_write_file(&mut guest) => frame,
    };
    assert_eq!(first_private.path, "/tmp/private-progress.bin");
    assert!(!first_private.append);
    assert!(first_private.private);

    let mut independent_write =
        Box::pin(host.write_file("/tmp/independent.bin", b"independent", false));
    poll_once_pending(independent_write.as_mut()).await;
    send_write_file_success(&mut guest, first_private.seq()).await;

    let independent = tokio::select! {
        _ = private_write.as_mut() => panic!("private write completed before its append"),
        _ = independent_write.as_mut() => panic!("independent write completed before its response"),
        frame = expect_write_file(&mut guest) => frame,
    };
    assert_eq!(independent.path, "/tmp/independent.bin");
    assert_eq!(independent.content, b"independent");
    assert!(!independent.append);
    assert!(!independent.private);
    send_write_file_success(&mut guest, independent.seq()).await;
    independent_write.await.unwrap();

    let second_private = tokio::select! {
        _ = private_write.as_mut() => panic!("private write completed before its append"),
        frame = expect_write_file(&mut guest) => frame,
    };
    assert_eq!(second_private.path, "/tmp/private-progress.bin");
    assert!(second_private.append);
    assert!(second_private.private);
    send_write_file_success(&mut guest, second_private.seq()).await;
    private_write.await.unwrap();
}

#[tokio::test]
async fn write_private_file_chunked_guest_failure_releases_tracker() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let chunk_limit = ChunkedWriteFixture::chunk_limit();
    let content = vec![0xCD; chunk_limit + 100];
    let write_task = spawn_write_private_file_with_small_chunks(
        Arc::clone(&host),
        "/tmp/private-fail.env",
        content,
    );

    let first = expect_write_file(&mut guest).await;
    assert_eq!(first.path, "/tmp/private-fail.env");
    assert!(!first.sudo);
    assert!(!first.append);
    assert!(first.private);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Busy
    );
    send_write_file_success(&mut guest, first.seq()).await;

    let second = expect_write_file(&mut guest).await;
    assert_eq!(second.path, "/tmp/private-fail.env");
    assert!(!second.sudo);
    assert!(second.append);
    assert!(second.private);
    send_write_file_failure(&mut guest, second.seq(), "disk full").await;

    let err = tokio::time::timeout(Duration::from_secs(1), write_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(err.to_string().contains("disk full"));
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Idle
    );
}

#[tokio::test]
async fn write_private_file_chunked_cancelled_before_first_frame_write_releases_tracker() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let writer_guard = host.shared.writer.lock().await;
    let content = ChunkedWriteFixture::two_chunk_content();
    let write_task = {
        let host = Arc::clone(&host);
        let write_start_count = Arc::clone(&write_start_count);
        tokio::spawn(async move {
            file_impl::test_support::write_private_file_with_small_chunks(
                &host,
                "/tmp/private-blocked.env",
                &content,
                FrameWriteObserver::new(move || {
                    write_start_count.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }),
            )
            .await
        })
    };

    tokio::time::timeout(Duration::from_secs(5), async {
        while pending_request_count(&host) != 1 {
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

    let successor = super::support::spawn_write_file(
        Arc::clone(&host),
        "/tmp/private-blocked.env",
        b"replacement".to_vec(),
        false,
    );
    drop(writer_guard);
    let successor_frame = expect_write_file(&mut guest).await;
    assert_eq!(successor_frame.path, "/tmp/private-blocked.env");
    assert_eq!(successor_frame.content, b"replacement");
    assert!(!successor_frame.private);
    send_write_file_success(&mut guest, successor_frame.seq()).await;
    successor.await.unwrap().unwrap();
    assert_connection_accepts_exec_operation(&host, &mut guest).await;
}

#[tokio::test]
async fn write_private_file_chunked_chunk_observer_error_keeps_tracker_fail_closed() {
    let (host, guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let content = ChunkedWriteFixture::two_chunk_content();

    let err = file_impl::test_support::write_private_file_with_small_chunks(
        &host,
        "/tmp/private-observer.env",
        &content,
        FrameWriteObserver::new({
            let write_start_count = Arc::clone(&write_start_count);
            move || {
                write_start_count.fetch_add(1, Ordering::SeqCst);
                Err(io::Error::other("private chunk observer failed"))
            }
        }),
    )
    .await
    .unwrap_err();

    assert!(err.to_string().contains("private chunk observer failed"));
    assert_eq!(write_start_count.load(Ordering::SeqCst), 1);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("observer error must not send private write_file frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after observer error: {err}"),
    }
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn write_private_file_chunked_unexpected_response_keeps_tracker_fail_closed() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let content = ChunkedWriteFixture::two_chunk_content();
    let write_task = spawn_write_private_file_with_small_chunks(
        Arc::clone(&host),
        "/tmp/private-unexpected.env",
        content,
    );

    let first = expect_write_file(&mut guest).await;
    assert_eq!(first.path, "/tmp/private-unexpected.env");
    assert!(!first.append);
    assert!(first.private);
    send_write_file_success(&mut guest, first.seq()).await;

    let second = expect_write_file(&mut guest).await;
    assert_eq!(second.path, "/tmp/private-unexpected.env");
    assert!(second.append);
    assert!(second.private);
    guest
        .write_all(&guest_control_proto::encode(MSG_EXEC_START, second.seq(), &[]).unwrap())
        .await
        .unwrap();

    let err = write_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => {
            panic!("private write must not send cleanup after unexpected response; read {n} bytes")
        }
        Err(err) => panic!("unexpected read error after unexpected response: {err}"),
    }
}

#[tokio::test]
async fn write_file_chunked_quotes_target_path_with_single_quote() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big'quote.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, second.seq()).await;

    let rename = fixture.expect_rename().await;
    assert!(rename.command.starts_with("mv -fT -- '/tmp/.vm0tmp-"));
    assert!(rename.command.ends_with(" '/tmp/big'\\''quote.bin'"));
    send_exec_result(
        &mut fixture.guest,
        rename.seq(),
        ExecTermination::Exited { exit_code: 1 },
        &[],
        b"permission denied",
    )
    .await;

    let cleanup = fixture.expect_cleanup().await;
    assert!(cleanup.command.starts_with("rm -f -- '/tmp/.vm0tmp-"));
    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("permission denied"));
    fixture.assert_readiness(NormalOperationReadiness::Idle);
}

#[tokio::test]
async fn write_file_chunked_concurrent_writes_to_same_target_use_distinct_temp_paths() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let target_path = "/tmp/shared.bin";
    let chunk_limit = ChunkedWriteFixture::chunk_limit();
    let write_a = spawn_write_file_with_small_chunks(
        Arc::clone(&host),
        target_path,
        vec![0xAA; chunk_limit + 1],
        false,
    );
    let write_b = spawn_write_file_with_small_chunks(
        Arc::clone(&host),
        target_path,
        vec![0xBB; chunk_limit + 1],
        false,
    );
    let mut chunks_by_temp: BTreeMap<String, (u8, usize)> = BTreeMap::new();
    let mut temp_by_marker: BTreeMap<u8, String> = BTreeMap::new();
    let mut renamed_temps = BTreeSet::new();

    while renamed_temps.len() < 2 {
        let msg = read_guest_message(&mut guest).await;
        match msg.msg_type {
            MSG_WRITE_FILE => {
                let (path, content, sudo, append, private) =
                    guest_control_proto::decode_write_file(&msg.payload).unwrap();
                assert!(!sudo);
                assert!(!private);
                assert_chunked_temp_path(target_path, path);
                let marker = *content.first().expect("chunk content");
                assert!(matches!(marker, 0xAA | 0xBB));
                assert!(content.iter().all(|byte| *byte == marker));

                if let Some((known_marker, chunk_count)) = chunks_by_temp.get_mut(path) {
                    assert_eq!(*known_marker, marker);
                    assert!(append);
                    assert_eq!(content.len(), 1);
                    *chunk_count += 1;
                } else {
                    assert!(!append);
                    assert_eq!(content.len(), chunk_limit);
                    assert!(temp_by_marker.insert(marker, path.to_string()).is_none());
                    chunks_by_temp.insert(path.to_string(), (marker, 1));
                }

                send_write_file_success(&mut guest, msg.seq).await;
            }
            MSG_EXEC_START => {
                let decoded = guest_control_proto::decode_exec_start(&msg.payload).unwrap();
                assert_eq!(decoded.label, "write-file-rename");
                assert!(!decoded.sudo);
                assert_eq!(decoded.stdout, helper_exec_capture_policy());
                assert_eq!(decoded.stderr, helper_exec_capture_policy());
                assert!(decoded.expected_exit_codes.is_empty());

                let renamed_temp = chunks_by_temp
                    .iter()
                    .find_map(|(temp_path, (_marker, chunk_count))| {
                        let expected_command = format!(
                            "mv -fT -- {} {}",
                            quote_shell_arg(temp_path),
                            quote_shell_arg(target_path)
                        );
                        (decoded.command == expected_command && *chunk_count == 2)
                            .then(|| temp_path.clone())
                    })
                    .expect("rename should target a completed temp path");
                assert!(renamed_temps.insert(renamed_temp));

                send_exec_result(
                    &mut guest,
                    msg.seq,
                    ExecTermination::Exited { exit_code: 0 },
                    &[],
                    &[],
                )
                .await;
            }
            _ => panic!("unexpected guest message type {:#04x}", msg.msg_type),
        }
    }

    assert_eq!(chunks_by_temp.len(), 2);
    assert_eq!(temp_by_marker.len(), 2);
    assert_ne!(temp_by_marker.get(&0xAA), temp_by_marker.get(&0xBB));
    assert!(chunks_by_temp.values().all(|(_marker, count)| *count == 2));

    write_a.await.unwrap().unwrap();
    write_b.await.unwrap().unwrap();
}

#[tokio::test]
async fn write_file_chunked_concurrent_failure_cleans_only_failed_temp_path() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let target_path = "/tmp/shared-failure.bin";
    let chunk_limit = ChunkedWriteFixture::chunk_limit();
    let success_marker = 0xAA;
    let failure_marker = 0xBB;
    let successful_write = spawn_write_file_with_small_chunks(
        Arc::clone(&host),
        target_path,
        vec![success_marker; chunk_limit + 1],
        false,
    );
    let failing_write = spawn_write_file_with_small_chunks(
        Arc::clone(&host),
        target_path,
        vec![failure_marker; chunk_limit + 1],
        false,
    );
    let mut temp_by_marker: BTreeMap<u8, String> = BTreeMap::new();
    let mut chunk_count_by_marker: BTreeMap<u8, usize> = BTreeMap::new();
    let mut successful_temp_renamed = false;
    let mut failed_temp_cleaned = false;

    while !(successful_temp_renamed && failed_temp_cleaned) {
        let msg = read_guest_message(&mut guest).await;
        match msg.msg_type {
            MSG_WRITE_FILE => {
                let (path, content, sudo, append, private) =
                    guest_control_proto::decode_write_file(&msg.payload).unwrap();
                assert!(!sudo);
                assert!(!private);
                assert_chunked_temp_path(target_path, path);
                let marker = *content.first().expect("chunk content");
                assert!(matches!(marker, 0xAA | 0xBB));
                assert!(content.iter().all(|byte| *byte == marker));

                let chunk_count = chunk_count_by_marker.entry(marker).or_default();
                if *chunk_count == 0 {
                    assert!(!append);
                    assert_eq!(content.len(), chunk_limit);
                    assert!(temp_by_marker.insert(marker, path.to_string()).is_none());
                } else {
                    assert_eq!(*chunk_count, 1);
                    assert!(append);
                    assert_eq!(content.len(), 1);
                    assert_eq!(
                        path,
                        temp_by_marker
                            .get(&marker)
                            .expect("second chunk should use first chunk temp path")
                    );
                }
                *chunk_count += 1;

                if marker == failure_marker && append {
                    send_write_file_failure(&mut guest, msg.seq, "disk full").await;
                } else {
                    send_write_file_success(&mut guest, msg.seq).await;
                }
            }
            MSG_EXEC_START => {
                let decoded = guest_control_proto::decode_exec_start(&msg.payload).unwrap();
                assert!(!decoded.sudo);
                assert_eq!(decoded.stdout, helper_exec_capture_policy());
                assert_eq!(decoded.stderr, helper_exec_capture_policy());
                assert!(decoded.expected_exit_codes.is_empty());
                let success_temp = temp_by_marker
                    .get(&success_marker)
                    .expect("successful temp path");
                let failed_temp = temp_by_marker
                    .get(&failure_marker)
                    .expect("failed temp path");
                assert_ne!(success_temp, failed_temp);

                match decoded.label {
                    "write-file-rename" => {
                        let expected_command = format!(
                            "mv -fT -- {} {}",
                            quote_shell_arg(success_temp),
                            quote_shell_arg(target_path)
                        );
                        assert_eq!(decoded.command, expected_command);
                        successful_temp_renamed = true;
                    }
                    "exec-cleanup" => {
                        let expected_command = format!("rm -f -- {}", quote_shell_arg(failed_temp));
                        assert_eq!(decoded.command, expected_command);
                        failed_temp_cleaned = true;
                    }
                    label => panic!("unexpected exec label {label}"),
                }

                send_exec_result(
                    &mut guest,
                    msg.seq,
                    ExecTermination::Exited { exit_code: 0 },
                    &[],
                    &[],
                )
                .await;
            }
            _ => panic!("unexpected guest message type {:#04x}", msg.msg_type),
        }
    }

    assert_eq!(chunk_count_by_marker.get(&success_marker), Some(&2));
    assert_eq!(chunk_count_by_marker.get(&failure_marker), Some(&2));

    successful_write.await.unwrap().unwrap();
    let err = failing_write.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
}

#[tokio::test]
async fn write_file_chunked_preserves_sudo_on_chunks_rename_cleanup_and_retry() {
    let mut rename_fixture = ChunkedWriteFixture::new("/tmp/sudo-big.bin").await;
    let rename_task = rename_fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), true);

    let first = rename_fixture.expect_chunk().await;
    send_write_file_success(&mut rename_fixture.guest, first.seq()).await;

    let second = rename_fixture.expect_chunk().await;
    send_write_file_success(&mut rename_fixture.guest, second.seq()).await;

    let rename = rename_fixture.expect_rename().await;
    send_exec_result(
        &mut rename_fixture.guest,
        rename.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    rename_task.await.unwrap().unwrap();

    let mut cleanup_fixture = ChunkedWriteFixture::new("/tmp/sudo-cleanup.bin").await;
    let cleanup_task = cleanup_fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), true);

    let first = cleanup_fixture.expect_chunk().await;
    send_write_file_success(&mut cleanup_fixture.guest, first.seq()).await;

    let second = cleanup_fixture.expect_chunk().await;
    send_write_file_failure(&mut cleanup_fixture.guest, second.seq(), "disk full").await;

    let cleanup = cleanup_fixture.expect_cleanup().await;
    send_guest_error(
        &mut cleanup_fixture.guest,
        cleanup.seq(),
        "cleanup unavailable",
    )
    .await;

    let err = cleanup_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
    cleanup_fixture.assert_readiness(NormalOperationReadiness::NotParkable);

    let retry = tokio::time::timeout(Duration::from_secs(2), cleanup_fixture.expect_cleanup())
        .await
        .expect("cleanup retry was not sent after sudo cleanup error");
    send_exec_result(
        &mut cleanup_fixture.guest,
        retry.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
}

#[tokio::test]
async fn write_file_chunked_tracks_one_operation_until_rename_result() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);
    send_write_file_success(&mut fixture.guest, second.seq()).await;

    let rename = fixture.expect_rename().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);

    send_exec_result(
        &mut fixture.guest,
        rename.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    write_task.await.unwrap().unwrap();
    fixture.assert_readiness(NormalOperationReadiness::Idle);
}

#[tokio::test]
async fn write_file_chunked_rename_result_before_connection_close_keeps_tracker_closed() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, second.seq()).await;

    let rename = fixture.expect_rename().await;
    send_exec_result(
        &mut fixture.guest,
        rename.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
    let host = Arc::clone(&fixture.host);
    drop(fixture.guest);
    host.wait_until_closed(Duration::from_secs(5))
        .await
        .unwrap();

    write_task.await.unwrap().unwrap();
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::Closed
    );
}

#[tokio::test]
async fn write_file_chunked_failure_remains_busy_until_cleanup_result() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_failure(&mut fixture.guest, second.seq(), "disk full").await;

    let cleanup = fixture.expect_cleanup().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);

    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
    fixture.assert_readiness(NormalOperationReadiness::Idle);
}

#[tokio::test]
async fn write_file_chunked_error_response_cleans_up_and_releases_tracker() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_guest_error(&mut fixture.guest, second.seq(), "guest write failed").await;

    let cleanup = fixture.expect_cleanup().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);
    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("guest write failed"));
    fixture.assert_readiness(NormalOperationReadiness::Idle);
}

#[tokio::test]
async fn write_file_chunked_chunk_observer_error_keeps_tracker_fail_closed() {
    let (host, guest) = setup_host_and_guest().await;
    let host = Arc::new(host);
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let content = ChunkedWriteFixture::two_chunk_content();

    let err = file_impl::test_support::write_file_with_small_chunks(
        &host,
        "/tmp/big.bin",
        &content,
        false,
        FrameWriteObserver::new({
            let write_start_count = Arc::clone(&write_start_count);
            move || {
                write_start_count.fetch_add(1, Ordering::SeqCst);
                Err(io::Error::other("chunk observer failed"))
            }
        }),
    )
    .await
    .unwrap_err();

    assert!(err.to_string().contains("chunk observer failed"));
    assert_eq!(write_start_count.load(Ordering::SeqCst), 1);
    match guest.try_read(&mut [0u8; 1]) {
        Err(err) if err.kind() == io::ErrorKind::WouldBlock => {}
        Ok(n) => panic!("observer error must not send write_file frame; read {n} bytes"),
        Err(err) => panic!("unexpected read error after observer error: {err}"),
    }
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );
}

#[tokio::test]
async fn write_file_chunked_unexpected_response_keeps_tracker_fail_closed() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    fixture
        .guest
        .write_all(&guest_control_proto::encode(MSG_EXEC_START, second.seq(), &[]).unwrap())
        .await
        .unwrap();

    let err = write_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    fixture.assert_readiness(NormalOperationReadiness::NotParkable);

    let cleanup_retry = tokio::time::timeout(Duration::from_secs(2), fixture.expect_cleanup())
        .await
        .expect("cleanup retry was not sent after unexpected response");
    send_exec_result(
        &mut fixture.guest,
        cleanup_retry.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
}

#[tokio::test]
async fn write_file_chunked_rename_error_response_cleans_up_and_releases_tracker() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, second.seq()).await;

    let rename = fixture.expect_rename().await;
    send_guest_error(&mut fixture.guest, rename.seq(), "rename unavailable").await;

    let cleanup = fixture.expect_cleanup().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);
    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("rename unavailable"));
    fixture.assert_readiness(NormalOperationReadiness::Idle);
}

#[tokio::test]
async fn write_file_chunked_rename_guest_timeout_cleans_up_and_releases_tracker() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let rename = drive_two_chunk_write_to_rename(&mut fixture).await;
    send_exec_result(
        &mut fixture.guest,
        rename.seq(),
        ExecTermination::TimedOut,
        &[],
        b"mv timed out",
    )
    .await;

    let cleanup = fixture.expect_cleanup().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);
    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    let message = err.to_string();
    assert!(message.contains("rename command timed out"));
    assert!(message.contains("mv timed out"));
    fixture.assert_readiness(NormalOperationReadiness::Idle);
}

#[tokio::test]
async fn write_file_chunked_rename_wait_timeout_cleans_up_and_keeps_tracker_fail_closed() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    tokio::time::pause();
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let _rename = drive_two_chunk_write_to_rename(&mut fixture).await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);

    tokio::time::advance(Duration::from_secs(11)).await;
    let cleanup = fixture.expect_cleanup().await;
    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    assert!(err.to_string().contains("exec operation timeout"));
    fixture.assert_readiness(NormalOperationReadiness::NotParkable);
}

#[tokio::test]
async fn write_file_chunked_rename_observer_error_keeps_tracker_fail_closed() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_start_count = Arc::new(AtomicUsize::new(0));
    let content = ChunkedWriteFixture::two_chunk_content();
    let write_task = {
        let host = Arc::clone(&fixture.host);
        let write_start_count = Arc::clone(&write_start_count);
        tokio::spawn(async move {
            file_impl::test_support::write_file_with_small_chunks(
                &host,
                "/tmp/big.bin",
                &content,
                false,
                FrameWriteObserver::new(move || {
                    if write_start_count.fetch_add(1, Ordering::SeqCst) == 2 {
                        return Err(io::Error::other("rename observer failed"));
                    }
                    Ok(())
                }),
            )
            .await
        })
    };

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, second.seq()).await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("rename observer failed"));
    assert_eq!(write_start_count.load(Ordering::SeqCst), 3);
    fixture.assert_readiness(NormalOperationReadiness::NotParkable);

    let cleanup = tokio::time::timeout(Duration::from_secs(2), fixture.expect_cleanup())
        .await
        .expect("cleanup retry was not sent after rename observer error");
    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
}

async fn assert_rename_terminal_failure_reports(
    termination: ExecTermination,
    stderr: &'static [u8],
    expected_message: &'static str,
) {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let rename = drive_two_chunk_write_to_rename(&mut fixture).await;
    let payload = guest_control_proto::encode_exec_result(
        termination,
        12,
        ExecCapturedOutput::Captured {
            bytes: b"",
            truncated: false,
        },
        ExecCapturedOutput::Captured {
            bytes: stderr,
            truncated: true,
        },
        "guest rename diagnostic",
    )
    .unwrap();
    send_raw_exec_result(&mut fixture.guest, rename.seq(), payload).await;

    let cleanup = fixture.expect_cleanup().await;
    fixture.assert_readiness(NormalOperationReadiness::Busy);
    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::Other);
    let message = err.to_string();
    let stderr_text = String::from_utf8_lossy(stderr);
    assert!(message.contains(expected_message), "{message}");
    assert!(
        message.contains("while moving temp file to /tmp/big.bin"),
        "{message}"
    );
    assert!(message.contains(stderr_text.as_ref()), "{message}");
    assert!(message.contains("stderr truncated"), "{message}");
    assert!(
        message.contains("diagnostic: guest rename diagnostic"),
        "{message}"
    );
    fixture.assert_readiness(NormalOperationReadiness::Idle);
}

#[tokio::test]
async fn write_file_chunked_rename_terminal_failures_report_distinct_errors() {
    assert_rename_terminal_failure_reports(
        ExecTermination::Cancelled,
        b"guest cancelled rename",
        "rename command was cancelled",
    )
    .await;
    assert_rename_terminal_failure_reports(
        ExecTermination::StartFailed,
        b"spawn failed",
        "rename command exec start failed",
    )
    .await;
    assert_rename_terminal_failure_reports(
        ExecTermination::WaitFailed,
        b"wait failed",
        "rename command exec wait failed",
    )
    .await;
}

#[tokio::test]
async fn write_file_chunked_cleanup_error_retries_untracked_on_drop() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_failure(&mut fixture.guest, second.seq(), "disk full").await;

    let cleanup = fixture.expect_cleanup().await;
    send_guest_error(&mut fixture.guest, cleanup.seq(), "cleanup unavailable").await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
    fixture.assert_readiness(NormalOperationReadiness::NotParkable);

    let retry = tokio::time::timeout(Duration::from_secs(2), fixture.expect_cleanup())
        .await
        .expect("cleanup retry was not sent after cleanup error");
    send_exec_result(
        &mut fixture.guest,
        retry.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
}

#[tokio::test]
async fn write_file_chunked_cleanup_guest_timeout_retries_untracked_on_drop() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_failure(&mut fixture.guest, second.seq(), "disk full").await;

    let cleanup = fixture.expect_cleanup().await;
    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::TimedOut,
        &[],
        b"cleanup timed out",
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
    fixture.assert_readiness(NormalOperationReadiness::NotParkable);

    let retry = tokio::time::timeout(Duration::from_secs(2), fixture.expect_cleanup())
        .await
        .expect("cleanup retry was not sent after timed out cleanup");
    send_exec_result(
        &mut fixture.guest,
        retry.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
}

#[tokio::test]
async fn write_file_chunked_cleanup_retry_does_not_reuse_write_observer() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_start_count = Arc::new(AtomicUsize::new(0));

    let content = ChunkedWriteFixture::two_chunk_content();
    let write_task = {
        let host = Arc::clone(&fixture.host);
        let write_start_count = Arc::clone(&write_start_count);
        tokio::spawn(async move {
            file_impl::test_support::write_file_with_small_chunks(
                &host,
                "/tmp/big.bin",
                &content,
                false,
                FrameWriteObserver::new(move || {
                    let count = write_start_count.fetch_add(1, Ordering::SeqCst);
                    if count >= 3 {
                        return Err(io::Error::other("write observer is no longer active"));
                    }
                    Ok(())
                }),
            )
            .await
        })
    };

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_failure(&mut fixture.guest, second.seq(), "disk full").await;

    let cleanup = fixture.expect_cleanup().await;
    send_guest_error(&mut fixture.guest, cleanup.seq(), "cleanup unavailable").await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
    assert_eq!(write_start_count.load(Ordering::SeqCst), 3);

    let retry = tokio::time::timeout(Duration::from_secs(2), fixture.expect_cleanup())
        .await
        .expect("cleanup retry was not sent after observer became inactive");
    send_exec_result(
        &mut fixture.guest,
        retry.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
    assert_eq!(write_start_count.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn write_file_chunked_cleanup_nonzero_exit_retries_untracked_on_drop() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_failure(&mut fixture.guest, second.seq(), "disk full").await;

    let cleanup = fixture.expect_cleanup().await;
    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 1 },
        &[],
        b"permission denied",
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
    fixture.assert_readiness(NormalOperationReadiness::NotParkable);

    let retry = tokio::time::timeout(Duration::from_secs(2), fixture.expect_cleanup())
        .await
        .expect("cleanup retry was not sent after nonzero cleanup exit");
    send_exec_result(
        &mut fixture.guest,
        retry.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;
}

#[tokio::test]
async fn write_file_production_chunk_boundaries() {
    let (host, mut guest) = setup_host_and_guest().await;
    let host = Arc::new(host);

    let chunk_limit = file_impl::test_support::WRITE_FILE_CHUNK_LIMIT;

    {
        let marker = 0xAB;
        let write_task = super::support::spawn_write_file(
            Arc::clone(&host),
            "/tmp/exact-limit.bin",
            vec![marker; chunk_limit],
            false,
        );

        let write = expect_write_file(&mut guest).await;
        assert_eq!(write.path, "/tmp/exact-limit.bin");
        assert_eq!(write.content.len(), chunk_limit);
        assert!(write.content.iter().all(|byte| *byte == marker));
        assert!(!write.sudo);
        assert!(!write.append);
        assert!(!write.private);
        send_write_file_success(&mut guest, write.seq()).await;
        drop(write);

        write_task.await.unwrap().unwrap();
    }

    {
        let marker = 0xCD;
        let target_path = "/tmp/over-limit.bin";
        let write_task = super::support::spawn_write_file(
            Arc::clone(&host),
            target_path,
            vec![marker; chunk_limit + 1],
            false,
        );

        let first = expect_write_file(&mut guest).await;
        assert_chunked_temp_path(target_path, &first.path);
        let temp_path = first.path.clone();
        assert_eq!(first.content.len(), chunk_limit);
        assert!(first.content.iter().all(|byte| *byte == marker));
        assert!(!first.sudo);
        assert!(!first.append);
        assert!(!first.private);
        send_write_file_success(&mut guest, first.seq()).await;
        drop(first);

        let second = expect_write_file(&mut guest).await;
        assert_eq!(second.path, temp_path);
        assert_eq!(second.content, [marker]);
        assert!(!second.sudo);
        assert!(second.append);
        assert!(!second.private);
        send_write_file_success(&mut guest, second.seq()).await;
        drop(second);

        let rename = expect_exec_start(&mut guest).await;
        assert_eq!(rename.label, "write-file-rename");
        assert_eq!(
            rename.command,
            format!(
                "mv -fT -- {} {}",
                quote_shell_arg(&temp_path),
                quote_shell_arg(target_path)
            )
        );
        assert!(!rename.sudo);
        assert_helper_exec_capture_policy(&rename);
        send_exec_result(
            &mut guest,
            rename.seq(),
            ExecTermination::Exited { exit_code: 0 },
            &[],
            &[],
        )
        .await;

        write_task.await.unwrap().unwrap();
    }

    {
        let marker = 0xEF;
        let target_path = "/tmp/private-over-limit.bin";
        let write_task = super::support::spawn_write_private_file(
            Arc::clone(&host),
            target_path,
            vec![marker; chunk_limit + 1],
        );

        let first = expect_write_file(&mut guest).await;
        assert_eq!(first.path, target_path);
        assert_eq!(first.content.len(), chunk_limit);
        assert!(first.content.iter().all(|byte| *byte == marker));
        assert!(!first.sudo);
        assert!(!first.append);
        assert!(first.private);
        send_write_file_success(&mut guest, first.seq()).await;
        drop(first);

        let second = expect_write_file(&mut guest).await;
        assert_eq!(second.path, target_path);
        assert_eq!(second.content, [marker]);
        assert!(!second.sudo);
        assert!(second.append);
        assert!(second.private);
        send_write_file_success(&mut guest, second.seq()).await;
        drop(second);

        write_task.await.unwrap().unwrap();
    }
}

#[tokio::test]
async fn test_write_file_chunked_cleans_up_on_chunk_failure() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_failure(&mut fixture.guest, second.seq(), "disk full").await;

    let cleanup = fixture.expect_cleanup().await;
    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("disk full"));
}

#[tokio::test]
async fn test_write_file_chunked_cleans_up_on_mv_failure() {
    let mut fixture = ChunkedWriteFixture::new("/tmp/big.bin").await;
    let write_task = fixture.spawn_write(ChunkedWriteFixture::two_chunk_content(), false);

    let first = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, first.seq()).await;

    let second = fixture.expect_chunk().await;
    send_write_file_success(&mut fixture.guest, second.seq()).await;

    let rename = fixture.expect_rename().await;
    send_exec_result(
        &mut fixture.guest,
        rename.seq(),
        ExecTermination::Exited { exit_code: 1 },
        &[],
        b"permission denied",
    )
    .await;

    let cleanup = fixture.expect_cleanup().await;
    send_exec_result(
        &mut fixture.guest,
        cleanup.seq(),
        ExecTermination::Exited { exit_code: 0 },
        &[],
        &[],
    )
    .await;

    let err = write_task.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("permission denied"));
}

#[tokio::test]
async fn test_write_file_chunked_cleans_up_when_cancelled() {
    let (host_stream, guest) = make_pair();

    let chunk_limit = ChunkedWriteFixture::chunk_limit();
    let content = vec![0xABu8; chunk_limit + 100];
    let (first_chunk_tx, first_chunk_rx) = oneshot::channel::<()>();
    let (cleanup_tx, cleanup_rx) = oneshot::channel::<String>();

    let mut guest_task = tokio::spawn(async move {
        let mut guest = MockGuest::new(guest);
        guest.complete_handshake().await;

        let mut temp_path = None::<String>;
        let mut first_chunk_tx = Some(first_chunk_tx);
        let mut cleanup_tx = Some(cleanup_tx);

        loop {
            let msg = guest.read_message().await;
            match msg.msg_type {
                MSG_WRITE_FILE => {
                    let (path, _chunk, sudo, append, private) =
                        guest_control_proto::decode_write_file(&msg.payload).unwrap();
                    assert!(!sudo);
                    assert!(!private);
                    if let Some(temp_path) = &temp_path {
                        assert_eq!(path, temp_path);
                        assert!(append);
                        continue;
                    }

                    assert_chunked_temp_path("/tmp/big.bin", path);
                    assert!(!append);
                    temp_path = Some(path.to_string());
                    send_write_file_success(guest.stream_mut(), msg.seq).await;
                    if let Some(tx) = first_chunk_tx.take() {
                        let _ = tx.send(());
                    }
                }
                MSG_EXEC_START => {
                    let decoded = guest_control_proto::decode_exec_start(&msg.payload).unwrap();
                    let temp_path = temp_path.as_ref().expect("temp path");
                    let expected_cleanup_command =
                        format!("rm -f -- {}", quote_shell_arg(temp_path));
                    assert_eq!(decoded.command, expected_cleanup_command.as_str());
                    assert_eq!(decoded.label, "exec-cleanup");
                    assert!(!decoded.sudo);
                    assert_eq!(decoded.stdout, helper_exec_capture_policy());
                    assert_eq!(decoded.stderr, helper_exec_capture_policy());
                    assert!(decoded.expected_exit_codes.is_empty());
                    if let Some(tx) = cleanup_tx.take() {
                        let _ = tx.send(decoded.command.to_string());
                    }
                    guest
                        .send_exec_result(
                            msg.seq,
                            ExecTermination::Exited { exit_code: 0 },
                            &[],
                            &[],
                        )
                        .await;
                    return;
                }
                _ => panic!("unexpected guest message type {:#04x}", msg.msg_type),
            }
        }
    });

    let host = host_from_stream(host_stream).await.unwrap();
    let mut write = Box::pin(write_file_with_small_chunks(
        &host,
        "/tmp/big.bin",
        &content,
        false,
    ));
    tokio::select! {
        _ = &mut write => panic!("chunked write completed before cancellation"),
        result = first_chunk_rx => {
            if result.is_err() {
                match (&mut guest_task).await {
                    Ok(()) => panic!("mock guest finished before first chunk"),
                    Err(err) => panic!("mock guest task panicked before first chunk: {err}"),
                }
            }
        }
        result = &mut guest_task => {
            result.expect("mock guest task panicked before first chunk");
            panic!("mock guest finished before first chunk");
        }
    }
    drop(write);
    assert_eq!(
        normal_operation_readiness(&host),
        NormalOperationReadiness::NotParkable
    );

    let cleanup_command = tokio::select! {
        biased;
        result = tokio::time::timeout(Duration::from_secs(2), cleanup_rx) => {
            match result {
                Ok(Ok(command)) => command,
                Ok(Err(_)) => {
                    match (&mut guest_task).await {
                        Ok(()) => panic!("mock guest finished before cleanup command"),
                        Err(err) => panic!("mock guest task panicked before cleanup command: {err}"),
                    }
                }
                Err(_) => panic!("cleanup command was not sent after cancellation"),
            }
        }
        result = &mut guest_task => {
            result.expect("mock guest task panicked before cleanup command");
            panic!("mock guest finished before cleanup command");
        }
    };
    assert!(cleanup_command.contains("rm -f --"));

    await_mock_guest(guest_task).await;
}
