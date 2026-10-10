use super::*;
use crate::cow::CowLayer;
use crate::cow_io::CowIo;
use crate::protocol_impl::{Command, NbdReply, NbdRequest, REPLY_MAGIC, serialize_request};
use std::io::Write as _;
use std::os::unix::io::{FromRawFd, IntoRawFd, OwnedFd};
use std::time::Duration;
use tempfile::NamedTempFile;

fn must<T, E: std::fmt::Display>(result: std::result::Result<T, E>, context: &str) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("{context}: {error}"),
    }
}

fn create_test_cow(base_data: &[u8]) -> (NamedTempFile, NamedTempFile, CowLayer) {
    let mut base = must(NamedTempFile::new(), "create base tempfile");
    must(base.write_all(base_data), "write base tempfile");
    must(base.flush(), "flush base tempfile");
    let cow_file = must(NamedTempFile::new(), "create COW tempfile");
    let cow = must(
        CowLayer::new(
            base.path(),
            cow_file.path(),
            base_data.len() as u64,
            crate::BLOCK_SIZE,
            crate::DEFAULT_FLUSH_THRESHOLD,
        ),
        "create test COW layer",
    );
    (base, cow_file, cow)
}

async fn setup_dispatch(
    cow: CowIo,
) -> (
    tokio::net::unix::OwnedReadHalf,
    tokio::net::unix::OwnedWriteHalf,
    tokio::task::JoinHandle<crate::error::Result<()>>,
    CancellationToken,
) {
    let shutdown = CancellationToken::new();
    let (reader, writer, server_fd) = setup_dispatch_socket();

    let shutdown_clone = shutdown.clone();
    let task = tokio::spawn(async move { dispatch(server_fd, cow, shutdown_clone).await });

    (reader, writer, task, shutdown)
}

async fn setup_observed_dispatch(
    cow: CowIo,
) -> (
    tokio::net::unix::OwnedReadHalf,
    tokio::net::unix::OwnedWriteHalf,
    tokio::task::JoinHandle<crate::error::Result<()>>,
    CancellationToken,
    tokio::sync::mpsc::UnboundedReceiver<DispatchReadEvent>,
) {
    let shutdown = CancellationToken::new();
    let (reader, writer, server_fd) = setup_dispatch_socket();
    let (event_sender, read_events) = tokio::sync::mpsc::unbounded_channel();

    let shutdown_clone = shutdown.clone();
    let task = tokio::spawn(async move {
        dispatch_with_observers(
            server_fd,
            cow,
            shutdown_clone,
            DispatchReadObserver::new(event_sender),
            DispatchWriteLimit::none(),
        )
        .await
    });

    (reader, writer, task, shutdown, read_events)
}

fn setup_dispatch_socket() -> (
    tokio::net::unix::OwnedReadHalf,
    tokio::net::unix::OwnedWriteHalf,
    OwnedFd,
) {
    let (client_fd, server_fd) = {
        let mut fds = [0i32; 2];
        let ret =
            unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) };
        assert_eq!(ret, 0);
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
    };

    let client_std =
        unsafe { std::os::unix::net::UnixStream::from_raw_fd(client_fd.into_raw_fd()) };
    must(
        client_std.set_nonblocking(true),
        "set client stream nonblocking",
    );
    let client_stream = must(
        UnixStream::from_std(client_std),
        "create tokio client stream",
    );

    let (reader, writer) = client_stream.into_split();
    (reader, writer, server_fd)
}

async fn send_and_recv_reply(
    reader: &mut tokio::net::unix::OwnedReadHalf,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    req: &NbdRequest,
) -> u32 {
    must(
        writer.write_all(&serialize_request(req)).await,
        "write request",
    );
    let reply = read_reply(reader).await;
    assert_eq!(reply.handle, req.handle);
    reply.error
}

async fn send_write_and_recv_reply(
    reader: &mut tokio::net::unix::OwnedReadHalf,
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    req: &NbdRequest,
    data: &[u8],
) -> u32 {
    assert_eq!(data.len(), req.length as usize);
    must(
        writer.write_all(&serialize_request(req)).await,
        "write request",
    );
    must(writer.write_all(data).await, "write payload");
    let reply = read_reply(reader).await;
    assert_eq!(reply.handle, req.handle);
    reply.error
}

