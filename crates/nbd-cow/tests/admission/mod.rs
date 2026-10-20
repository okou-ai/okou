use std::path::Path;

use super::support::dispatch_client::{
    TestResult, assert_error_code, assert_success, spawn_dispatch, wait_for_dispatch,
};
use nbd_cow::cow::CowLayer;
use nbd_cow::cow_io::{CowIo, CowIoStatus};
use nbd_cow::{BLOCK_SIZE, DEFAULT_FLUSH_THRESHOLD};
use tempfile::NamedTempFile;

const MAX_WRITE_LENGTH: usize = 32 * 1024 * 1024;

fn sparse_base(size: usize) -> TestResult<NamedTempFile> {
    let base = NamedTempFile::new()?;
    base.as_file().set_len(size as u64)?;
    Ok(base)
}

fn full_cow(base: &NamedTempFile, threshold: usize) -> TestResult<CowIo> {
    Ok(CowIo::new(CowLayer::new(
        base.path(),
        Path::new("/dev/full"),
        base.as_file().metadata()?.len(),
        BLOCK_SIZE,
        threshold,
    )?))
}

#[tokio::test]
async fn persistent_flush_failure_rejects_fresh_offsets_and_overwrites() -> TestResult<()> {
    let base = sparse_base(8 * DEFAULT_FLUSH_THRESHOLD)?;
    let cow = full_cow(&base, DEFAULT_FLUSH_THRESHOLD)?;
    let (mut client, task, _shutdown) = spawn_dispatch(cow.clone()).await?;
    let data = vec![0xA5; DEFAULT_FLUSH_THRESHOLD];

    for request in 0..8 {
        let handle = request + 1;
        let offset = request * DEFAULT_FLUSH_THRESHOLD as u64;
        let reply = client.write(handle, offset, &data).await?;
        assert_error_code(&reply, handle, libc::EIO as u32);
        assert_eq!(
            cow.status().await?,
            CowIoStatus {
                dirty_blocks: 0,
                buffered_blocks: DEFAULT_FLUSH_THRESHOLD / BLOCK_SIZE,
                buffer_bytes: DEFAULT_FLUSH_THRESHOLD,
            }
        );
    }

    let reply = client.write(20, 0, &vec![0xB6; BLOCK_SIZE]).await?;
    assert_error_code(&reply, 20, libc::EIO as u32);
    assert_eq!(
        client.read(21, 0, BLOCK_SIZE as u32).await?,
        vec![0xA5; BLOCK_SIZE]
    );
    assert_eq!(
        client
            .read(22, DEFAULT_FLUSH_THRESHOLD as u64, BLOCK_SIZE as u32)
            .await?,
        vec![0; BLOCK_SIZE]
    );

    drop(client);
    wait_for_dispatch(task).await
}

