mod admission;
mod support;

use std::os::unix::fs::MetadataExt as _;
use std::path::Path;

use nbd_cow::cow::CowLayer;
use nbd_cow::cow_io::CowIo;
use nbd_cow::{BLOCK_SIZE, DEFAULT_FLUSH_THRESHOLD};
use support::dispatch_client::{
    Command, TestResult, assert_error, assert_error_code, assert_success, create_base_file,
    create_cow_with_full_device, create_test_cow, request, request_with_type_flags, spawn_dispatch,
    spawn_dispatch_with_shutdown, wait_for_dispatch,
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

const OVERSIZED_LENGTH: u32 = 33 * 1024 * 1024;

// Keep sibling temporary-file syncs from consuming the bounded dispatch-exit window.
static COW_FILE_PERSISTENCE: Semaphore = Semaphore::const_new(1);

#[tokio::test]
async fn dispatch_read_write_disconnect() -> TestResult<()> {
    let _persistence_permit = COW_FILE_PERSISTENCE.acquire().await?;
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data)?;
    let cow = CowIo::new(cow);

    let (mut client, task, _shutdown) = spawn_dispatch(cow).await?;

    let data = client.read(1, 0, BLOCK_SIZE as u32).await?;
    assert!(data.iter().all(|&byte| byte == 0xAA));

    let write_data = vec![0xBB; BLOCK_SIZE];
    let reply = client.write(2, 0, &write_data).await?;
    assert_success(&reply, 2);

    let data = client.read(3, 0, BLOCK_SIZE as u32).await?;
    assert!(data.iter().all(|&byte| byte == 0xBB));

    client.disconnect(4).await?;
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_flush_persists_to_cow_file() -> TestResult<()> {
    let _persistence_permit = COW_FILE_PERSISTENCE.acquire().await?;
    let base_data = vec![0x00; 2 * BLOCK_SIZE];
    let (_base, cow_file, cow) = create_test_cow(&base_data)?;
    let cow = CowIo::new(cow);

    let (mut client, task, _shutdown) = spawn_dispatch(cow.clone()).await?;

    let write_data = vec![0xCC; BLOCK_SIZE];
    let reply = client.write(1, 0, &write_data).await?;
    assert_success(&reply, 1);

    let reply = client.flush(2).await?;
    assert_success(&reply, 2);

    let status = cow.status().await?;
    assert_eq!(
        status.buffered_blocks, 0,
        "buffer should be empty after flush"
    );
    assert!(
        status.dirty_blocks > 0,
        "should have dirty blocks in COW file"
    );

    let cow_meta = std::fs::metadata(cow_file.path())?;
    assert!(
        cow_meta.blocks() > 0,
        "COW file should have allocated blocks after flush"
    );

    client.disconnect(3).await?;
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_trim_succeeds() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data)?;
    let cow = CowIo::new(cow);

    let (mut client, task, _shutdown) = spawn_dispatch(cow).await?;

    let reply = client.trim(1, 0, BLOCK_SIZE as u32).await?;
    assert_success(&reply, 1);

    client.disconnect(2).await?;
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_masks_request_type_flags_from_command() -> TestResult<()> {
    const REQUEST_TYPE_HIGH_FLAG: u32 = 1 << 16;

    let _persistence_permit = COW_FILE_PERSISTENCE.acquire().await?;
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data)?;
    let cow = CowIo::new(cow);

    let (mut client, task, _shutdown) = spawn_dispatch(cow).await?;

    let write_data = vec![0xBC; BLOCK_SIZE];
    let flagged_write = request_with_type_flags(
        Command::Write,
        1,
        0,
        write_data.len() as u32,
        REQUEST_TYPE_HIGH_FLAG,
    );
    client.send_request(&flagged_write).await?;
    client.write_payload(&write_data).await?;
    let reply = client.read_reply().await?;
    assert_success(&reply, 1);

    let data = client.read(2, 0, BLOCK_SIZE as u32).await?;
    assert_eq!(data, write_data);

    client.disconnect(3).await?;
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_oversized_read_returns_error() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data)?;
    let cow = CowIo::new(cow);

    let (mut client, task, _shutdown) = spawn_dispatch(cow).await?;

    let oversized_read = request(Command::Read, 1, 0, OVERSIZED_LENGTH);
    client.send_request(&oversized_read).await?;
    let reply = client.read_reply().await?;
    assert_error(&reply, 1);

    let data = client.read(2, 0, BLOCK_SIZE as u32).await?;
    assert!(data.iter().all(|&byte| byte == 0xAA));

    client.disconnect(3).await?;
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_oversized_write_discards_and_returns_error() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data)?;
    let cow = CowIo::new(cow);

    let (mut client, task, _shutdown) = spawn_dispatch(cow).await?;

    let oversized_write = request(Command::Write, 1, 0, OVERSIZED_LENGTH);
    client.send_request(&oversized_write).await?;
    client
        .write_repeated_payload(0xFF, OVERSIZED_LENGTH as usize, 64 * 1024)
        .await?;

    let reply = client.read_reply().await?;
    assert_error(&reply, 1);

    let data = client.read(2, 0, BLOCK_SIZE as u32).await?;
    assert!(data.iter().all(|&byte| byte == 0xAA));

    client.disconnect(3).await?;
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_out_of_bounds_read_returns_error() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data)?;
    let cow = CowIo::new(cow);

    let (mut client, task, _shutdown) = spawn_dispatch(cow).await?;

    let oob_read = request(Command::Read, 1, base_data.len() as u64, BLOCK_SIZE as u32);
    client.send_request(&oob_read).await?;
    let reply = client.read_reply().await?;
    assert_error(&reply, 1);

    let data = client.read(2, 0, BLOCK_SIZE as u32).await?;
    assert!(data.iter().all(|&byte| byte == 0xAA));

    client.disconnect(3).await?;
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_out_of_bounds_write_returns_error() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data)?;
    let cow = CowIo::new(cow);

    let (mut client, task, _shutdown) = spawn_dispatch(cow).await?;

    let write_data = vec![0xFF; BLOCK_SIZE];
    let reply = client.write(1, base_data.len() as u64, &write_data).await?;
    assert_error(&reply, 1);

    let data = client.read(2, 0, BLOCK_SIZE as u32).await?;
    assert!(data.iter().all(|&byte| byte == 0xAA));

    client.disconnect(3).await?;
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_write_flush_failure_returns_error() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let base = create_base_file(&base_data)?;
    let cow = CowIo::new(create_cow_with_full_device(&base, BLOCK_SIZE)?);

    let (mut client, task, _shutdown) = spawn_dispatch(cow).await?;

    let write_data = vec![0xBB; BLOCK_SIZE];
    let reply = client.write(1, 0, &write_data).await?;
    assert_error_code(&reply, 1, libc::EIO as u32);

    drop(client);
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_flush_buffered_write_failure_returns_error() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let base = create_base_file(&base_data)?;
    let cow = CowIo::new(create_cow_with_full_device(&base, 4 * 1024 * 1024)?);

    let (mut client, task, _shutdown) = spawn_dispatch(cow.clone()).await?;

    let write_data = vec![0xBB; BLOCK_SIZE];
    let reply = client.write(1, 0, &write_data).await?;
    assert_success(&reply, 1);

    let reply = client.flush(2).await?;
    assert_error_code(&reply, 2, libc::EIO as u32);

    let status = cow.status().await?;
    assert_eq!(status.buffered_blocks, 1);
    assert_eq!(status.dirty_blocks, 0);
    assert_eq!(client.read(3, 0, BLOCK_SIZE as u32).await?, write_data);

    drop(client);
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_flush_data_file_fsync_failure_returns_error() -> TestResult<()> {
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let base = create_base_file(&base_data)?;
    // /dev/null accepts positioned writes but rejects fsync with EINVAL.
    // Unlike /dev/full, it lets FLUSH reach the data-file sync after draining.
    let cow = CowIo::new(CowLayer::new(
        base.path(),
        Path::new("/dev/null"),
        base_data.len() as u64,
        BLOCK_SIZE,
        DEFAULT_FLUSH_THRESHOLD,
    )?);

    let (mut client, task, _shutdown) = spawn_dispatch(cow.clone()).await?;

    let reply = client.write(1, 0, &vec![0xBB; BLOCK_SIZE]).await?;
    assert_success(&reply, 1);
    let status = cow.status().await?;
    assert_eq!(status.buffered_blocks, 1);
    assert_eq!(status.dirty_blocks, 0);

    let reply = client.flush(2).await?;
    assert_error_code(&reply, 2, libc::EIO as u32);
    let status = cow.status().await?;
    assert_eq!(status.buffered_blocks, 0);
    assert_eq!(status.dirty_blocks, 1);

    // The sink cannot preserve written bytes; untouched blocks still use base.
    let data = client.read(3, BLOCK_SIZE as u64, BLOCK_SIZE as u32).await?;
    assert_eq!(data, vec![0xAA; BLOCK_SIZE]);

    // An empty write buffer must not make a later FLUSH acknowledge success.
    let reply = client.flush(4).await?;
    assert_error_code(&reply, 4, libc::EIO as u32);

    // EOF avoids DISCONNECT's additional, permanently failing shutdown sync.
    drop(client);
    wait_for_dispatch(task).await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dispatch_concurrent_read_write() -> TestResult<()> {
    let _persistence_permit = COW_FILE_PERSISTENCE.acquire().await?;
    let base_data = vec![0xAA; 2 * BLOCK_SIZE];
    let (_base, _cow_file, cow) = create_test_cow(&base_data)?;
    let cow = CowIo::new(cow);
    let shutdown = CancellationToken::new();

    let (mut client0, task0) = spawn_dispatch_with_shutdown(cow.clone(), shutdown.clone()).await?;
    let (mut client1, task1) = spawn_dispatch_with_shutdown(cow, shutdown.clone()).await?;

    let first_write = vec![0xBB; BLOCK_SIZE];
    let reply = client0.write(10, 0, &first_write).await?;
    assert_success(&reply, 10);

    let data = client1.read(20, 0, BLOCK_SIZE as u32).await?;
    assert!(
        data.iter().all(|&byte| byte == 0xBB),
        "connection 1 should read data written by connection 0"
    );

    let second_write = vec![0xCC; BLOCK_SIZE];
    let (write_reply, read_data) = tokio::join!(
        client1.write(21, BLOCK_SIZE as u64, &second_write),
        client0.read(11, BLOCK_SIZE as u64, BLOCK_SIZE as u32)
    );

    let write_reply = write_reply?;
    let read_data = read_data?;
    assert_success(&write_reply, 21);
    let byte = read_data[0];
    assert!(
        byte == 0xAA || byte == 0xCC,
        "data should be base (0xAA) or written (0xCC), got {byte:#x}"
    );
    assert!(
        read_data.iter().all(|&candidate| candidate == byte),
        "all bytes in block should be consistent"
    );

    shutdown.cancel();
    wait_for_dispatch(task0).await?;
    wait_for_dispatch(task1).await?;
    Ok(())
}