async fn read_reply(reader: &mut tokio::net::unix::OwnedReadHalf) -> NbdReply {
    let mut reply_buf = [0u8; 16];
    must(reader.read_exact(&mut reply_buf).await, "read reply header");
    assert_eq!(
        u32::from_be_bytes([reply_buf[0], reply_buf[1], reply_buf[2], reply_buf[3]]),
        REPLY_MAGIC
    );
    NbdReply {
        error: u32::from_be_bytes([reply_buf[4], reply_buf[5], reply_buf[6], reply_buf[7]]),
        handle: u64::from_be_bytes([
            reply_buf[8],
            reply_buf[9],
            reply_buf[10],
            reply_buf[11],
            reply_buf[12],
            reply_buf[13],
            reply_buf[14],
            reply_buf[15],
        ]),
    }
}

async fn read_payload(reader: &mut tokio::net::unix::OwnedReadHalf, len: usize) -> Vec<u8> {
    let mut data = vec![0u8; len];
    must(reader.read_exact(&mut data).await, "read payload");
    data
}

async fn wait_for_dispatch(task: tokio::task::JoinHandle<crate::error::Result<()>>) {
    let joined = match tokio::time::timeout(Duration::from_secs(1), task).await {
        Ok(joined) => joined,
        Err(_) => panic!("dispatch should exit"),
    };
    let result = must(joined, "join dispatch task");
    must(result, "dispatch task");
}

async fn assert_dispatch_exits_after_shutdown(
    task: tokio::task::JoinHandle<crate::error::Result<()>>,
) {
    let joined = match tokio::time::timeout(Duration::from_secs(1), task).await {
        Ok(joined) => joined,
        Err(_) => panic!("dispatch should exit after shutdown"),
    };
    let result = must(joined, "dispatch task should join");
    must(result, "dispatch should not fail");
}

async fn wait_for_read_event(
    read_events: &mut tokio::sync::mpsc::UnboundedReceiver<DispatchReadEvent>,
    expected: DispatchReadEvent,
) {
    let observed = tokio::time::timeout(Duration::from_secs(1), async {
        while let Some(event) = read_events.recv().await {
            if event == expected {
                return;
            }
        }
        panic!("dispatch read observer closed before {expected:?}");
    })
    .await;
    match observed {
        Ok(()) => {}
        Err(_) => panic!("dispatch should reach {expected:?}"),
    }
}

#[tokio::test]
async fn dispatch_large_then_small_requests_keep_stream_aligned() {
    let large_len = MAX_REUSABLE_PAYLOAD_LENGTH + crate::BLOCK_SIZE;
    let small_len = 512usize;
    let small_offset = large_len as u64;
    let alignment_offset = (large_len + crate::BLOCK_SIZE) as u64;
    let mut base_data = vec![0x11; large_len + 2 * crate::BLOCK_SIZE];
    base_data[large_len + crate::BLOCK_SIZE..].fill(0x33);
    let (_base, _cow_file, cow) = create_test_cow(&base_data);
    let cow = CowIo::new(cow);

    let (mut reader, mut writer, task, _shutdown) = setup_dispatch(cow).await;

    let large_write = NbdRequest {
        command: Command::Write,
        handle: 1,
        offset: 0,
        length: large_len as u32,
    };
    let large_write_data = vec![0x44; large_len];
    let error =
        send_write_and_recv_reply(&mut reader, &mut writer, &large_write, &large_write_data).await;
    assert_eq!(error, 0, "large write should succeed");

    let small_write = NbdRequest {
        command: Command::Write,
        handle: 2,
        offset: small_offset,
        length: small_len as u32,
    };
    let small_write_data = vec![0x55; small_len];
    let error =
        send_write_and_recv_reply(&mut reader, &mut writer, &small_write, &small_write_data).await;
    assert_eq!(error, 0, "small write after large write should succeed");

    let large_read = NbdRequest {
        command: Command::Read,
        handle: 3,
        offset: 0,
        length: large_len as u32,
    };
    let error = send_and_recv_reply(&mut reader, &mut writer, &large_read).await;
    assert_eq!(error, 0, "large read should succeed");
    let large_read_data = read_payload(&mut reader, large_len).await;
    assert!(large_read_data.iter().all(|&byte| byte == 0x44));

    let small_read = NbdRequest {
        command: Command::Read,
        handle: 4,
        offset: small_offset,
        length: small_len as u32,
    };
    let error = send_and_recv_reply(&mut reader, &mut writer, &small_read).await;
    assert_eq!(error, 0, "small read after large read should succeed");
    let small_read_data = read_payload(&mut reader, small_len).await;
    assert_eq!(small_read_data, small_write_data);

    let max_reusable_read = NbdRequest {
        command: Command::Read,
        handle: 5,
        offset: 0,
        length: MAX_REUSABLE_PAYLOAD_LENGTH as u32,
    };
    let error = send_and_recv_reply(&mut reader, &mut writer, &max_reusable_read).await;
    assert_eq!(error, 0, "max reusable read should succeed");
    let max_reusable_data = read_payload(&mut reader, MAX_REUSABLE_PAYLOAD_LENGTH).await;
    assert!(max_reusable_data.iter().all(|&byte| byte == 0x44));

    let alignment_read = NbdRequest {
        command: Command::Read,
        handle: 6,
        offset: alignment_offset,
        length: crate::BLOCK_SIZE as u32,
    };
    let error = send_and_recv_reply(&mut reader, &mut writer, &alignment_read).await;
    assert_eq!(error, 0, "read after max reusable read should stay aligned");
    let alignment_data = read_payload(&mut reader, crate::BLOCK_SIZE).await;
    assert!(alignment_data.iter().all(|&byte| byte == 0x33));

    let disc = NbdRequest {
        command: Command::Disconnect,
        handle: 7,
        offset: 0,
        length: 0,
    };
    must(
        writer.write_all(&serialize_request(&disc)).await,
        "write disconnect request",
    );
    wait_for_dispatch(task).await;
}