#[tokio::test]
async fn maximum_unaligned_write_has_a_bounded_threshold_overshoot() -> TestResult<()> {
    let budget = DEFAULT_FLUSH_THRESHOLD + MAX_WRITE_LENGTH;
    let base = sparse_base(budget + 2 * BLOCK_SIZE)?;
    let cow = full_cow(&base, DEFAULT_FLUSH_THRESHOLD)?;
    let (mut client, task, _shutdown) = spawn_dispatch(cow.clone()).await?;
    let prefix_len = DEFAULT_FLUSH_THRESHOLD - BLOCK_SIZE;

    let reply = client.write(1, 0, &vec![0xA5; prefix_len]).await?;
    assert_success(&reply, 1);
    // Both partial edges require whole blocks, on top of a near-full buffer.
    let reply = client
        .write(2, prefix_len as u64 + 1, &vec![0xB6; MAX_WRITE_LENGTH])
        .await?;
    assert_error_code(&reply, 2, libc::EIO as u32);
    assert_eq!(
        cow.status().await?,
        CowIoStatus {
            dirty_blocks: 0,
            buffered_blocks: budget / BLOCK_SIZE,
            buffer_bytes: budget,
        }
    );

    let reply = client
        .write(3, budget as u64, &vec![0xC7; BLOCK_SIZE])
        .await?;
    assert_error_code(&reply, 3, libc::EIO as u32);
    assert_eq!(cow.status().await?.buffer_bytes, budget);
    assert_eq!(client.read(4, prefix_len as u64, 2).await?, vec![0, 0xB6]);
    assert_eq!(
        client.read(5, (budget - BLOCK_SIZE) as u64, 2).await?,
        vec![0xB6, 0]
    );
    assert_eq!(
        client.read(6, budget as u64, BLOCK_SIZE as u32).await?,
        vec![0; BLOCK_SIZE]
    );

    drop(client);
    wait_for_dispatch(task).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatch_connections_share_failed_buffer_admission() -> TestResult<()> {
    let threshold = 2 * BLOCK_SIZE;
    let base = sparse_base(17 * BLOCK_SIZE)?;
    let cow = full_cow(&base, threshold)?;
    let (mut first, first_task, _first_shutdown) = spawn_dispatch(cow.clone()).await?;
    let (mut second, second_task, _second_shutdown) = spawn_dispatch(cow.clone()).await?;
    let original = vec![0xA5; BLOCK_SIZE];
    let reply = first.write(1, 0, &original).await?;
    assert_success(&reply, 1);

    let replacement = vec![0xB6; BLOCK_SIZE];
    for request in 0..8 {
        let handle = 10 + request;
        let first_offset = (1 + 2 * request) * BLOCK_SIZE as u64;
        let second_offset = first_offset + BLOCK_SIZE as u64;
        let (first_reply, second_reply) = tokio::join!(
            first.write(handle, first_offset, &replacement),
            second.write(handle, second_offset, &replacement),
        );
        assert_error_code(&first_reply?, handle, libc::EIO as u32);
        assert_error_code(&second_reply?, handle, libc::EIO as u32);
        assert_eq!(cow.status().await?.buffer_bytes, threshold);
    }
    assert_eq!(second.read(30, 0, BLOCK_SIZE as u32).await?, original);
    // Exactly one competing request crosses the threshold and is retained.
    let first_block = first.read(31, BLOCK_SIZE as u64, BLOCK_SIZE as u32).await?;
    let second_block = second
        .read(32, (2 * BLOCK_SIZE) as u64, BLOCK_SIZE as u32)
        .await?;
    let untouched = vec![0; BLOCK_SIZE];
    assert!(
        (first_block == replacement && second_block == untouched)
            || (first_block == untouched && second_block == replacement)
    );
    assert_eq!(
        first
            .read(33, (3 * BLOCK_SIZE) as u64, BLOCK_SIZE as u32)
            .await?,
        untouched
    );

    drop(first);
    drop(second);
    wait_for_dispatch(first_task).await?;
    wait_for_dispatch(second_task).await
}

#[tokio::test]
async fn write_admission_recovers_after_a_transient_flush_failure() -> TestResult<()> {
    let base = sparse_base(4 * BLOCK_SIZE)?;
    let directory = tempfile::tempdir()?;
    let parent = directory.path().join("temporarily-missing");
    let cow_path = parent.join("cow.img");
    let cow = CowIo::new(CowLayer::new(
        base.path(),
        &cow_path,
        (4 * BLOCK_SIZE) as u64,
        BLOCK_SIZE,
        2 * BLOCK_SIZE,
    )?);
    let (mut client, task, _shutdown) = spawn_dispatch(cow.clone()).await?;
    let original = vec![0xA5; 2 * BLOCK_SIZE];

    let reply = client.write(1, 0, &original).await?;
    assert_error_code(&reply, 1, libc::EIO as u32);
    let next = vec![0xB6; BLOCK_SIZE];
    let reply = client.write(2, (2 * BLOCK_SIZE) as u64, &next).await?;
    assert_error_code(&reply, 2, libc::EIO as u32);
    assert_eq!(cow.status().await?.buffer_bytes, 2 * BLOCK_SIZE);
    assert_eq!(client.read(3, 0, (2 * BLOCK_SIZE) as u32).await?, original);
    assert_eq!(
        client
            .read(4, (2 * BLOCK_SIZE) as u64, BLOCK_SIZE as u32)
            .await?,
        vec![0; BLOCK_SIZE]
    );

    std::fs::create_dir(&parent)?;
    let reply = client.write(5, (2 * BLOCK_SIZE) as u64, &next).await?;
    assert_success(&reply, 5);
    assert_eq!(
        cow.status().await?,
        CowIoStatus {
            dirty_blocks: 2,
            buffered_blocks: 1,
            buffer_bytes: BLOCK_SIZE,
        }
    );
    let reply = client.flush(6).await?;
    assert_success(&reply, 6);
    let mut expected = original;
    expected.extend_from_slice(&next);
    assert_eq!(std::fs::read(&cow_path)?, expected);
    assert_eq!(client.read(7, 0, expected.len() as u32).await?, expected);

    client.disconnect(8).await?;
    wait_for_dispatch(task).await
}

#[tokio::test]
async fn partial_request_error_cannot_bypass_write_admission() -> TestResult<()> {
    let base = sparse_base(4 * BLOCK_SIZE)?;
    let directory = tempfile::tempdir()?;
    let parent = directory.path().join("temporarily-missing");
    let cow_path = parent.join("cow.img");
    let cow = CowIo::new(CowLayer::new(
        base.path(),
        &cow_path,
        (4 * BLOCK_SIZE) as u64,
        BLOCK_SIZE,
        2 * BLOCK_SIZE,
    )?);
    let (mut client, task, _shutdown) = spawn_dispatch(cow.clone()).await?;
    let reply = client.write(1, 0, &vec![0xA5; BLOCK_SIZE]).await?;
    assert_success(&reply, 1);

    // The first full block is retained before a partial block read hits EOF.
    base.as_file().set_len((2 * BLOCK_SIZE) as u64)?;
    let reply = client
        .write(2, BLOCK_SIZE as u64, &vec![0xB6; BLOCK_SIZE + 1])
        .await?;
    assert_error_code(&reply, 2, libc::EIO as u32);
    assert_eq!(cow.status().await?.buffer_bytes, 2 * BLOCK_SIZE);

    base.as_file().set_len((4 * BLOCK_SIZE) as u64)?;
    let next = vec![0xC7; BLOCK_SIZE];
    let reply = client.write(3, (2 * BLOCK_SIZE) as u64, &next).await?;
    assert_error_code(&reply, 3, libc::EIO as u32);
    assert_eq!(cow.status().await?.buffer_bytes, 2 * BLOCK_SIZE);
    let mut expected = vec![0xA5; BLOCK_SIZE];
    expected.extend_from_slice(&vec![0xB6; BLOCK_SIZE]);
    assert_eq!(client.read(4, 0, expected.len() as u32).await?, expected);
    assert_eq!(
        client
            .read(5, (2 * BLOCK_SIZE) as u64, BLOCK_SIZE as u32)
            .await?,
        vec![0; BLOCK_SIZE]
    );

    std::fs::create_dir(&parent)?;
    let reply = client.write(6, (2 * BLOCK_SIZE) as u64, &next).await?;
    assert_success(&reply, 6);
    let reply = client.flush(7).await?;
    assert_success(&reply, 7);
    expected.extend_from_slice(&next);
    assert_eq!(std::fs::read(&cow_path)?, expected);
    assert_eq!(client.read(8, 0, expected.len() as u32).await?, expected);

    client.disconnect(9).await?;
    wait_for_dispatch(task).await
}