#[tokio::test]
async fn dispatch_forced_partial_vectored_reads_keep_stream_aligned() {
    let base_data: Vec<u8> = (0..3 * crate::BLOCK_SIZE)
        .map(|index| (index % 251) as u8)
        .collect();
    let (_base, _cow_file, cow) = create_test_cow(&base_data);
    let cow = CowIo::new(cow);

    let shutdown = CancellationToken::new();
    let (mut reader, mut writer, server_fd) = setup_dispatch_socket();
    let shutdown_clone = shutdown.clone();
    let write_limit = NonZeroUsize::new(7).expect("write limit must be non-zero");
    let task = tokio::spawn(async move {
        dispatch_with_observers(
            server_fd,
            cow,
            shutdown_clone,
            DispatchReadObserver::none(),
            DispatchWriteLimit::new(write_limit),
        )
        .await
    });

    let small_read = NbdRequest {
        command: Command::Read,
        handle: 10,
        offset: 17,
        length: 23,
    };
    let large_read = NbdRequest {
        command: Command::Read,
        handle: 11,
        offset: 512,
        length: (2 * crate::BLOCK_SIZE + 5) as u32,
    };
    let zero_read = NbdRequest {
        command: Command::Read,
        handle: 12,
        offset: 0,
        length: 0,
    };
    let trailing_read = NbdRequest {
        command: Command::Read,
        handle: 13,
        offset: (3 * crate::BLOCK_SIZE - 31) as u64,
        length: 31,
    };

    for request in [&small_read, &large_read, &zero_read, &trailing_read] {
        must(
            writer.write_all(&serialize_request(request)).await,
            "write read request",
        );
    }

    let small_reply = read_reply(&mut reader).await;
    assert_eq!(small_reply.error, 0);
    assert_eq!(small_reply.handle, small_read.handle);
    let small_payload = read_payload(&mut reader, small_read.length as usize).await;
    assert_eq!(
        small_payload,
        base_data
            [small_read.offset as usize..small_read.offset as usize + small_read.length as usize]
    );

    let large_reply = read_reply(&mut reader).await;
    assert_eq!(large_reply.error, 0);
    assert_eq!(large_reply.handle, large_read.handle);
    let large_payload = read_payload(&mut reader, large_read.length as usize).await;
    assert_eq!(
        large_payload,
        base_data
            [large_read.offset as usize..large_read.offset as usize + large_read.length as usize]
    );

    let zero_reply = read_reply(&mut reader).await;
    assert_eq!(zero_reply.error, 0);
    assert_eq!(zero_reply.handle, zero_read.handle);

    let trailing_reply = read_reply(&mut reader).await;
    assert_eq!(trailing_reply.error, 0);
    assert_eq!(trailing_reply.handle, trailing_read.handle);
    let trailing_payload = read_payload(&mut reader, trailing_read.length as usize).await;
    assert_eq!(
        trailing_payload,
        base_data[trailing_read.offset as usize
            ..trailing_read.offset as usize + trailing_read.length as usize]
    );

    let disconnect = NbdRequest {
        command: Command::Disconnect,
        handle: 14,
        offset: 0,
        length: 0,
    };
    must(
        writer.write_all(&serialize_request(&disconnect)).await,
        "write disconnect request",
    );
    wait_for_dispatch(task).await;
}

#[tokio::test]
async fn dispatch_shutdown_flushes_data() {
    let base_data = vec![0x00; 2 * crate::BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data);
    let cow = CowIo::new(cow);

    let (mut reader, mut writer, task, shutdown) = setup_dispatch(cow.clone()).await;

    let write_req = NbdRequest {
        command: Command::Write,
        handle: 1,
        offset: 0,
        length: crate::BLOCK_SIZE as u32,
    };
    let write_data = vec![0xDD; crate::BLOCK_SIZE];
    let error = send_write_and_recv_reply(&mut reader, &mut writer, &write_req, &write_data).await;
    assert_eq!(error, 0, "write should succeed");

    let status = must(cow.status().await, "read COW status after write");
    assert_eq!(status.buffered_blocks, 1);

    shutdown.cancel();
    wait_for_dispatch(task).await;

    let status = must(cow.status().await, "read COW status after shutdown");
    assert_eq!(status.buffered_blocks, 0, "shutdown should flush buffer");
}

#[tokio::test]
async fn dispatch_shutdown_while_write_payload_pending_exits() {
    let base_data = vec![0x00; 2 * crate::BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data);
    let cow = CowIo::new(cow);

    let (_reader, mut writer, task, shutdown, mut read_events) = setup_observed_dispatch(cow).await;

    let write_req = NbdRequest {
        command: Command::Write,
        handle: 1,
        offset: 0,
        length: crate::BLOCK_SIZE as u32,
    };
    must(
        writer.write_all(&serialize_request(&write_req)).await,
        "write request",
    );
    let partial_payload = vec![0xAA; 512];
    must(
        writer.write_all(&partial_payload).await,
        "write partial payload",
    );
    wait_for_read_event(
        &mut read_events,
        DispatchReadEvent {
            kind: DispatchReadEventKind::WritePayload,
            handle: 1,
        },
    )
    .await;

    shutdown.cancel();
    assert_dispatch_exits_after_shutdown(task).await;
}

#[tokio::test]
async fn dispatch_shutdown_while_oversized_write_discard_pending_exits() {
    let base_data = vec![0x00; 2 * crate::BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data);
    let cow = CowIo::new(cow);

    let (_reader, mut writer, task, shutdown, mut read_events) = setup_observed_dispatch(cow).await;

    let write_req = NbdRequest {
        command: Command::Write,
        handle: 1,
        offset: 0,
        length: 33 * 1024 * 1024,
    };
    must(
        writer.write_all(&serialize_request(&write_req)).await,
        "write oversized request",
    );
    let partial_payload = vec![0xAA; 512];
    must(
        writer.write_all(&partial_payload).await,
        "write oversized partial payload",
    );
    wait_for_read_event(
        &mut read_events,
        DispatchReadEvent {
            kind: DispatchReadEventKind::OversizedDiscard,
            handle: 1,
        },
    )
    .await;

    shutdown.cancel();
    assert_dispatch_exits_after_shutdown(task).await;
}

#[tokio::test]
async fn dispatch_shutdown_during_partial_write_flushes_accepted_data() {
    let base_data = vec![0x00; 2 * crate::BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data);
    let cow = CowIo::new(cow);

    let (mut reader, mut writer, task, shutdown, mut read_events) =
        setup_observed_dispatch(cow.clone()).await;

    let accepted_write = NbdRequest {
        command: Command::Write,
        handle: 1,
        offset: 0,
        length: crate::BLOCK_SIZE as u32,
    };
    let accepted_data = vec![0xDD; crate::BLOCK_SIZE];
    let error =
        send_write_and_recv_reply(&mut reader, &mut writer, &accepted_write, &accepted_data).await;
    assert_eq!(error, 0, "accepted write should succeed");
    let status = must(cow.status().await, "read COW status after accepted write");
    assert_eq!(status.buffered_blocks, 1);

    let partial_write = NbdRequest {
        command: Command::Write,
        handle: 2,
        offset: crate::BLOCK_SIZE as u64,
        length: crate::BLOCK_SIZE as u32,
    };
    must(
        writer.write_all(&serialize_request(&partial_write)).await,
        "write partial request",
    );
    let partial_payload = vec![0xEE; 512];
    must(
        writer.write_all(&partial_payload).await,
        "write partial payload",
    );
    wait_for_read_event(
        &mut read_events,
        DispatchReadEvent {
            kind: DispatchReadEventKind::WritePayload,
            handle: 2,
        },
    )
    .await;

    shutdown.cancel();
    assert_dispatch_exits_after_shutdown(task).await;

    let status = must(cow.status().await, "read COW status after shutdown");
    assert_eq!(status.buffered_blocks, 0);
    assert_eq!(status.dirty_blocks, 1);
}
